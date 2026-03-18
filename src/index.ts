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

const PORT = process.env.PORT ? Number(process.env.PORT) : 0;
const MCP_API_KEY = process.env.MCP_API_KEY ?? "";
const ALLOWED_CUSTOMER_IDS = process.env.ALLOWED_CUSTOMER_IDS
  ? process.env.ALLOWED_CUSTOMER_IDS.split(",").map((id) => id.trim()).filter(Boolean)
  : [];

// Runner run-http.mjs injeta o token aqui quando carrega .env
const g = globalThis as unknown as { __GOOGLE_ADS_DEVELOPER_TOKEN?: string };
const tokenFromRunner = typeof g.__GOOGLE_ADS_DEVELOPER_TOKEN === "string" ? g.__GOOGLE_ADS_DEVELOPER_TOKEN : null;
if (tokenFromRunner) {
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = tokenFromRunner;
}

function getClient(): GoogleAdsClient {
  const credentialsPath = process.env.GOOGLE_ADS_CREDENTIALS_PATH;
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? tokenFromRunner;
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;

  if (!credentialsPath) {
    throw new Error("GOOGLE_ADS_CREDENTIALS_PATH não definido.");
  }
  if (!developerToken) {
    throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN não definido.");
  }
  if (!loginCustomerId) {
    throw new Error("GOOGLE_ADS_LOGIN_CUSTOMER_ID não definido.");
  }

  // Expand ~ in path
  const resolvedPath = credentialsPath.replace(/^~/, process.env.HOME ?? "");

  return new GoogleAdsClient({
    credentialsPath: resolvedPath,
    developerToken,
    loginCustomerId,
  });
}

function serverOpts() {
  return { getClient, allowedCustomerIds: ALLOWED_CUSTOMER_IDS };
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
    allowedHosts: undefined,
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
