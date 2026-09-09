#!/usr/bin/env node

// A contagem esperada vem do proprio catalogo classificado (dist/read-only.js),
// entao adicionar uma tool nova nao exige editar um numero magico aqui.
let expectedReadTools;
try {
  ({ GOOGLE_ADS_READ_TOOL_NAMES: expectedReadTools } = await import("../dist/read-only.js"));
} catch {
  throw new Error("dist/read-only.js nao encontrado — rode `npm run build` antes do smoke test");
}

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
const expected = [...expectedReadTools].sort();
const actual = [...names].sort();
if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) {
  const extra = actual.filter((name) => !expectedReadTools.has(name));
  const missing = expected.filter((name) => !names.includes(name));
  throw new Error(
    `read catalogue mismatch: expected ${expected.length} tools, received ${actual.length}` +
      (extra.length ? `; unexpected: ${extra.join(", ")}` : "") +
      (missing.length ? `; missing: ${missing.join(", ")}` : "")
  );
}
for (const forbidden of ["create_campaign", "update_budget", "delete_campaign"]) {
  if (names.includes(forbidden)) throw new Error(`write tool exposed: ${forbidden}`);
}
console.log(`Google Ads read-only runtime smoke: PASS (${actual.length} tools, auth enforced)`);
