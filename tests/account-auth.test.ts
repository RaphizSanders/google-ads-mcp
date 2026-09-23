/**
 * Lote account-auth: autenticação, configurações da conta, verificação de
 * identidade e metadados de campos GAQL.
 *
 * O que estes testes fixam:
 * - o client real não manda developer-token quando ele não foi configurado, assina
 *   o JWT de service account corretamente e traduz os erros de acesso para PT-BR;
 * - MutateCustomer vai com UMA operação (singular), validateOnly em dry-run;
 * - as tools leem antes de gravar, mostram antes → depois, não gravam no-op, exigem
 *   confirm e recusam entrada inválida antes de qualquer chamada;
 * - toda query passa pelas regras de GAQL da API (tests/gaql-rules.ts) e o
 *   validate_gaql concorda com o validador dos testes;
 * - resources e prompts só citam tools que existem e GAQL válido.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GoogleAdsApiError, GoogleAdsClient, explainApiErrorCodes } from "../src/google-ads-client.js";
import { parseServiceAccountKeyJson, resolveGoogleAdsAuth } from "../src/hosted-config.js";
import { GOOGLE_ADS_READ_TOOL_NAMES, GOOGLE_ADS_WRITE_TOOL_NAMES } from "../src/read-only.js";
import { gaqlReferenceContent, glossaryContent, playbookContent, troubleshootingContent } from "../src/resources.js";
import { registerGoogleAdsPrompts } from "../src/prompts.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { ACCOUNT_SETTINGS_QUERY, LEGACY_ECPC_QUERY, parseGaqlClauses, resetAccountAuthCaches } from "../src/tools/account-auth.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";
import { validateGaql } from "./gaql-validator.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const MCC = "9998887776";

// ── Metadados de campo a partir da fixture real da v25 ─────────────────

const fixture = JSON.parse(readFileSync(new URL("./fixtures/google-ads-v25-fields.json", import.meta.url), "utf8")) as {
  resources: Record<string, { attributed: string[]; segmenting: string[]; segments: string[]; metrics: string[] }>;
  fields: Record<string, string>;
};

function fixtureField(name: string): Row {
  const resource = fixture.resources[name];
  if (resource) {
    return {
      resourceName: `googleAdsFields/${name}`,
      name,
      category: "RESOURCE",
      attributeResources: resource.attributed,
      segments: [...resource.segmenting, ...resource.segments.map((s) => `segments.${s}`)],
      metrics: resource.metrics.map((m) => `metrics.${m}`),
      selectableWith: ["campaign", "segments.date"],
    };
  }
  const flags = fixture.fields[name];
  if (flags === undefined) throw new GoogleAdsApiError("Google Ads API: Requested entity was not found.", [], 404);
  return {
    resourceName: `googleAdsFields/${name}`,
    name,
    category: name.startsWith("segments.") ? "SEGMENT" : name.startsWith("metrics.") ? "METRIC" : "ATTRIBUTE",
    selectable: flags.includes("S"),
    filterable: flags.includes("F"),
    sortable: flags.includes("O"),
    isRepeated: flags.includes("R"),
    dataType: "STRING",
    ...(name === "campaign.status" ? { enumValues: ["UNSPECIFIED", "UNKNOWN", "ENABLED", "PAUSED", "REMOVED"] } : {}),
  };
}

function fixtureSearch(query: string): Row[] {
  const match = /WHERE name LIKE '([a-z0-9_.]*)%'/.exec(query);
  assert.ok(match, `consulta de metadados inesperada: ${query}`);
  assert.doesNotMatch(query, /\bFROM\b/, "consulta ao GoogleAdsFieldService não tem FROM");
  return Object.keys(fixture.fields).filter((n) => n.startsWith(match[1])).map(fixtureField);
}

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  /** customer.* por conta (FROM customer). */
  customers?: Record<string, Row>;
  /** Linhas por recurso do FROM (campaign, conversion_action, label...). */
  rows?: Record<string, Row[]>;
  /** customer_client por MCC consultado. */
  children?: Record<string, Row[]>;
  accessible?: string[];
  identity?: Record<string, Row | Error>;
  searchError?: (cid: string, query: string) => Error | undefined;
  mutateCustomerError?: Error;
  onStart?: (cid: string) => void;
  authMode?: "oauth_user" | "service_account";
  hasDeveloperToken?: boolean;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as Array<{ cid: string; query: string }>,
    childCalls: [] as Array<{ mcc: string; options: Row }>,
    customerMutations: [] as Array<{ cid: string; operation: { update: Row; updateMask: string }; dryRun: boolean }>,
    identityGets: [] as string[],
    identityStarts: [] as string[],
    fieldGets: [] as string[],
    fieldSearches: [] as string[],
  };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    isReadOnly: false,
    apiVersion: "v25",
    authMode: opts.authMode ?? "oauth_user",
    serviceAccountEmail: opts.authMode === "service_account" ? "robo@projeto.iam.gserviceaccount.com" : undefined,
    hasDeveloperToken: opts.hasDeveloperToken ?? false,
    loginCustomer: MCC,
    withDryRun: () => build(true),
    async searchStream(cid: string, query: string): Promise<Row[]> {
      calls.queries.push({ cid, query });
      assertGaqlRules(query);
      const error = opts.searchError?.(cid, query);
      if (error) throw error;
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      if (from === "customer") {
        const customer = opts.customers?.[cid];
        return customer ? [{ customer }] : [];
      }
      return opts.rows?.[from] ?? [];
    },
    async listChildAccounts(mcc: string | undefined, options: Row = {}): Promise<Row[]> {
      const manager = mcc ?? MCC;
      calls.childCalls.push({ mcc: manager, options });
      // Mesmos filtros que o GAQL real aplicaria.
      return (opts.children?.[manager] ?? [])
        .filter((c) => options.includeManagers || c.manager !== true)
        .filter((c) => options.allStatuses || c.status === "ENABLED")
        .filter((c) => options.maxLevel === undefined || Number(c.level ?? 1) <= Number(options.maxLevel))
        .map((c) => ({ customerClient: c }));
    },
    async listAccessibleCustomers(): Promise<string[]> {
      return opts.accessible ?? [MCC, CID];
    },
    async mutateCustomer(cid: string, operation: { update: Row; updateMask: string }): Promise<Row> {
      calls.customerMutations.push({ cid, operation, dryRun });
      if (opts.mutateCustomerError) throw opts.mutateCustomerError;
      return dryRun ? {} : { result: { resourceName: `customers/${cid}` } };
    },
    async getIdentityVerification(cid: string): Promise<Row> {
      calls.identityGets.push(cid);
      const value = opts.identity?.[cid];
      if (value instanceof Error) throw value;
      return value ?? {};
    },
    async startIdentityVerification(cid: string): Promise<Row> {
      if (dryRun) throw new Error("GOOGLE_ADS_DRY_RUN: bloqueado");
      calls.identityStarts.push(cid);
      opts.onStart?.(cid);
      return {};
    },
    async getGoogleAdsField(name: string): Promise<Row> {
      calls.fieldGets.push(name);
      return fixtureField(name);
    },
    async searchGoogleAdsFields(query: string): Promise<Row[]> {
      calls.fieldSearches.push(query);
      return fixtureSearch(query);
    },
  });
  return { client: build(false), calls };
}

function register(client: unknown, allowed: string[] = [], hosted = false) {
  const handlers = new Map<string, Handler>();
  const fakeMcp = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  registerGoogleAdsTools(fakeMcp as never, () => client as never, allowed, hosted);
  return handlers;
}

const call = (client: unknown, tool: string, args: Row, allowed: string[] = [], hosted = false) =>
  register(client, allowed, hosted).get(tool)!(args);

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

