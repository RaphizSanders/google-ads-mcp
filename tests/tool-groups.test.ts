/**
 * GOOGLE_ADS_TOOL_GROUPS: publica só os grupos pedidos. O catálogo completo passa de 300
 * tools; alguns clientes MCP carregam todas as definições no contexto do modelo.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { GOOGLE_ADS_READ_TOOL_NAMES } from "../src/read-only.js";
import { TOOL_GROUP_KEYS, parseToolGroups, toolGroupOf } from "../src/tool-groups.js";

async function listTools(opts: { toolGroups?: string[] | null; readOnly?: boolean }): Promise<string[]> {
  const server = createMcpServer({
    getClient: () => {
      throw new Error("tools/list não pode construir o client");
    },
    ...opts,
  });
  const client = new Client({ name: "tool-groups-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((tool) => tool.name);
}

test("parseToolGroups: ausente/all = tudo; lista válida; grupo desconhecido derruba o boot", () => {
  assert.equal(parseToolGroups(undefined), null);
  assert.equal(parseToolGroups(" "), null);
  assert.equal(parseToolGroups("ALL"), null);
  assert.deepEqual(parseToolGroups("core, targeting-geo,core"), ["core", "targeting-geo"]);
  assert.throws(() => parseToolGroups("core,nao-existe"), /grupo\(s\) desconhecido\(s\) nao-existe/);
});

test("sem grupos publica todas; com grupos publica exatamente as tools deles", async () => {
  const all = await listTools({});
  assert.ok(all.length > 300);
  const core = await listTools({ toolGroups: ["core"] });
  assert.ok(core.includes("list_accounts") && core.includes("run_gaql"));
  assert.ok(core.every((name) => toolGroupOf(name) === "core"));
  assert.deepEqual(core.sort(), all.filter((name) => toolGroupOf(name) === "core").sort());

  const twoGroups = await listTools({ toolGroups: ["core", "negatives"] });
  const expected = all.filter((name) => ["core", "negatives"].includes(toolGroupOf(name)));
  assert.deepEqual(twoGroups.sort(), expected.sort());
  assert.ok(twoGroups.length < all.length);
});

test("todo grupo tem ao menos uma tool, e grupos compõem com read-only", async () => {
  const all = await listTools({});
  for (const group of TOOL_GROUP_KEYS) {
    assert.ok(all.some((name) => toolGroupOf(name) === group), `grupo ${group} vazio`);
  }
  const readOnlyCore = await listTools({ toolGroups: ["core"], readOnly: true });
  assert.ok(readOnlyCore.length > 0);
  assert.ok(readOnlyCore.every((name) => GOOGLE_ADS_READ_TOOL_NAMES.has(name) && toolGroupOf(name) === "core"));
});
