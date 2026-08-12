#!/usr/bin/env node

const base = process.argv[2] ?? "http://127.0.0.1:3333";
const apiKey = process.argv[3];
if (!apiKey) throw new Error("usage: smoke-read-only.mjs <base-url> <mcp-api-key>");

const health = await fetch(`${base}/health`);
if (!health.ok) throw new Error(`health failed: HTTP ${health.status}`);
const healthBody = await health.json();
if (healthBody.status !== "ok" || healthBody.mode !== "read-only") {
  throw new Error(`unexpected health identity: ${JSON.stringify(healthBody)}`);
}

const unauthorized = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
if (unauthorized.status !== 401) throw new Error(`unauthorized request returned ${unauthorized.status}`);

const response = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
});
if (!response.ok) throw new Error(`tools/list failed: HTTP ${response.status}`);
const body = await response.text();
const dataLine = body.split("\n").find((line) => line.startsWith("data:"));
if (!dataLine) throw new Error("tools/list response did not contain an SSE data line");
const payload = JSON.parse(dataLine.slice(5));
const names = payload?.result?.tools?.map((tool) => tool.name) ?? [];
if (names.length !== 29) throw new Error(`expected 29 read tools, received ${names.length}`);
for (const forbidden of ["create_campaign", "update_budget", "delete_campaign"]) {
  if (names.includes(forbidden)) throw new Error(`write tool exposed: ${forbidden}`);
}
console.log("Google Ads read-only runtime smoke: PASS (29 tools, auth enforced)");