function jsonOf(result: Result): Row {
  const body = textOf(result);
  const start = body.search(/[[{]/);
  return JSON.parse(body.slice(start, Math.max(body.lastIndexOf("}"), body.lastIndexOf("]")) + 1)) as Row;
}

const baseCustomer: Row = {
  id: CID,
  descriptiveName: "Loja Exemplo",
  currencyCode: "BRL",
  timeZone: "America/Sao_Paulo",
  status: "ENABLED",
  manager: false,
  autoTaggingEnabled: true,
  trackingUrlTemplate: "{lpurl}?src=ads",
  finalUrlSuffix: "utm_source=google",
  callReportingSetting: { callReportingEnabled: true, callConversionReportingEnabled: true },
  conversionTrackingSetting: {
    conversionTrackingStatus: "CONVERSION_TRACKING_MANAGED_BY_SELF",
    conversionTrackingId: "555",
    acceptedCustomerDataTerms: true,
  },
  optimizationScore: 0.83,
  optimizationScoreWeight: 120.5,
};

// ── Client real: headers, JWT, erros, endpoints ────────────────────────

type FetchCall = { url: string; init: RequestInit };

async function withFetch<T>(responder: (call: FetchCall) => Response | Promise<Response>, run: (calls: FetchCall[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const entry = { url: String(url), init: init ?? {} };
    calls.push(entry);
    return responder(entry);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const userCredentials = {
  token: "access-token",
  refresh_token: "refresh",
  token_uri: "https://oauth2.googleapis.com/token",
  client_id: "client",
  client_secret: "secret",
  expiry: "2999-01-01T00:00:00.000Z",
};

test("client: sem developer token o header não vai; com token, vai", async () => {
  await withFetch(() => json([{ results: [] }]), async (calls) => {
    const semToken = new GoogleAdsClient({ credentials: userCredentials, loginCustomerId: "999-888-7776" });
    await semToken.searchStream(CID, "SELECT customer.id FROM customer LIMIT 1");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal("developer-token" in headers, false, "developer-token não pode ir quando não foi configurado");
    assert.equal(headers["login-customer-id"], MCC);
    assert.equal(semToken.hasDeveloperToken, false);

    const comToken = new GoogleAdsClient({ credentials: userCredentials, developerToken: "legado", loginCustomerId: MCC });
    await comToken.searchStream(CID, "SELECT customer.id FROM customer LIMIT 1");
    assert.equal((calls[1].init.headers as Record<string, string>)["developer-token"], "legado");

    const vazio = new GoogleAdsClient({ credentials: userCredentials, developerToken: "   ", loginCustomerId: MCC });
    await vazio.searchStream(CID, "SELECT customer.id FROM customer LIMIT 1");
    assert.equal("developer-token" in (calls[2].init.headers as Record<string, string>), false);
  });
});

test("client: service account assina JWT RS256 válido e reaproveita o token entre instâncias", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const key = { client_email: "robo@projeto.iam.gserviceaccount.com", private_key: pem, private_key_id: "kid-1" };
  await withFetch(
    (c) => (c.url.includes("oauth2") ? json({ access_token: "sa-token", expires_in: 3600 }) : json([{ results: [] }])),
    async (calls) => {
      const client = new GoogleAdsClient({ serviceAccount: key, loginCustomerId: MCC });
      assert.equal(client.authMode, "service_account");
      await client.searchStream(CID, "SELECT customer.id FROM customer LIMIT 1");
      const tokenCall = calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!;
      const body = new URLSearchParams(String(tokenCall.init.body));
      assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [h, p, sig] = String(body.get("assertion")).split(".");
      const header = JSON.parse(Buffer.from(h, "base64url").toString());
      const claims = JSON.parse(Buffer.from(p, "base64url").toString());
      assert.deepEqual(header, { alg: "RS256", typ: "JWT", kid: "kid-1" });
      assert.equal(claims.iss, key.client_email);
      assert.equal(claims.scope, "https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/datamanager",
        "service account pede também o escopo da Data Manager API — sem ele as tools de lá recebem 403");
      assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
      assert.equal(claims.exp - claims.iat, 3600);
      assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url")), "assinatura inválida");
      const apiCall = calls.find((c) => c.url.includes("googleads.googleapis.com"))!;
      assert.equal((apiCall.init.headers as Record<string, string>).Authorization, "Bearer sa-token");

      // getClient() cria um client por tool: o token não pode ser pedido de novo.
      const again = new GoogleAdsClient({ serviceAccount: key, loginCustomerId: MCC });
      await again.searchStream(CID, "SELECT customer.id FROM customer LIMIT 1");
      assert.equal(calls.filter((c) => c.url.includes("oauth2")).length, 1);
    }
  );
});

test("client: chamadas paralelas renovam o token de usuário uma vez só", async () => {
  await withFetch(
    (c) => (c.url.includes("oauth2") ? json({ access_token: "novo", expires_in: 3600 }) : json([{ results: [] }])),
    async (calls) => {
      const client = new GoogleAdsClient({ credentials: { ...userCredentials, expiry: "2000-01-01T00:00:00Z" }, loginCustomerId: MCC });
      await Promise.all([1, 2, 3].map(() => client.searchStream(CID, "SELECT customer.id FROM customer LIMIT 1")));
      assert.equal(calls.filter((c) => c.url.includes("oauth2")).length, 1);
    }
  );
});

test("client: erros de acesso viram GoogleAdsApiError com códigos e explicação em PT-BR", async () => {
  const apiError = (code: Row) =>
    json(
      [{ error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission", details: [{ errors: [{ errorCode: code, message: "detalhe da API" }] }] } }],
      403
    );
  await withFetch(() => apiError({ authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" }), async () => {
    const client = new GoogleAdsClient({ credentials: userCredentials, loginCustomerId: MCC });
    await assert.rejects(
      () => client.searchStream(CID, "SELECT customer.id FROM customer LIMIT 1"),
      (err: unknown) => {
        assert.ok(err instanceof GoogleAdsApiError);
        assert.deepEqual(err.codes, ["authorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION"]);
        assert.match(err.message, /detalhe da API/);
        assert.match(err.message, /Google Ads API Overview/);
        assert.match(err.message, /console\.cloud\.google\.com\/google\/ads-apis\/overview/);
        return true;
      }
    );
  });
  await withFetch(() => apiError({ authenticationError: "TWO_STEP_VERIFICATION_NOT_ENROLLED" }), async () => {
    const client = new GoogleAdsClient({ credentials: userCredentials, loginCustomerId: MCC });
    await assert.rejects(() => client.searchStream(CID, "SELECT customer.id FROM customer LIMIT 1"), /verificação em duas etapas/);
  });
  assert.deepEqual(explainApiErrorCodes(["queryError.UNRECOGNIZED_FIELD"]), []);
  assert.equal(explainApiErrorCodes(["authorizationError.ACTION_NOT_PERMITTED", "authorizationError.ACTION_NOT_PERMITTED"]).length, 1);
});

test("client: refresh token revogado explica o que fazer", async () => {
  await withFetch(() => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400), async () => {
    const client = new GoogleAdsClient({ credentials: { ...userCredentials, expiry: "2000-01-01T00:00:00Z" }, loginCustomerId: MCC });
    await assert.rejects(() => client.searchStream(CID, "SELECT customer.id FROM customer LIMIT 1"), /gere um novo.*duas etapas/s);
  });
});

test("client: MutateCustomer usa operation no singular, validateOnly em dry-run e respeita read-only", async () => {
  await withFetch(() => json({ result: { resourceName: `customers/${CID}` } }), async (calls) => {
    const client = new GoogleAdsClient({ credentials: userCredentials, loginCustomerId: MCC });
    const operation = { update: { resourceName: `customers/${CID}`, autoTaggingEnabled: true }, updateMask: "auto_tagging_enabled" };
    await client.mutateCustomer("123-456-7890", operation);
    assert.equal(calls[0].url, `https://googleads.googleapis.com/v25/customers/${CID}:mutate`);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { operation });
    await client.withDryRun().mutateCustomer(CID, operation);
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { operation, validateOnly: true });
    const readOnly = new GoogleAdsClient({ credentials: userCredentials, loginCustomerId: MCC, readOnly: true });
    await assert.rejects(() => readOnly.mutateCustomer(CID, operation), /read-only/);
    assert.equal(calls.length, 2);
  });
});

test("client: verificação de identidade (GET) e início (POST, recusado em dry-run)", async () => {
  await withFetch(() => json({}), async (calls) => {
    const client = new GoogleAdsClient({ credentials: userCredentials, loginCustomerId: MCC });
    await client.getIdentityVerification(CID);
    assert.equal(calls[0].url, `https://googleads.googleapis.com/v25/customers/${CID}/getIdentityVerification`);
    assert.equal(calls[0].init.method, "GET");
    await client.startIdentityVerification(CID);
    assert.equal(calls[1].url, `https://googleads.googleapis.com/v25/customers/${CID}:startIdentityVerification`);
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { verificationProgram: "ADVERTISER_IDENTITY_VERIFICATION" });
    await assert.rejects(() => client.withDryRun().startIdentityVerification(CID), /dry-run/);
    assert.equal(calls.length, 2, "dry-run não pode chegar à rede");
  });
});

test("client: GoogleAdsFieldService — search pagina, get recusa nome inválido", async () => {
  let page = 0;
  await withFetch(
    () => json(page++ === 0 ? { results: [{ name: "campaign.id" }], nextPageToken: "p2" } : { results: [{ name: "campaign.name" }] }),
    async (calls) => {
      const client = new GoogleAdsClient({ credentials: userCredentials, loginCustomerId: MCC });
      const rows = await client.searchGoogleAdsFields("SELECT name WHERE name LIKE 'campaign.%'");
      assert.deepEqual(rows.map((r) => r.name), ["campaign.id", "campaign.name"]);
      assert.equal(calls[0].url, "https://googleads.googleapis.com/v25/googleAdsFields:search");
      assert.equal(JSON.parse(String(calls[1].init.body)).pageToken, "p2");
      await client.getGoogleAdsField("campaign.status");
      assert.equal(calls[2].url, "https://googleads.googleapis.com/v25/googleAdsFields/campaign.status");
      await assert.rejects(() => client.getGoogleAdsField("campaign/../x"), /inválido/);
      assert.equal(calls.length, 3);
    }
  );
});

test("client: listChildAccounts mantém o filtro antigo por padrão e abre com opções (GAQL válido)", async () => {
  const bodies: string[] = [];
  await withFetch(
    (c) => {
      bodies.push(JSON.parse(String(c.init.body)).query);
      return json([{ results: [] }]);
    },
    async () => {
      const client = new GoogleAdsClient({ credentials: userCredentials, loginCustomerId: MCC });
      await client.listChildAccounts();
      await client.listChildAccounts("5556667778", { allStatuses: true, includeManagers: true, maxLevel: 1 });
      await client.getCustomer(CID);
      await assert.rejects(() => client.listChildAccounts(undefined, { maxLevel: -1 }), /maxLevel/);
    }
  );
  for (const query of bodies) assertGaqlRules(query);
  assert.match(bodies[0], /customer_client\.manager = false/);
  assert.match(bodies[0], /customer_client\.status = 'ENABLED'/);
  assert.doesNotMatch(bodies[1], /manager = false|status = 'ENABLED'/);
  assert.match(bodies[1], /customer_client\.level <= 1/);
  assert.match(bodies[1], /customer_client\.applied_labels/);
});

// ── Configuração por ambiente ─────────────────────────────────────────

test("env: developer token é opcional; exatamente uma credencial; service account validada", () => {
  const withoutToken = resolveGoogleAdsAuth({ GOOGLE_ADS_CREDENTIALS_PATH: "~/token.json", GOOGLE_ADS_LOGIN_CUSTOMER_ID: MCC, HOME: "/home/x" });
  assert.equal(withoutToken.developerToken, undefined);
  assert.equal(withoutToken.credentialsPath, "/home/x/token.json");
  const withToken = resolveGoogleAdsAuth({ GOOGLE_ADS_CREDENTIALS_PATH: "a.json", GOOGLE_ADS_LOGIN_CUSTOMER_ID: MCC, GOOGLE_ADS_DEVELOPER_TOKEN: "t" });
  assert.equal(withToken.developerToken, "t");
  assert.throws(
    () => resolveGoogleAdsAuth({ GOOGLE_ADS_CREDENTIALS_PATH: "a", GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH: "b", GOOGLE_ADS_LOGIN_CUSTOMER_ID: MCC }),
    /apenas uma credencial/
  );
  assert.throws(() => resolveGoogleAdsAuth({ GOOGLE_ADS_LOGIN_CUSTOMER_ID: MCC }), /Nenhuma credencial/);
  assert.throws(() => resolveGoogleAdsAuth({ GOOGLE_ADS_CREDENTIALS_PATH: "a" }), /LOGIN_CUSTOMER_ID/);

  const saJson = JSON.stringify({ type: "service_account", client_email: "robo@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n" });
  const fromJson = resolveGoogleAdsAuth({ GOOGLE_ADS_SERVICE_ACCOUNT_JSON: saJson, GOOGLE_ADS_LOGIN_CUSTOMER_ID: MCC });
  assert.equal(fromJson.serviceAccount?.client_email, "robo@p.iam.gserviceaccount.com");
  const fromPath = resolveGoogleAdsAuth(
    { GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH: "/k.json", GOOGLE_ADS_LOGIN_CUSTOMER_ID: MCC },
    (path) => {
      assert.equal(path, "/k.json");
      return saJson;
    }
  );
  assert.ok(fromPath.serviceAccount);
  assert.throws(() => parseServiceAccountKeyJson(JSON.stringify({ type: "authorized_user", client_email: "a@b", private_key: "x" })), /service_account/);
  assert.throws(() => parseServiceAccountKeyJson(JSON.stringify({ client_email: "a@b" })), /private_key/);
  assert.throws(() => parseServiceAccountKeyJson("{"), /JSON válido/);
  assert.throws(
    () => parseServiceAccountKeyJson(JSON.stringify({ client_email: "a@b", private_key: "-----BEGIN PRIVATE KEY-----", token_uri: "http://evil" })),
    /https/
  );
  assert.throws(
    () => new GoogleAdsClient({ credentials: userCredentials, serviceAccount: { client_email: "a@b", private_key: "k" }, loginCustomerId: MCC }),
    /OU service account/
  );
});

// ── Catálogo ──────────────────────────────────────────────────────────

test("catálogo: tools novas classificadas (leitura x escrita)", () => {
  for (const name of ["check_api_access", "get_account_settings", "get_identity_verification", "get_gaql_fields", "validate_gaql"]) {
    assert.ok(GOOGLE_ADS_READ_TOOL_NAMES.has(name), `${name} deveria ser leitura`);
  }
  for (const name of ["update_account_settings", "start_identity_verification"]) {
    assert.ok(GOOGLE_ADS_WRITE_TOOL_NAMES.has(name), `${name} deveria ser escrita`);
  }
});

// ── list_accounts / get_account_info / get_account_currency / run_gaql ─

const clients = (list: Row[]) => ({ [MCC]: list });

test("list_accounts: padrão igual ao de antes, mas conta suspensas no cabeçalho", async () => {
  const { client, calls } = fakeClient({
    children: clients([
      { id: MCC, descriptiveName: "MCC", manager: true, status: "ENABLED", level: "0" },
      { id: CID, descriptiveName: "Ativa", manager: false, status: "ENABLED", level: "1" },
      { id: "2222222222", descriptiveName: "Suspensa", manager: false, status: "SUSPENDED", level: "1" },
      { id: "3333333333", descriptiveName: "Cancelada", manager: false, status: "CANCELED", level: "2" },
      { id: "4444444444", descriptiveName: "Sub MCC", manager: true, status: "ENABLED", level: "1" },
    ]),
  });
  const result = await call(client, "list_accounts", {});
  const body = textOf(result);
  const accounts = jsonOf(result) as unknown as Row[];
  assert.deepEqual(accounts.map((a) => a.customer_id), [CID]);
  assert.match(body, /SUSPENDED 1/);
  assert.match(body, /CANCELED 1/);
  assert.match(body, /fora da lista — use includeStatuses/);
  // Um passo com filtro de status no GAQL (como antes) + a contagem sem filtro.
  assert.ok(calls.childCalls.some((c) => !c.options.allStatuses && !c.options.includeManagers));

  const problems = jsonOf(await call(client, "list_accounts", { includeStatuses: ["SUSPENDED", "CANCELED"] })) as unknown as Row[];
  assert.deepEqual(problems.map((a) => a.customer_id).sort(), ["2222222222", "3333333333"]);

  const withManagers = jsonOf(await call(client, "list_accounts", { includeManagers: true })) as unknown as Row[];
  assert.deepEqual(withManagers.map((a) => a.customer_id).sort(), [CID, "4444444444"], "o próprio MCC (level 0) não entra");
});

test("list_accounts: rótulo, ocultas, hierarquia e allowlist hospedada", async () => {
  const labelRn = `customers/${MCC}/labels/77`;
  const { client } = fakeClient({
    children: {
      [MCC]: [
        { id: MCC, manager: true, status: "ENABLED", level: "0" },
        { id: CID, descriptiveName: "A", manager: false, status: "ENABLED", level: "1", appliedLabels: [labelRn] },
        { id: "2222222222", descriptiveName: "B", manager: false, status: "ENABLED", level: "2", hidden: true },
        { id: "4444444444", descriptiveName: "Sub", manager: true, status: "ENABLED", level: "1" },
      ],
      "4444444444": [
        { id: "4444444444", manager: true, status: "ENABLED", level: "0" },
        { id: "2222222222", descriptiveName: "B", manager: false, status: "ENABLED", level: "1", hidden: true },
      ],
    },
    rows: { label: [{ label: { resourceName: labelRn, name: "Cliente VIP" } }] },
  });
  const labeled = jsonOf(await call(client, "list_accounts", { labelId: "77" })) as unknown as Row[];
  assert.deepEqual(labeled.map((a) => a.customer_id), [CID]);
  assert.deepEqual(labeled[0].labels, ["Cliente VIP"]);

  const visible = jsonOf(await call(client, "list_accounts", { includeHidden: false })) as unknown as Row[];
  assert.deepEqual(visible.map((a) => a.customer_id), [CID]);

  const tree = jsonOf(await call(client, "list_accounts", { hierarchy: true })) as unknown as Row[];
  const parents = Object.fromEntries(tree.map((a) => [a.customer_id, a.parent_manager_id]));
  assert.deepEqual(parents, { [CID]: MCC, "2222222222": "4444444444" });

  const hosted = jsonOf(await call(client, "list_accounts", {}, ["2222222222"], true)) as unknown as Row[];
  assert.deepEqual(hosted.map((a) => a.customer_id), ["2222222222"]);
  const hostedBody = textOf(await call(client, "list_accounts", {}, ["2222222222"], true));
  assert.match(hostedBody, /ENABLED 1\./, "a contagem também respeita a allowlist");

  const invalid = await call(client, "list_accounts", { includeStatuses: ["PAUSED"] });
  assert.equal(invalid.isError, true);
  const badLabel = await call(client, "list_accounts", { labelId: "abc" });
  assert.equal(badLabel.isError, true);
});

test("get_account_info explica status; get_account_currency não inventa BRL", async () => {
  const { client } = fakeClient({ customers: { [CID]: { ...baseCustomer, status: "SUSPENDED" } } });
  const handlers = register({
    ...client,
    async getCustomer(cid: string) {
      return cid === CID ? { customer: { id: CID, status: "SUSPENDED", testAccount: true } } : {};
    },
  });
  const info = textOf(await handlers.get("get_account_info")!({ customerId: CID }));
  assert.match(info, /SUSPENSA/);
  assert.match(info, /TESTE/);
  const bad = await handlers.get("get_account_info")!({ customerId: "12a" });
  assert.equal(bad.isError, true);
  const noCurrency = await handlers.get("get_account_currency")!({ customerId: "5555555555" });
  assert.equal(noCurrency.isError, true);
  assert.doesNotMatch(textOf(noCurrency), /^BRL$/);
});

test("run_gaql: recusa não-SELECT antes da API e aponta validate_gaql em erro de query", async () => {
  const { client, calls } = fakeClient({
    searchError: () => new GoogleAdsApiError("Google Ads API: invalid query — Unrecognized field", ["queryError.UNRECOGNIZED_FIELD"], 400),
  });
  const notSelect = await call(client, "run_gaql", { customerId: CID, query: "DELETE FROM campaign" });
  assert.equal(notSelect.isError, true);
  assert.equal(calls.queries.length, 0);
  const bad = await call({ ...client, searchStream: async () => { throw new GoogleAdsApiError("Google Ads API: bad", ["queryError.UNRECOGNIZED_FIELD"], 400); } }, "run_gaql", {
    customerId: CID,
    query: "SELECT campaign.nome FROM campaign",
  });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /validate_gaql/);
});

// ── check_api_access ──────────────────────────────────────────────────

test("check_api_access: tudo certo, developer token ausente é ok", async () => {
  const { client, calls } = fakeClient({
    customers: { [MCC]: { id: MCC, manager: true, status: "ENABLED" }, [CID]: { ...baseCustomer } },
  });
  const result = await call(client, "check_api_access", { customerId: CID });
  const body = textOf(result);
  assert.match(body, /^Acesso OK\./);
  assert.match(body, /não definido \(ok: opcional desde 09\/09\/2026/);
  assert.equal((jsonOf(result).conta as Row).nome, "Loja Exemplo");
  for (const { query } of calls.queries) assertGaqlRules(query);
});

test("check_api_access: projeto Cloud em Test, MCC inacessível e allowlist hospedada", async () => {
  const cloud = new GoogleAdsApiError(
    "Google Ads API: denied\nComo resolver: O projeto do Google Cloud dono do OAuth client só tem acesso Test",
    ["authorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION"],
    403
  );
  const { client } = fakeClient({
    accessible: [CID, "2222222222"],
    customers: { [MCC]: { id: MCC, manager: true } },
    searchError: (cid) => (cid === CID ? cloud : undefined),
    hasDeveloperToken: true,
  });
  const result = await call(client, "check_api_access", { customerId: CID }, [CID], true);
  const body = jsonOf(result);
  assert.match(textOf(result), /problema\(s\) encontrado\(s\)/);
  assert.deepEqual((body.conta as Row).codigos, ["authorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION"]);
  assert.deepEqual((body.contas_acessiveis as Row).ids_liberados, [CID], "hospedado: só ids da allowlist");
  assert.equal("total" in (body.contas_acessiveis as Row), false);
  assert.ok((body.problemas as string[]).some((p) => /acesso direto ao MCC/.test(p)));
  assert.match(String((body.configuracao as Row).developer_token), /pode remover/);

  const denied = await call(client, "check_api_access", { customerId: "5555555555" }, [CID], true);
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /Access denied/);
  // Configuração quebrada (getClient lança): a tool explica em vez de estourar.
  const failing = new Map<string, Handler>();
  registerGoogleAdsTools({ registerTool: (n: string, _c: unknown, h: Handler) => failing.set(n, h) } as never, () => { throw new Error("Nenhuma credencial definida"); }, [], false);
  const configError = await failing.get("check_api_access")!({});
  assert.equal(configError.isError, true);
  assert.match(textOf(configError), /Nenhuma credencial/);
});

test("check_api_access: MCC do login fora da allowlist hospedada não é consultado nem exibido", async () => {
  const { client, calls } = fakeClient({
    customers: { [MCC]: { id: MCC, manager: true, status: "SUSPENDED", testAccount: false }, [CID]: { ...baseCustomer } },
  });
  const result = await call(client, "check_api_access", {}, [CID], true);
  const body = textOf(result);
  assert.deepEqual(calls.queries.map((q) => q.cid), [], "nenhuma consulta ao MCC fora da allowlist");
  assert.doesNotMatch(body, new RegExp(MCC), "o ID do MCC não aparece para o tenant");
  const parsed = jsonOf(result);
  assert.equal("login_customer_id" in (parsed.configuracao as Row), false);
  assert.equal((parsed.mcc_do_login as Row).verificado, false);
  assert.doesNotMatch(body, /SUSPENDED|"gerente"/);
  assert.equal((parsed.contas_acessiveis as Row).login_customer_id_acessivel, true, "só sim/não");
  assert.match(body, /^Acesso OK\./);

  // Com customerId liberado, a conta é testada — o MCC continua fora.
  const withAccount = await call(client, "check_api_access", { customerId: CID }, [CID], true);
  assert.deepEqual(calls.queries.map((q) => q.cid), [CID]);
  assert.doesNotMatch(textOf(withAccount), new RegExp(MCC));

  // MCC sem acesso direto: a mensagem não revela o ID.
  const noDirect = fakeClient({ accessible: [CID], customers: { [CID]: { ...baseCustomer } } });
  const hidden = await call(noDirect.client, "check_api_access", {}, [CID], true);
  assert.match(textOf(hidden), /acesso direto ao MCC do login/);
  assert.doesNotMatch(textOf(hidden), new RegExp(MCC));
});

test("check_api_access: MCC do login liberado com status diferente de ENABLED vira problema", async () => {
  for (const [allowed, hosted] of [[["*"], true], [[], false]] as Array<[string[], boolean]>) {
    const { client, calls } = fakeClient({ customers: { [MCC]: { id: MCC, manager: true, status: "SUSPENDED" } } });
    const result = await call(client, "check_api_access", {}, allowed, hosted);
    const body = jsonOf(result);
    assert.deepEqual(calls.queries.map((q) => q.cid), [MCC]);
    assert.doesNotMatch(textOf(result), /^Acesso OK/);
    assert.equal((body.configuracao as Row).login_customer_id, MCC);
    assert.equal((body.mcc_do_login as Row).status, "SUSPENDED");
    assert.ok((body.problemas as string[]).some((p) => /MCC 9998887776 .*status SUSPENDED/.test(p)), JSON.stringify(body.problemas));
  }
  const enabled = fakeClient({ customers: { [MCC]: { id: MCC, manager: true, status: "ENABLED" } } });
  assert.match(textOf(await call(enabled.client, "check_api_access", {}, ["*"], true)), /^Acesso OK\./);
});

// ── get_account_settings ──────────────────────────────────────────────

test("get_account_settings: uma conta — alertas de auto-tagging, conversões, score, template e ECPC", async () => {
  const { client, calls } = fakeClient({
    customers: {
      [CID]: {
        ...baseCustomer,
        autoTaggingEnabled: false,
        trackingUrlTemplate: "https://tracker.example/?x=1",
        conversionTrackingSetting: { conversionTrackingStatus: "NOT_CONVERSION_TRACKED" },
        optimizationScore: 0.42,
      },
    },
    rows: { campaign: [{ campaign: { id: "1", name: "Pesquisa antiga", status: "ENABLED", biddingStrategyType: "MANUAL_CPC" } }] },
  });
  const result = await call(client, "get_account_settings", { customerId: CID });
  const body = jsonOf(result);
  const alerts = (body.alertas as Array<{ severidade: string; alerta: string }>).map((a) => a.alerta).join("\n");
  assert.match(alerts, /Auto-tagging DESLIGADO/);
  assert.match(alerts, /NOT_CONVERSION_TRACKED/);
  assert.match(alerts, /42%/);
  assert.match(alerts, /sem \{lpurl\}/);
  assert.match(alerts, /enhanced_cpc_enabled=true/);
  assert.match(alerts, /Termos de dados do cliente/, "campo bool omitido no JSON = false");
  assert.equal((body.alertas as Array<{ severidade: string }>)[0].severidade, "alta", "ordenado por severidade");
  assert.equal((body.conta as Row).optimization_score_pct, 42);
  assert.ok(calls.queries.some((q) => q.query === ACCOUNT_SETTINGS_QUERY));
  assert.ok(calls.queries.some((q) => q.query === LEGACY_ECPC_QUERY));

  const healthy = fakeClient({ customers: { [CID]: baseCustomer } });
  const ok = await call(healthy.client, "get_account_settings", { customerId: CID, includeCampaignChecks: false });
  assert.match(textOf(ok), /Nenhum alerta/);
  assert.equal(healthy.calls.queries.length, 1);

  const pct = await call(healthy.client, "get_account_settings", { customerId: CID, minOptimizationScore: 90 });
  assert.match(textOf(pct), /83%.*abaixo de 90%/s);

  for (const args of [{}, { customerId: CID, allAccounts: true }, { customerId: "abc" }, { customerId: CID, minOptimizationScore: 500 }]) {
    const { client: c, calls: cc } = fakeClient({ customers: { [CID]: baseCustomer } });
    const res = await call(c, "get_account_settings", args);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.equal(cc.queries.length, 0);
  }
});

test("get_account_settings: allAccounts — escopo, status, erro por conta e score ponderado", async () => {
  const { client, calls } = fakeClient({
    children: clients([
      { id: CID, descriptiveName: "A", manager: false, status: "ENABLED" },
      { id: "2222222222", descriptiveName: "B", manager: false, status: "ENABLED" },
      { id: "3333333333", descriptiveName: "C", manager: false, status: "SUSPENDED" },
      { id: "6666666666", descriptiveName: "Erro", manager: false, status: "ENABLED" },
      { id: "4444444444", descriptiveName: "Sub", manager: true, status: "ENABLED" },
    ]),
    customers: {
      [CID]: { ...baseCustomer, optimizationScore: 0.9, optimizationScoreWeight: 3 },
      "2222222222": { ...baseCustomer, id: "2222222222", autoTaggingEnabled: false, optimizationScore: 0.5, optimizationScoreWeight: 1 },
    },
    searchError: (cid) => (cid === "6666666666" ? new Error("Google Ads API: CUSTOMER_NOT_ENABLED") : undefined),
  });
  const result = await call(client, "get_account_settings", { allAccounts: true });
  const body = jsonOf(result);
  const resumo = body.resumo as Row;
  assert.equal(resumo.contas_no_escopo, 4, "sub-MCC fora");
  assert.deepEqual(resumo.por_status, { ENABLED: 3, SUSPENDED: 1 });
  assert.equal(resumo.auto_tagging_desligado, 1);
  assert.equal(resumo.optimization_score_ponderado_pct, 80, "(90×3 + 50×1) ÷ 4");
  assert.equal(resumo.erros, 1);
  const contas = body.contas as Row[];
  assert.ok(contas.some((c) => c.customer_id === "3333333333" && String(c.alertas).includes("SUSPENSA")));
  assert.equal(calls.queries.filter((q) => q.cid === "3333333333").length, 0, "conta suspensa não é consultada");
  assert.ok(!calls.queries.some((q) => q.query === LEGACY_ECPC_QUERY), "ECPC só com includeCampaignChecks em allAccounts");

  const scoped = jsonOf(await call(client, "get_account_settings", { allAccounts: true }, ["2222222222"], true));
  assert.equal((scoped.resumo as Row).contas_no_escopo, 1);
  assert.deepEqual((scoped.contas as Row[]).map((c) => c.customer_id), ["2222222222"]);

  const capped = jsonOf(await call(client, "get_account_settings", { allAccounts: true, maxAccounts: 1 }));
  assert.equal((capped.resumo as Row).contas_ativas_consultadas, 1);
  assert.equal((capped.resumo as Row).contas_ativas_nao_consultadas, 2);
});

// ── update_account_settings ───────────────────────────────────────────

test("update_account_settings: prévia sem confirm, grava com confirm (updateMask só com folhas alteradas)", async () => {
  const { client, calls } = fakeClient({ customers: { [CID]: baseCustomer } });
  const args = { customerId: CID, autoTaggingEnabled: true, finalUrlSuffix: "utm_source=google&utm_medium=cpc", callConversionReportingEnabled: false };
  const preview = await call(client, "update_account_settings", args);
  assert.equal(preview.isError, true);
  assert.match(textOf(preview), /Prévia — NADA foi gravado/);
  assert.equal(calls.customerMutations.length, 0);

  const done = await call(client, "update_account_settings", { ...args, confirm: true });
  assert.equal(done.isError, undefined);
  assert.equal(calls.customerMutations.length, 1);
  const { operation, dryRun } = calls.customerMutations[0];
  assert.equal(dryRun, false);
  assertUpdateMaskLeaves(operation.updateMask);
  // autoTaggingEnabled já era true: não entra (sem reenviar valor igual).
  assert.equal(operation.updateMask, "final_url_suffix,call_reporting_setting.call_conversion_reporting_enabled");
  assert.deepEqual(operation.update, {
    resourceName: `customers/${CID}`,
    finalUrlSuffix: "utm_source=google&utm_medium=cpc",
    callReportingSetting: { callConversionReportingEnabled: false },
  });
  const alteracoes = (jsonOf(done).alteracoes as Row[]).map((a) => [a.campo, a.antes, a.depois]);
  assert.deepEqual(alteracoes, [
    ["finalUrlSuffix", "utm_source=google", "utm_source=google&utm_medium=cpc"],
    ["callConversionReportingEnabled", true, false],
  ]);
});

test("update_account_settings: no-op, limpeza, lpurl, ação de conversão e validações antes da API", async () => {
  const noop = fakeClient({ customers: { [CID]: baseCustomer } });
  const same = await call(noop.client, "update_account_settings", { customerId: CID, autoTaggingEnabled: true, finalUrlSuffix: "utm_source=google", confirm: true });
  assert.match(textOf(same), /Nada muda/);
  assert.equal(noop.calls.customerMutations.length, 0);

  const clear = fakeClient({ customers: { [CID]: baseCustomer } });
  await call(clear.client, "update_account_settings", { customerId: CID, trackingUrlTemplate: "", confirm: true });
  const op = clear.calls.customerMutations[0].operation;
  assert.equal(op.updateMask, "tracking_url_template");
  assert.equal("trackingUrlTemplate" in op.update, false, "limpar = caminho no mask sem o campo");

  const cases: Array<[Row, RegExp]> = [
    [{ customerId: CID, trackingUrlTemplate: "https://tracker.example/?x=1", confirm: true }, /sem \{lpurl\}/],
    [{ customerId: CID, confirm: true }, /Nada para alterar/],
    [{ customerId: "12-ab", autoTaggingEnabled: true, confirm: true }, /customerId inválido/],
    [{ customerId: CID, callConversionActionId: "x1", confirm: true }, /callConversionActionId inválido/],
    [{ customerId: CID, descriptiveName: "   ", confirm: true }, /não pode ser vazio/],
  ];
  for (const [args, message] of cases) {
    const { client, calls } = fakeClient({ customers: { [CID]: baseCustomer } });
    const result = await call(client, "update_account_settings", args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), message);
    assert.equal(calls.queries.length, 0, `nenhuma chamada: ${JSON.stringify(args)}`);
    assert.equal(calls.customerMutations.length, 0);
  }

  const missingAction = fakeClient({ customers: { [CID]: baseCustomer }, rows: { conversion_action: [] } });
  const notFound = await call(missingAction.client, "update_account_settings", { customerId: CID, callConversionActionId: "321", confirm: true });
  assert.match(textOf(notFound), /não existe/);
  assert.equal(missingAction.calls.customerMutations.length, 0);

  const withAction = fakeClient({
    customers: { [CID]: baseCustomer },
    rows: { conversion_action: [{ conversionAction: { id: "321", name: "Ligações", type: "AD_CALL", status: "ENABLED" } }] },
  });
  await call(withAction.client, "update_account_settings", { customerId: CID, callConversionActionId: "321", confirm: true });
  assert.deepEqual(withAction.calls.customerMutations[0].operation.update.callReportingSetting, {
    callConversionAction: `customers/${CID}/conversionActions/321`,
  });

  const off = fakeClient({ customers: { [CID]: baseCustomer } });
  const warn = await call(off.client, "update_account_settings", { customerId: CID, autoTaggingEnabled: false });
  assert.match(textOf(warn), /quebra a importação de conversões do GA4/);
});

test("update_account_settings: validateOnly valida na API sem confirm e não diz que gravou; erro da API propaga", async () => {
  const { client, calls } = fakeClient({ customers: { [CID]: baseCustomer } });
  const result = await call(client, "update_account_settings", { customerId: CID, descriptiveName: "Loja Nova", validateOnly: true });
  assert.equal(calls.customerMutations.length, 1);
  assert.equal(calls.customerMutations[0].dryRun, true);
  assert.match(textOf(result), /VALIDADO .*nada foi gravado/s);
  assert.doesNotMatch(textOf(result), /atualizada/);

  const failing = fakeClient({
    customers: { [CID]: baseCustomer },
    mutateCustomerError: new GoogleAdsApiError("Google Ads API: denied\nComo resolver: ...", ["authorizationError.ACTION_NOT_PERMITTED"], 403),
  });
  const handlers = register(failing.client);
  await assert.rejects(() => handlers.get("update_account_settings")!({ customerId: CID, descriptiveName: "X", confirm: true }), /ACTION_NOT_PERMITTED|denied/);
});

// ── Verificação de identidade ─────────────────────────────────────────


const verification = (status: string, extra: Row = {}) => ({
  identityVerification: [
    {
      verificationProgram: "ADVERTISER_IDENTITY_VERIFICATION",
      identityVerificationRequirement: {
        verificationStartDeadlineTime: "2026-10-01 00:00:00",
        verificationCompletionDeadlineTime: (extra.deadline as string) ?? "2026-11-01 00:00:00",
      },
      verificationProgress: {
        programStatus: status,
        actionUrl: extra.actionUrl ?? "https://ads.google.com/verify/abc",
        invitationLinkExpirationTime: extra.linkExpiry ?? "2999-01-01 00:00:00",
      },
    },
  ],
});

test("tools de escrita: allowlist hospedada barra outra conta antes de qualquer chamada", async () => {
  resetAccountAuthCaches();
  const OTHER = "5555555555";
  const cases: Array<[string, Row]> = [
    ["update_account_settings", { customerId: OTHER, autoTaggingEnabled: false, confirm: true }],
    ["update_account_settings", { customerId: OTHER, descriptiveName: "Outra", validateOnly: true }],
    ["start_identity_verification", { customerId: OTHER, confirm: true }],
  ];
  for (const [tool, args] of cases) {
    const { client, calls } = fakeClient({
      customers: { [OTHER]: { ...baseCustomer, id: OTHER, autoTaggingEnabled: true } },
      identity: { [OTHER]: verification("FAILURE") },
    });
    const result = await call(client, tool, args, [CID], true);
    assert.equal(result.isError, true, `${tool} ${JSON.stringify(args)}`);
    assert.match(textOf(result), /Access denied/);
    assert.deepEqual(calls.queries, [], `${tool}: nenhuma leitura`);
    assert.deepEqual(calls.customerMutations, [], `${tool}: nenhuma escrita`);
    assert.deepEqual(calls.identityGets, [], `${tool}: nenhuma consulta de verificação`);
    assert.deepEqual(calls.identityStarts, [], `${tool}: nenhuma sessão iniciada`);
  }
  // Controle: a mesma chamada na conta liberada passa do guarda.
  const allowed = fakeClient({ customers: { [CID]: baseCustomer }, identity: { [CID]: verification("FAILURE", { actionUrl: "" }) } });
  await call(allowed.client, "update_account_settings", { customerId: CID, autoTaggingEnabled: false, confirm: true }, [CID], true);
  await call(allowed.client, "start_identity_verification", { customerId: CID, confirm: true }, [CID], true);
  assert.equal(allowed.calls.customerMutations.length, 1);
  assert.equal(allowed.calls.identityStarts.length, 1);
});

test("get_identity_verification: resumo, cache de 6 h e refresh", async () => {
  resetAccountAuthCaches();
  const { client, calls } = fakeClient({ identity: { [CID]: verification("PENDING_USER_ACTION") } });
  const first = await call(client, "get_identity_verification", { customerId: CID });
  assert.match(textOf(first), /PENDING_USER_ACTION — prazo 2026-11-01/);
  assert.equal((jsonOf(first).verificacoes as Row[])[0].action_url, "https://ads.google.com/verify/abc");
  const second = await call(client, "get_identity_verification", { customerId: CID });
  assert.equal(jsonOf(second).do_cache, true);
  assert.equal(calls.identityGets.length, 1, "segunda consulta vem do cache");
  await call(client, "get_identity_verification", { customerId: CID, refresh: true });
  assert.equal(calls.identityGets.length, 2);

  resetAccountAuthCaches();
  const none = fakeClient({ identity: { [CID]: {} } });
  assert.match(textOf(await call(none.client, "get_identity_verification", { customerId: CID })), /não exigida/);
  const invalid = await call(none.client, "get_identity_verification", { customerId: CID, allAccounts: true });
  assert.equal(invalid.isError, true);
});

test("get_identity_verification: allAccounts ordena pendentes pelo prazo e respeita a allowlist", async () => {
  resetAccountAuthCaches();
  const { client } = fakeClient({
    children: clients([
      { id: CID, descriptiveName: "A", status: "ENABLED" },
      { id: "2222222222", descriptiveName: "B", status: "ENABLED" },
      { id: "3333333333", descriptiveName: "C", status: "SUSPENDED" },
      { id: "5555555555", descriptiveName: "Ok", status: "ENABLED" },
      { id: "6666666666", descriptiveName: "Cancelada", status: "CANCELED" },
      { id: "7777777777", descriptiveName: "Erro", status: "ENABLED" },
    ]),
    identity: {
      [CID]: verification("PENDING_USER_ACTION", { deadline: "2026-12-20 00:00:00" }),
      "2222222222": verification("FAILURE", { deadline: "2026-10-05 00:00:00" }),
      "3333333333": verification("PENDING_REVIEW"),
      "5555555555": verification("SUCCESS"),
      "7777777777": new Error("Google Ads API: RESOURCE_EXHAUSTED"),
    },
  });
  const body = jsonOf(await call(client, "get_identity_verification", { allAccounts: true }));
  assert.deepEqual((body.precisam_de_acao as Row[]).map((r) => r.customer_id), ["2222222222", CID]);
  assert.deepEqual((body.em_analise as Row[]).map((r) => r.customer_id), ["3333333333"]);
  const resumo = body.resumo as Row;
  assert.equal(resumo.contas_consultadas, 5, "CANCELED fica fora");
  assert.equal(resumo.concluidas, 1);
  assert.equal(resumo.erros, 1);

  resetAccountAuthCaches();
  const scoped = jsonOf(await call(client, "get_identity_verification", { allAccounts: true }, [CID], true));
  assert.equal((scoped.resumo as Row).contas_consultadas, 1);
});

test("start_identity_verification: só inicia quando precisa, exige confirm e recusa dry-run", async () => {
  resetAccountAuthCaches();
  const scenarios: Array<[Row, RegExp]> = [
    [{}, /não precisa de verificação/],
    [verification("SUCCESS"), /já concluída/],
    [verification("PENDING_REVIEW"), /em análise/],
    [verification("PENDING_USER_ACTION"), /Já existe uma sessão aberta/],
  ];
  for (const [identity, message] of scenarios) {
    const { client, calls } = fakeClient({ identity: { [CID]: identity } });
    const result = await call(client, "start_identity_verification", { customerId: CID, confirm: true });
    assert.match(textOf(result), message);
    assert.equal(calls.identityStarts.length, 0);
  }

  let state: Row = verification("PENDING_USER_ACTION", { linkExpiry: "2020-01-01 00:00:00", actionUrl: "https://old" });
  const { client, calls } = fakeClient({
    identity: new Proxy({}, { get: () => state }) as Record<string, Row>,
    onStart: () => {
      state = verification("PENDING_USER_ACTION", { actionUrl: "https://ads.google.com/verify/new" });
    },
  });
  const noConfirm = await call(client, "start_identity_verification", { customerId: CID });
  assert.equal(noConfirm.isError, true);
  assert.equal(calls.identityStarts.length, 0);

  const dry = await call(client, "start_identity_verification", { customerId: CID, confirm: true, validateOnly: true });
  assert.equal(dry.isError, true);
  assert.match(textOf(dry), /não tem validate_only/);
  assert.equal(calls.identityStarts.length, 0);

  const started = await call(client, "start_identity_verification", { customerId: CID, confirm: true });
  assert.equal(calls.identityStarts.length, 1);
  assert.match(textOf(started), /https:\/\/ads\.google\.com\/verify\/new/);

  const failed = fakeClient({ identity: { [CID]: verification("FAILURE", { actionUrl: "" }) } });
  await call(failed.client, "start_identity_verification", { customerId: CID, confirm: true });
  assert.equal(failed.calls.identityStarts.length, 1, "FAILURE pode reiniciar");
});

// ── Metadados GAQL ────────────────────────────────────────────────────

test("get_gaql_fields: recurso, campos e prefixo — com cache", async () => {
  resetAccountAuthCaches();
  const { client, calls } = fakeClient();
  const campaign = jsonOf(await call(client, "get_gaql_fields", { resource: "campaign_asset" }));
  assert.deepEqual(campaign.recursos_de_segmentacao, ["ad_group", "campaign"]);
  assert.ok((campaign.segmentos as string[]).includes("segments.date"));
  assert.ok((campaign.campos as Row[]).some((f) => f.name === "campaign_asset.field_type"));
  assert.equal(calls.fieldSearches.length, 1);
  await call(client, "get_gaql_fields", { resource: "campaign_asset", include: ["metrics"] });
  assert.equal(calls.fieldGets.length, 1, "metadado do recurso vem do cache");

  const fields = jsonOf(await call(client, "get_gaql_fields", { fields: ["campaign.status"] })) as unknown as Row[];
  assert.deepEqual(fields[0].enum_values, ["UNSPECIFIED", "UNKNOWN", "ENABLED", "PAUSED", "REMOVED"]);
  const missing = jsonOf(await call(client, "get_gaql_fields", { fields: ["campaign.nao_existe", "metrics.clicks"] })) as unknown as Row[];
  assert.match(String(missing[0].erro), /não encontrado/);
  assert.equal(missing[1].name, "metrics.clicks");

  const prefix = await call(client, "get_gaql_fields", { namePrefix: "segments.conversion" });
  assert.match(textOf(prefix), /segments\.conversion_action_category/);

  for (const args of [{}, { resource: "campaign", namePrefix: "x" }, { resource: "Campaign;" }, { namePrefix: "x' OR" }, { resource: "campaign.name" }]) {
    const res = await call(client, "get_gaql_fields", args);
    assert.equal(res.isError, true, JSON.stringify(args));
  }
});

test("validate_gaql concorda com o validador dos testes (metadados reais da v25)", async () => {
  resetAccountAuthCaches();
  const { client } = fakeClient();
  const queries = [
    ACCOUNT_SETTINGS_QUERY,
    LEGACY_ECPC_QUERY,
    "SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS ORDER BY metrics.clicks DESC",
    "SELECT campaign.nome FROM campaign",
    "SELECT campaign.name FROM campaign WHERE segments.device = 'MOBILE'",
    "SELECT campaign_asset.asset FROM campaign_asset WHERE campaign.id = 1",
    "SELECT ad_group.name, metrics.search_term_impression_share FROM keyword_view",
    "SELECT customer.id FROM customer_client",
    "SELECT campaign.name FROM campanha",
    "SELECT customer.conversion_tracking_setting.accepted_customer_data_terms FROM customer WHERE customer.conversion_tracking_setting.accepted_customer_data_terms = true",
  ];
  for (const query of queries) {
    const expected = validateGaql(query);
    const result = await call(client, "validate_gaql", { query });
    assert.equal(Boolean(result.isError), expected.length > 0, `${query}\nesperado: ${expected.join("; ")}\nobtido: ${textOf(result)}`);
  }
  const typo = await call(client, "validate_gaql", { query: "SELECT campaign.nme FROM campaign" });
  assert.match(textOf(typo), /quis dizer campaign\.name/);
  const date = await call(client, "validate_gaql", { query: "SELECT campaign.name, segments.date FROM campaign" });
  assert.match(textOf(date), /período finito/);
  const garbage = await call(client, "validate_gaql", { query: "campaign.name" });
  assert.equal(garbage.isError, true);
  const denied = await call(client, "validate_gaql", { query: "SELECT campaign.id FROM campaign", customerId: "5555555555" }, [CID], true);
  assert.match(textOf(denied), /Access denied/);
});

test("validate_gaql: palavras-chave dentro de literais não abrem cláusula", async () => {
  resetAccountAuthCaches();
  const { client } = fakeClient();
  const limitOffer = "SELECT campaign.id, campaign.name FROM campaign WHERE campaign.name = 'Limit Offer' LIMIT 10";
  assert.deepEqual(validateGaql(limitOffer), []);
  assert.deepEqual(parseGaqlClauses(limitOffer), {
    select: ["campaign.id", "campaign.name"],
    from: "campaign",
    where: ["campaign.name"],
    orderBy: [],
    limit: "10",
  });
  const valid = [
    limitOffer,
    "SELECT campaign.name FROM campaign WHERE campaign.name = 'limit offer'",
    "SELECT campaign.name FROM campaign WHERE campaign.name LIKE '%PARAMETERS%' LIMIT 5",
    `SELECT campaign.name FROM campaign WHERE campaign.name = "Joe's LIMIT x" ORDER BY campaign.name`,
    "SELECT campaign.name FROM campaign WHERE campaign.name = 'it\\'s ORDER BY' LIMIT 3",
    "SELECT campaign.name FROM campaign LIMIT 10 PARAMETERS include_drafts=true",
  ];
  for (const query of valid) {
    const result = await call(client, "validate_gaql", { query });
    assert.equal(result.isError, undefined, `${query}\n${textOf(result)}`);
  }
  assert.equal(parseGaqlClauses(valid[5]).limit, "10");

  // O literal não pode esconder um campo depois dele: o WHERE continua inteiro.
  const hiddenSegment = "SELECT campaign.name FROM campaign WHERE campaign.name = 'Promo ORDER BY Preço' AND segments.device = 'MOBILE'";
  assert.deepEqual(parseGaqlClauses(hiddenSegment).where, ["campaign.name", "segments.device"]);
  const segment = await call(client, "validate_gaql", { query: hiddenSegment });
  assert.equal(segment.isError, true);
  assert.match(textOf(segment), /segments\.device precisa estar no SELECT/);

  const invalid: Array<[string, RegExp]> = [
    ["SELECT campaign.name FROM campaign LIMIT 10 20", /LIMIT 10 20: use um inteiro positivo/],
    ["SELECT campaign.name FROM campaign LIMIT", /LIMIT \(sem valor\)/],
    ["SELECT campaign.name FROM campaign WHERE campaign.name = 'aberto LIMIT 1", /sem aspas de fechamento/],
  ];
  for (const [query, message] of invalid) {
    const result = await call(client, "validate_gaql", { query });
    assert.equal(result.isError, true, query);
    assert.match(textOf(result), message);
  }
});

// ── Resources e prompts: guia do agente ───────────────────────────────

test("resources: conversões, categorias, ECPC e GAQL corretos", () => {
  assert.match(glossaryContent, /include_in_conversions_metric = true/);
  assert.doesNotMatch(glossaryContent, /Inclui TODAS as ações de conversão/);
  assert.doesNotMatch(glossaryContent, /Enhanced CPC opcional/);
  assert.match(glossaryContent, /31\/03\/2025/);
  assert.doesNotMatch(gaqlReferenceContent, /PURCHASE, LEAD,/);
  assert.match(gaqlReferenceContent, /NÃO existe LEAD/);
  assert.doesNotMatch(gaqlReferenceContent, /Conversões \(TODAS as ações\)/);
  assert.match(troubleshootingContent, /CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION/);
  assert.match(troubleshootingContent, /ReachPlanService/);

  const blocks = [...gaqlReferenceContent.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1].trim()).filter((q) => /^SELECT/i.test(q) && !/\bfield1\b/.test(q));
  assert.ok(blocks.length >= 4);
  for (const query of blocks) assertGaqlRules(query);
});

