/**
 * Google Ads MCP — entrypoint.
 * - Sem PORT: modo stdio (local, ex: Cursor spawna o processo).
 * - Com PORT: modo HTTP/SSE (Railway ou outro host remoto).
 */

import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fillFromProjectEnv } from "./project-env.js";

// Carrega .env: primeiro cwd (raiz ao rodar do projeto), depois pasta acima de dist/
const rootByCwd = join(process.cwd(), ".env");
const rootByDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
// quiet: true — em modo stdio qualquer log em stdout corrompe o protocolo JSON-RPC.
dotenv.config({ path: rootByCwd, quiet: true });
/* O .env do projeto sempre completa o que faltar (sem sobrescrever). Condicioná-lo a uma
   variável que o cliente MCP costuma definir (GOOGLE_ADS_LOGIN_CUSTOMER_ID) fazia
   READ_ONLY, DRY_RUN e ALLOWED_CUSTOMER_IDS postos lá sumirem sem aviso. */
if (resolve(rootByDir) !== resolve(rootByCwd) && existsSync(rootByDir)) {
  fillFromProjectEnv(readFileSync(rootByDir), process.env);
}

import type { IncomingMessage, ServerResponse } from "node:http";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { GoogleAdsClient } from "./google-ads-client.js";
import { createMcpServer } from "./server.js";
import { parseToolGroups } from "./tool-groups.js";
import { parseBoolEnv, parseReadOnlyMode } from "./read-only.js";
import {
  assertHostedReadOnlySecurity,
  parseAllowedCustomerIds,
  parseAllowedHosts,
  resolveGoogleAdsAuth,
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
/* GOOGLE_ADS_DRY_RUN=true faz toda mutação :mutate viajar com validateOnly=true:
   a API valida o payload completo e devolve os mesmos erros de uma gravação
   real, sem alterar a conta. Desligado por padrão. */
const DRY_RUN = parseBoolEnv("GOOGLE_ADS_DRY_RUN", process.env.GOOGLE_ADS_DRY_RUN);
/* GOOGLE_ADS_TOOL_GROUPS=core,targeting-geo,... publica só esses grupos de tools (o catálogo
   completo passa de 300 tools). Ausente ou "all" = todas. Grupo desconhecido derruba o boot. */
const TOOL_GROUPS = parseToolGroups(process.env.GOOGLE_ADS_TOOL_GROUPS);
const ALLOWED_HOSTS = parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS);

assertHostedReadOnlySecurity({
  port: PORT,
  readOnly: READ_ONLY,
  apiKey: MCP_API_KEY,
  allowedHosts: ALLOWED_HOSTS,
  allowedCustomerIds: ALLOWED_CUSTOMER_IDS,
});

// O run-http.mjs repassa o token aqui só quando o .env o define. O servidor não o
// exige (a API ignora o developer token desde 09/09/2026).
const g = globalThis as unknown as { __GOOGLE_ADS_DEVELOPER_TOKEN?: string };
const tokenFromRunner = typeof g.__GOOGLE_ADS_DEVELOPER_TOKEN === "string" ? g.__GOOGLE_ADS_DEVELOPER_TOKEN : null;
if (tokenFromRunner && !process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = tokenFromRunner;
}

/* Credenciais: OAuth de usuário (GOOGLE_ADS_CREDENTIALS_PATH/JSON) ou service
   account (GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH/JSON) — exatamente uma. O
   developer token é opcional. Regras em resolveGoogleAdsAuth (hosted-config). */
function getClient(): GoogleAdsClient {
  return new GoogleAdsClient({
    ...resolveGoogleAdsAuth(process.env),
    readOnly: READ_ONLY,
    dryRun: DRY_RUN,
  });
}

function serverOpts() {
  return {
    getClient,
    allowedCustomerIds: ALLOWED_CUSTOMER_IDS,
    readOnly: READ_ONLY,
    hosted: PORT > 0,
    toolGroups: TOOL_GROUPS,
  };
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

/* Limite do corpo JSON do POST /mcp. O padrão do express.json (100 KB, o que o
   createMcpExpressApp do SDK usa) recusava com HTML 413 as chamadas que as tools anunciam:
   upload de vídeo em base64 (até 20 MB), 2.000 linhas de conversão, 10.000 operações. */
const MCP_MAX_BODY = process.env.MCP_MAX_BODY?.trim() || "32mb";

async function runHttp(): Promise<void> {
  // Mesmo arranjo do createMcpExpressApp (host 0.0.0.0), mas com o parser JSON só no /mcp,
  // depois da checagem da chave: corpo grande de quem não autenticou nem chega a ser lido.
  const app = express();
  if (ALLOWED_HOSTS.length > 0) {
    app.use(hostHeaderValidation(ALLOWED_HOSTS));
  } else {
    console.warn(
      "Warning: Server is binding to 0.0.0.0 without DNS rebinding protection. " +
        "Consider using the allowedHosts option to restrict allowed hosts, or use authentication to protect your server."
    );
  }
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (checkAuth(req, res)) next();
  };
  const parseJson = express.json({ limit: MCP_MAX_BODY });
  // Erro do parser (corpo acima do limite, JSON inválido) volta como JSON-RPC, não como página HTML.
  const jsonRpcBodyError = (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const status = (err as { status?: number; type?: string }).status;
    if (!status || res.headersSent) return next(err);
    const tooLarge = (err as { type?: string }).type === "entity.too.large";
    res.status(status).json({
      jsonrpc: "2.0",
      error: {
        code: tooLarge ? -32600 : -32700,
        message: tooLarge
          ? `Requisição acima do limite de ${MCP_MAX_BODY} (MCP_MAX_BODY). Divida a chamada em partes menores.`
          : `Corpo JSON inválido: ${(err as Error).message}`,
      },
      id: null,
    });
  };

  app.get("/health", (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mode: READ_ONLY ? "read-only" : "compatibility" }));
  });

  app.get("/", (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Google Ads MCP running. Use path /mcp for MCP client.");
  });

  app.post("/mcp", requireAuth, parseJson, async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
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

  app.use(jsonRpcBodyError);

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
