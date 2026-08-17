/**
 * Google Ads MCP — entrypoint.
 * - Sem PORT: modo stdio (local, ex: Cursor spawna o processo).
 * - Com PORT: modo HTTP/SSE (Railway ou outro host remoto).
 */

import dotenv from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Carrega .env: primeiro cwd (raiz ao rodar do projeto), depois pasta acima de dist/
const rootByCwd = join(process.cwd(), ".env");
const rootByDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
dotenv.config({ path: rootByCwd });
if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
  dotenv.config({ path: rootByDir });
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { GoogleAdsClient } from "./google-ads-client.js";
import { createMcpServer } from "./server.js";
import { parseReadOnlyMode } from "./read-only.js";
import {
  assertHostedReadOnlySecurity,
  parseAllowedCustomerIds,
  parseAllowedHosts,
  parseGoogleAdsCredentialsJson,
} from "./hosted-config.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 0;
const MCP_API_KEY = process.env.MCP_API_KEY ?? "";
/* Hosted read-only mode requires a real allowlist; stdio/dev keeps the old
   permissive shape so local exploration is unchanged. The strict parse runs
   only where the service is actually exposed. */
const ALLOWED_CUSTOMER_IDS =
  Number(process.env.PORT ?? 0) > 0
    ? parseAllowedCustomerIds(process.env.ALLOWED_CUSTOMER_IDS)
    : (process.env.ALLOWED_CUSTOMER_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .map((id) => id.replace(/-/g, ""));
const READ_ONLY = parseReadOnlyMode(process.env.GOOGLE_ADS_READ_ONLY);
const ALLOWED_HOSTS = parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS);

assertHostedReadOnlySecurity({
  port: PORT,
  readOnly: READ_ONLY,
  apiKey: MCP_API_KEY,
  allowedHosts: ALLOWED_HOSTS,
  allowedCustomerIds: ALLOWED_CUSTOMER_IDS,
});

// Runner run-http.mjs injeta o token aqui quando carrega .env
const g = globalThis as unknown as { __GOOGLE_ADS_DEVELOPER_TOKEN?: string };
const tokenFromRunner = typeof g.__GOOGLE_ADS_DEVELOPER_TOKEN === "string" ? g.__GOOGLE_ADS_DEVELOPER_TOKEN : null;
if (tokenFromRunner) {
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = tokenFromRunner;
}

function getClient(): GoogleAdsClient {
  const credentialsPath = process.env.GOOGLE_ADS_CREDENTIALS_PATH;
  const credentialsJson = process.env.GOOGLE_ADS_CREDENTIALS_JSON;
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? tokenFromRunner;
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;

  if (credentialsPath && credentialsJson) {
    throw new Error("Defina apenas GOOGLE_ADS_CREDENTIALS_PATH ou GOOGLE_ADS_CREDENTIALS_JSON.");
  }
  if (!credentialsPath && !credentialsJson) {
    throw new Error("GOOGLE_ADS_CREDENTIALS_PATH ou GOOGLE_ADS_CREDENTIALS_JSON deve ser definido.");
  }
  if (!developerToken) {
    throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN não definido.");
  }
  if (!loginCustomerId) {
    throw new Error("GOOGLE_ADS_LOGIN_CUSTOMER_ID não definido.");
  }

  // Expand ~ in path
  const resolvedPath = credentialsPath?.replace(/^~/, process.env.HOME ?? "");

  return new GoogleAdsClient({
    ...(credentialsJson
      ? { credentials: parseGoogleAdsCredentialsJson(credentialsJson) }
      : { credentialsPath: resolvedPath }),
    developerToken,
    loginCustomerId,
    readOnly: READ_ONLY,
  });
}

function serverOpts() {
  return { getClient, allowedCustomerIds: ALLOWED_CUSTOMER_IDS, readOnly: READ_ONLY };
}

async function runStdio(): Promise<void> {
  const server = createMcpServer(serverOpts());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!MCP_API_KEY) return true;
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token !== MCP_API_KEY) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized. Provide header: Authorization: Bearer <MCP_API_KEY>" }));
    return false;
  }
  return true;
}

async function runHttp(): Promise<void> {
  const app = createMcpExpressApp({
    host: "0.0.0.0",
    allowedHosts: ALLOWED_HOSTS.length > 0 ? ALLOWED_HOSTS : undefined,
  });

  app.get("/health", (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mode: READ_ONLY ? "read-only" : "compatibility" }));
  });

  app.get("/", (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Google Ads MCP running. Use path /mcp for MCP client.");
  });

  app.post("/mcp", async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
    if (!checkAuth(req, res)) return;
    const server = createMcpServer(serverOpts());
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[google-ads-mcp] Error handling request:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: String(err) },
            id: null,
          })
        );
      }
    } finally {
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    }
  });

  app.get("/mcp", async (req: IncomingMessage, res: ServerResponse) => {
    if (!checkAuth(req, res)) return;
    const server = createMcpServer(serverOpts());
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[google-ads-mcp] Error handling GET:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    } finally {
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    }
  });

  const port = PORT || 3333;
  app.listen(port, "0.0.0.0", () => {
    console.log(`[google-ads-mcp] HTTP MCP listening on 0.0.0.0:${port} (path /mcp)`);
  });
}

async function main(): Promise<void> {
  if (PORT > 0) {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