test("resources e prompts só citam tools que existem", () => {
  const names = new Set<string>();
  registerGoogleAdsTools({ registerTool: (n: string) => names.add(n) } as never, () => ({}) as never, [], false);
  const prompts: string[] = [];
  registerGoogleAdsPrompts({
    registerPrompt: (_n: string, _c: unknown, cb: (args: Row) => { messages: Array<{ content: { text: string } }> }) => {
      prompts.push(cb({ customerId: CID, campaignId: "{campaignId}", periodA_since: "a", periodA_until: "b", periodB_since: "c", periodB_until: "d" }).messages[0].content.text);
    },
  } as never);
  const corpus = [playbookContent, troubleshootingContent, gaqlReferenceContent, glossaryContent, ...prompts].join("\n");
  assert.doesNotMatch(corpus, /\bgoogle_(get|list|run|compare)_/, "tools não têm prefixo google_");
  // Nomes de tool (não campos: "campaign.start_date_time" tem ponto antes).
  const cited = [...corpus.matchAll(/(?<![.\w])((?:get|list|run|compare|update|start|validate|check|create|set)_[a-z_]+)\b/g)].map((m) => m[1]);
  // start_date: citado como campo antigo que não existe mais ("os antigos start_date/end_date").
  const unknown = [...new Set(cited)].filter((name) => !names.has(name) && name !== "start_date");
  assert.deepEqual(unknown, []);
  // GAQL citado nos passos dos prompts ("1) run_gaql ...: SELECT ... 2) ...").
  const promptQueries = prompts.flatMap((p) => p.split(/\s\d+\)\s/)).flatMap((step) => {
    const at = step.indexOf("SELECT ");
    return at >= 0 ? [step.slice(at).trim()] : [];
  });
  assert.ok(promptQueries.length >= 2);
  for (const query of promptQueries) assertGaqlRules(query.replace("{campaignId}", "1"));
});
