import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleAdsClient } from "./google-ads-client.js";
import { registerGoogleAdsPrompts } from "./prompts.js";
import { registerGoogleAdsResources } from "./resources.js";
import { registerGoogleAdsTools } from "./tools.js";
import { createReadOnlyToolServer } from "./read-only.js";
import { createToolGroupServer } from "./tool-groups.js";

export interface McpServerOptions {
  getClient: () => GoogleAdsClient;
  allowedCustomerIds?: string[];
  readOnly?: boolean;
  /* True when the server is exposed over HTTP (port > 0). Gates the
     fail-closed reading of an empty allowlist, which must not apply to a
     locally spawned stdio process. */
  hosted?: boolean;
  /* Grupos de tools publicados (GOOGLE_ADS_TOOL_GROUPS); null/ausente = todos. */
  toolGroups?: string[] | null;
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: "google-ads-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );
  registerGoogleAdsTools(
    createToolGroupServer(createReadOnlyToolServer(server, opts.readOnly ?? false), opts.toolGroups ?? null),
    opts.getClient,
    opts.allowedCustomerIds ?? [],
    opts.hosted ?? false
  );
  registerGoogleAdsResources(server);
  registerGoogleAdsPrompts(server);
  return server;
}
