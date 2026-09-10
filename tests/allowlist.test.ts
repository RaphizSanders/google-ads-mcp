import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertHostedReadOnlySecurity,
  parseAllowedCustomerIds,
} from "../src/hosted-config.js";
import { GOOGLE_ADS_READ_TOOL_NAMES } from "../src/read-only.js";

/**
 * An empty customer allowlist used to mean "do not filter", on a server whose
 * OAuth credential can reach every customer under the MCC. One client's service
 * misconfigured that way would answer for another client's accounts, so the
 * empty case now stops the service instead of widening it.
 *
 * These tests pin the four states that matter: a good allowlist works, and
 * absent, empty and malformed each refuse.
 */

test("a well-formed allowlist parses and normalises", () => {
  assert.deepEqual(parseAllowedCustomerIds("1234567890"), ["1234567890"]);
  /* Google writes customer ids both ways; storing one form and comparing the
     other would deny silently. */
  assert.deepEqual(parseAllowedCustomerIds("123-456-7890"), ["1234567890"]);
  assert.deepEqual(parseAllowedCustomerIds(" 1234567890 , 9876543210 "), [
    "1234567890",
    "9876543210",
  ]);
  assert.deepEqual(parseAllowedCustomerIds("1234567890,1234567890"), [
    "1234567890",
  ]);
});

test("an absent allowlist is refused, not treated as a wildcard", () => {
  assert.throws(() => parseAllowedCustomerIds(undefined), /not a wildcard/);
});

test("an empty or whitespace allowlist is refused", () => {
  assert.throws(() => parseAllowedCustomerIds(""), /not a wildcard/);
  assert.throws(() => parseAllowedCustomerIds("   "), /not a wildcard/);
  assert.throws(() => parseAllowedCustomerIds(",,"), /not a wildcard/);
});

test("a malformed allowlist is refused rather than partially honoured", () => {
  /* Half an allowlist is worse than none: it looks configured. */
  assert.throws(() => parseAllowedCustomerIds("not-a-customer"), /10-digit/);
  assert.throws(() => parseAllowedCustomerIds("12345"), /10-digit/);
  assert.throws(() => parseAllowedCustomerIds("1234567890,oops"), /10-digit/);
});

test("hosted read-only mode will not start without an allowlist", () => {
  const base = {
    port: 3333,
    readOnly: true,
    apiKey: "k".repeat(32),
    allowedHosts: ["ads.internal"],
  };

  assert.throws(
    () => assertHostedReadOnlySecurity({ ...base, allowedCustomerIds: [] }),
    /ALLOWED_CUSTOMER_IDS is required/,
  );
  assert.doesNotThrow(() =>
    assertHostedReadOnlySecurity({ ...base, allowedCustomerIds: ["1234567890"] }),
  );
});

test("hosted write mode refuses to start without authentication", () => {
  /* The dangerous shape: HTTP + mutating tools + no key. checkAuth lets every
     request through when MCP_API_KEY is empty, so the process must not boot. */
  const exposed = {
    port: 3333,
    readOnly: false,
    apiKey: "",
    allowedHosts: ["google-ads-mcp.railway.internal"],
    allowedCustomerIds: ["1234567890"],
  };
  assert.throws(() => assertHostedReadOnlySecurity(exposed), /MCP_API_KEY is required/);
  assert.throws(
    () => assertHostedReadOnlySecurity({ ...exposed, apiKey: "k".repeat(32), allowedHosts: [] }),
    /MCP_ALLOWED_HOSTS is required/,
  );
  assert.throws(
    () => assertHostedReadOnlySecurity({ ...exposed, apiKey: "k".repeat(32), allowedCustomerIds: [] }),
    /ALLOWED_CUSTOMER_IDS is required/,
  );
  assert.doesNotThrow(() =>
    assertHostedReadOnlySecurity({ ...exposed, apiKey: "k".repeat(32) }),
  );
});

test("stdio mode is left alone, so local use is unchanged", () => {
  /* port 0 means stdio; the hosted gate does not apply there. */
  assert.doesNotThrow(() =>
    assertHostedReadOnlySecurity({
      port: 0,
      readOnly: true,
      apiKey: "",
      allowedHosts: [],
      allowedCustomerIds: [],
    }),
  );
});

