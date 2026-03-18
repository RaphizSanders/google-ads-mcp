#!/usr/bin/env node
/**
 * Carrega .env da raiz e inicia o MCP em modo HTTP.
 * Uso: node run-http.mjs (a partir da raiz do projeto)
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  const content = readFileSync(envPath, "utf8").replace(/\r/g, "");
  for (const line of content.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) {
      const key = m[1].trim();
      if (process.env[key] === undefined) process.env[key] = m[2].trim();
    }
  }
}
process.env.PORT = process.env.PORT || "3333";
const token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
if (!token) {
  console.error("[run-http] GOOGLE_ADS_DEVELOPER_TOKEN não encontrado em .env");
  process.exit(1);
}
globalThis.__GOOGLE_ADS_DEVELOPER_TOKEN = token;
await import("./dist/index.js");
