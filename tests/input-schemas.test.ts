/**
 * Schemas publicados em tools/list. A mesma instância zod usada duas vezes numa tool vira
 * "$ref" cruzado (#/properties/...) no JSON Schema; cliente ou modelo que não resolve
 * ponteiro JSON enxerga o campo sem tipo nem enum (ex.: startMinute de set_ad_schedule
 * perdia ZERO/FIFTEEN/THIRTY/FORTY_FIVE). Schemas compartilhados são fábricas.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.ts";

test("nenhuma tool publica $ref no inputSchema", async () => {
  const server = createMcpServer({
    getClient: () => { throw new Error("sem client neste teste"); },
    allowedCustomerIds: [],
    readOnly: false,
    hosted: false,
    toolGroups: null,
  } as never);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "schema-test", version: "1.0.0" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 300, `catálogo inesperado: ${tools.length} tools`);
  const offenders: string[] = [];
  for (const tool of tools) {
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "$ref") offenders.push(`${tool.name}${path} -> ${String(value)}`);
        walk(value, `${path}/${key}`);
      }
    };
    walk(tool.inputSchema, "");
  }
  await client.close();
  await server.close();
  assert.deepEqual(offenders, [], "use uma fábrica (() => z.…) para o schema repetido");
});