test("the pilot's shape still passes", () => {
  /* The pilot runs hosted read-only with a populated allowlist. This change
     must not disturb it, which is the whole reason the gate keys on emptiness
     rather than on anything about the values. */
  assert.doesNotThrow(() =>
    assertHostedReadOnlySecurity({
      port: 3333,
      readOnly: true,
      apiKey: "k".repeat(32),
      allowedHosts: ["google-ads-mcp.railway.internal"],
      allowedCustomerIds: parseAllowedCustomerIds("123-456-7890"),
    }),
  );
});

test("every exposed read tool is account-scoped and discovery is filtered", () => {
  const source = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");
  const starts = [...source.matchAll(/mcp\.registerTool\(\s*\n?\s*"([^"]+)"/g)];
  const slices = new Map<string, string>();
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index];
    slices.set(current[1], source.slice(current.index, starts[index + 1]?.index ?? source.length));
  }
  for (const name of GOOGLE_ADS_READ_TOOL_NAMES) {
    const implementation = slices.get(name);
    assert.ok(implementation, `missing implementation for ${name}`);
    if (name === "list_accounts") {
      assert.match(implementation, /allowedCustomerIdSet\.has/);
    } else {
      assert.match(implementation, /checkCustomerAccess\(/, `${name} lacks account guard`);
    }
  }
});

/**
 * Modo agência/gestor: um serviço hospedado que atende TODO o MCC do login.
 * Vazio continua sendo engano de configuração (derruba o boot); "*" é o
 * operador declarando o escopo. Sem isso, multi-conta hospedado exigia
 * enumerar as dezenas de ids e redeployar a cada conta nova.
 */
test("ALLOWED_CUSTOMER_IDS aceita o curinga explicito e recusa a mistura", () => {
  assert.deepEqual(parseAllowedCustomerIds("*"), ["*"]);
  assert.deepEqual(parseAllowedCustomerIds("  *  "), ["*"]);
  // curinga nao se mistura com ids: escopo ambiguo e pior que os dois extremos
  assert.throws(() => parseAllowedCustomerIds("*,1234567890"), /cannot be mixed/);
  assert.throws(() => parseAllowedCustomerIds("1234567890,*"), /cannot be mixed/);
  // vazio e ausente seguem derrubando o boot, agora apontando o curinga
  assert.throws(() => parseAllowedCustomerIds(undefined), /is not a wildcard/);
  assert.throws(() => parseAllowedCustomerIds(""), /is not a wildcard/);
  assert.throws(() => parseAllowedCustomerIds("   "), /is not a wildcard/);
  // id invalido continua invalido
  assert.throws(() => parseAllowedCustomerIds("12345"), /10-digit/);
});

test("curinga libera qualquer conta; allowlist normal segue negando", async () => {
  const { registerGoogleAdsTools } = await import("../src/tools.js");
  const registered: Array<{ name: string; handler: (...a: never[]) => Promise<unknown> }> = [];
  const fakeMcp = {
    registerTool(name: string, _cfg: unknown, handler: (...a: never[]) => Promise<unknown>) {
      registered.push({ name, handler });
    },
  };
  const contas = [
    { customer_id: "2729175430", name: "Maze" },
    { customer_id: "5505259145", name: "Joie" },
  ];
  const fakeClient = {
    async listAccessibleCustomers() {
      return contas.map((c) => `customers/${c.customer_id}`);
    },
    async search() {
      return contas.map((c) => ({ customerClient: { id: c.customer_id, descriptiveName: c.name, status: "ENABLED" } }));
    },
    async getCustomer(id: string) {
      return { id, descriptiveName: contas.find((c) => c.customer_id === id)?.name };
    },
  };

  const textoDe = (r: unknown): string => {
    const c = (r as { content?: Array<{ text?: string }> }).content ?? [];
    return c.map((x) => x.text ?? "").join("\n");
  };

  // hospedado + curinga: get_account_info nao pode negar conta nenhuma
  registered.length = 0;
  registerGoogleAdsTools(fakeMcp as never, () => fakeClient as never, ["*"], true);
  const infoCuringa = registered.find((r) => r.name === "get_account_info")!;
  const okCuringa = await infoCuringa.handler({ customerId: "5505259145" } as never);
  assert.doesNotMatch(textoDe(okCuringa), /Access denied/, "curinga deveria liberar");

  // hospedado + allowlist de 1 conta: a outra continua negada
  registered.length = 0;
  registerGoogleAdsTools(fakeMcp as never, () => fakeClient as never, ["2729175430"], true);
  const infoEstrito = registered.find((r) => r.name === "get_account_info")!;
  const negado = await infoEstrito.handler({ customerId: "5505259145" } as never);
  assert.match(textoDe(negado), /Access denied/, "fora da allowlist deve negar");
});
