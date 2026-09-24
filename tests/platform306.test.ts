import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GoogleAdsClient } from "../src/google-ads-client.js";
import { createMcpServer } from "../src/server.js";
import { GOOGLE_ADS_WRITE_TOOL_NAMES } from "../src/read-only.js";

const ALLOWED = "1111111111";
const FOREIGN = "9999999999";
type Schema = { type?: string; enum?: unknown[]; anyOf?: Schema[]; minimum?: number;
  properties?: Record<string, Schema>; required?: string[]; items?: Schema };

// Only generate structurally valid synthetic arguments. Access refusal, never an
// argument-validation error, is the assertion in the protocol tests below.
function sample(schema: Schema): unknown {
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return sample(schema.anyOf[0]);
  if (schema.type === "object") return Object.fromEntries(
    (schema.required ?? []).map((key) => [key, sample(schema.properties![key])]),
  );
  if (schema.type === "array") return [sample(schema.items!)];
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 1;
  if (schema.type === "boolean") return false;
  assert.equal(schema.type, "string", "new schema requires an explicit fixture");
  return "synthetic";
}

async function withClient(fake: object, run: (client: Client) => Promise<void>) {
  const server = createMcpServer({ getClient: () => fake as GoogleAdsClient,
    allowedCustomerIds: [ALLOWED], hosted: true, readOnly: true });
  const client = new Client({ name: "platform306-isolation", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try { await run(client); } finally { await client.close(); await server.close(); }
}

test("#306 every account read refuses a foreign customer through real MCP before provider access", async (t) => {
  let providerCalls = 0;
  const fake = new Proxy({}, { get: () => () => { providerCalls++; throw Error("provider forbidden"); } });
  await withClient(fake, async (client) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 139);
    assert.deepEqual(tools.filter((tool) => !tool.inputSchema.properties?.customerId).map((tool) => tool.name).sort(),
      ["get_mcc_performance_summary", "list_accounts"]);
    for (const tool of tools.filter((tool) => tool.inputSchema.properties?.customerId)) {
      await t.test(tool.name, async () => {
        const args = { ...sample(tool.inputSchema as Schema) as object, customerId: FOREIGN };
        const result = await client.callTool({ name: tool.name, arguments: args });
        assert.match(JSON.stringify(result.content), /Access denied/, tool.name);
        assert.equal(providerCalls, 0, tool.name);
      });
    }
    for (const args of [{ managerCustomerId: FOREIGN }, { customerIds: [ALLOWED, FOREIGN] }]) {
      const result = await client.callTool({ name: "get_mcc_performance_summary", arguments: args });
      assert.match(JSON.stringify(result.content), /Access denied/);
      assert.equal(providerCalls, 0);
    }
  });
});

test("#306 all 206 writes and an unknown future tool are unavailable even by direct tools/call", async () => {
  let calls = 0;
  const fake = new Proxy({}, { get: () => () => { calls++; throw Error("provider forbidden"); } });
  await withClient(fake, async (client) => {
    assert.equal(GOOGLE_ADS_WRITE_TOOL_NAMES.size, 206);
    for (const name of [...GOOGLE_ADS_WRITE_TOOL_NAMES, "future_unclassified_write"]) {
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true, name);
      assert.match(JSON.stringify(result.content), /not found/i, name);
    }
    assert.equal(calls, 0);
  });
});

test("#306 invoice totals/PDF must not expose another customer's consolidated billing", async () => {
  const fake = {
    async customerGet(customer: string) {
      assert.equal(customer, ALLOWED);
      return { invoices: [{ id: "foreign-consolidated-invoice", totalAmountMicros: "987654321000000",
        pdfUrl: "https://example.invalid/private-invoice", accountBudgetSummaries: [
          { customer: `customers/${ALLOWED}`, totalAmountMicros: "1000000" },
          { customer: `customers/${FOREIGN}`, totalAmountMicros: "987654320000000" },
        ] }] };
    },
  };
  await withClient(fake, async (client) => {
    const result = await client.callTool({ name: "list_invoices", arguments: {
      customerId: ALLOWED, year: 2026, month: 8, billingSetupId: "123", granular: true,
    } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /scope|escopo/i);
    assert.doesNotMatch(JSON.stringify(result), /9876543|foreign-consolidated|private-invoice|9999999999/);
  });
});

test("#306 an entirely authorized invoice remains usable; unknown invoice ownership fails closed", async () => {
  for (const summaries of [[{ customer: `customers/${ALLOWED}`, totalAmountMicros: "1000000" }], [], undefined]) {
    const fake = { async customerGet() { return { invoices: [{ id: "authorized-invoice",
      totalAmountMicros: "1000000", accountBudgetSummaries: summaries }] }; } };
    await withClient(fake, async (client) => {
      const result = await client.callTool({ name: "list_invoices", arguments: {
        customerId: ALLOWED, year: 2026, month: 8, billingSetupId: "123",
      } });
      const body = JSON.stringify(result.content);
      if (summaries?.length) {
        assert.notEqual(result.isError, true);
        assert.match(body, /authorized-invoice/);
      } else {
        assert.equal(result.isError, true);
        assert.doesNotMatch(body, /authorized-invoice/);
      }
    });
  }
});
