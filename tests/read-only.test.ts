import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import {
  assertHostedReadOnlySecurity,
  parseAllowedHosts,
  parseGoogleAdsCredentialsJson,
} from "../src/hosted-config.js";
import {
  GOOGLE_ADS_READ_TOOL_NAMES,
  GOOGLE_ADS_WRITE_TOOL_NAMES,
  createReadOnlyToolServer,
  parseReadOnlyMode,
} from "../src/read-only.js";

function registeredToolNames(): string[] {
  const source = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");
  return [...source.matchAll(/mcp\.registerTool\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

test("all 80 tools are explicitly classified and classifications are disjoint", () => {
  const actual = new Set(registeredToolNames());
  const classified = new Set([...GOOGLE_ADS_READ_TOOL_NAMES, ...GOOGLE_ADS_WRITE_TOOL_NAMES]);
  assert.equal(actual.size, 80);
  assert.equal(GOOGLE_ADS_READ_TOOL_NAMES.size, 29);
  assert.equal(GOOGLE_ADS_WRITE_TOOL_NAMES.size, 51);
  assert.deepEqual([...classified].sort(), [...actual].sort());
  assert.equal(
    [...GOOGLE_ADS_READ_TOOL_NAMES].filter((name) => GOOGLE_ADS_WRITE_TOOL_NAMES.has(name as never)).length,
    0
  );
});

test("read-only registration exposes only classified read tools and blocks unknown future tools", () => {
  const registered: string[] = [];
  const server = {
    registerTool(name: string) {
      registered.push(name);
    },
  };
  const filtered = createReadOnlyToolServer(server, true);
  for (const name of registeredToolNames()) filtered.registerTool(name);
  filtered.registerTool("future_unclassified_mutation");
  assert.deepEqual(registered.sort(), [...GOOGLE_ADS_READ_TOOL_NAMES].sort());
});

test("real MCP tools/list exposes exactly the read-only catalogue", async () => {
  const server = createMcpServer({
    getClient: () => {
      throw new Error("client must not be constructed by tools/list");
    },
    readOnly: true,
  });
  const client = new Client({ name: "read-only-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.listTools();
    assert.deepEqual(
      result.tools.map((tool) => tool.name).sort(),
      [...GOOGLE_ADS_READ_TOOL_NAMES].sort()
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("account discovery does not reveal customers outside ALLOWED_CUSTOMER_IDS", async () => {
  const fakeClient = {
    async listChildAccounts() {
      return [
        { customerClient: { id: "1111111111", descriptiveName: "Allowed customer" } },
        { customerClient: { id: "2222222222", descriptiveName: "Foreign customer" } },
      ];
    },
  } as GoogleAdsClient;
  const server = createMcpServer({
    getClient: () => fakeClient,
    allowedCustomerIds: ["111-111-1111"],
    readOnly: true,
  });
  const client = new Client({ name: "customer-scope-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "list_accounts", arguments: {} });
    const serialized = JSON.stringify(result.content);
    assert.match(serialized, /Allowed customer/);
    assert.doesNotMatch(serialized, /Foreign customer/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("compatibility mode preserves all tool registrations", () => {
  const registered: string[] = [];
  const server = { registerTool: (name: string) => registered.push(name) };
  const unfiltered = createReadOnlyToolServer(server, false);
  for (const name of registeredToolNames()) unfiltered.registerTool(name);
  assert.deepEqual(registered.sort(), registeredToolNames().sort());
});

test("read-only environment parsing is strict", () => {
  assert.equal(parseReadOnlyMode(undefined), false);
  assert.equal(parseReadOnlyMode(""), false);
  assert.equal(parseReadOnlyMode("true"), true);
  assert.equal(parseReadOnlyMode("1"), true);
  assert.equal(parseReadOnlyMode("false"), false);
  assert.equal(parseReadOnlyMode("0"), false);
  assert.throws(() => parseReadOnlyMode("tru"), /must be one of/);
});

test("client blocks generic and batch mutations before network access", async () => {
  const directory = mkdtempSync(join(tmpdir(), "google-ads-read-only-"));
  const credentialsPath = join(directory, "credentials.json");
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      token: "test-token",
      refresh_token: "test-refresh",
      token_uri: "https://example.invalid/token",
      client_id: "test-client",
      client_secret: "test-secret",
      expiry: "2999-01-01T00:00:00.000Z",
    })
  );
  try {
    const client = new GoogleAdsClient({
      credentialsPath,
      developerToken: "test-developer-token",
      loginCustomerId: "1234567890",
      readOnly: true,
    });
    await assert.rejects(() => client.mutate("123", "campaigns", []), /read-only mode/);
    await assert.rejects(() => client.batchMutate("123", []), /read-only mode/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hosted OAuth credentials are validated and can remain in memory", async () => {
  const credentials = parseGoogleAdsCredentialsJson(
    JSON.stringify({
      token: "test-token",
      refresh_token: "test-refresh",
      token_uri: "https://oauth2.googleapis.com/token",
      client_id: "test-client",
      client_secret: "test-secret",
      expiry: "2999-01-01T00:00:00.000Z",
    })
  );
  const client = new GoogleAdsClient({
    credentials,
    developerToken: "test-developer-token",
    loginCustomerId: "1234567890",
    readOnly: true,
  });
  await assert.rejects(() => client.mutate("123", "campaigns", []), /read-only mode/);
  assert.throws(() => parseGoogleAdsCredentialsJson("not-json"), /valid JSON/);
  assert.throws(
    () => parseGoogleAdsCredentialsJson(JSON.stringify({ token: "only-one-field" })),
    /missing required field/
  );
});

test("hosted read-only mode requires MCP auth and allowed hosts", () => {
  assert.deepEqual(
    parseAllowedHosts("google-ads-mcp.railway.internal,localhost,localhost"),
    ["google-ads-mcp.railway.internal", "localhost"]
  );
  assert.throws(() => parseAllowedHosts("localhost:3333"), /without ports/);
  assert.throws(
    () => assertHostedReadOnlySecurity({ port: 3333, readOnly: true, apiKey: "", allowedHosts: ["localhost"] }),
    /MCP_API_KEY/
  );
  assert.throws(
    () => assertHostedReadOnlySecurity({ port: 3333, readOnly: true, apiKey: "test", allowedHosts: [] }),
    /MCP_ALLOWED_HOSTS/
  );
  /* A customer allowlist is now part of the same gate: hosted read-only mode
     with auth and hosts but no allowlist used to be accepted, and that was the
     fail-open case. Covered in depth in tests/allowlist.test.ts. */
  assert.throws(
    () => assertHostedReadOnlySecurity({ port: 3333, readOnly: true, apiKey: "test", allowedHosts: ["localhost"] }),
    /ALLOWED_CUSTOMER_IDS/
  );
  assert.doesNotThrow(() =>
    assertHostedReadOnlySecurity({
      port: 3333,
      readOnly: true,
      apiKey: "test",
      allowedHosts: ["localhost"],
      allowedCustomerIds: ["1234567890"],
    })
  );
});
