#!/usr/bin/env node

// A lista esperada vem do proprio catalogo classificado em src/read-only.ts,
// lido do fonte (nao do build) para o script rodar tambem no workflow de publish,
// que verifica a imagem publicada sem compilar o projeto.
import { readFileSync } from "node:fs";

const readOnlySource = readFileSync(new URL("../src/read-only.ts", import.meta.url), "utf8");
const readBlock = readOnlySource.match(/GOOGLE_ADS_READ_TOOL_NAMES = new Set\(\[([\s\S]*?)\]/);
if (!readBlock) throw new Error("nao foi possivel ler GOOGLE_ADS_READ_TOOL_NAMES de src/read-only.ts");
const expectedReadTools = new Set([...readBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
if (expectedReadTools.size === 0) throw new Error("catalogo de leitura vazio em src/read-only.ts");

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
