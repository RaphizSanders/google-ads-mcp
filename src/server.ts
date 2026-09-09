import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleAdsClient } from "./google-ads-client.js";
import { registerGoogleAdsPrompts } from "./prompts.js";
import { registerGoogleAdsResources } from "./resources.js";
import { registerGoogleAdsTools } from "./tools.js";
import { createReadOnlyToolServer } from "./read-only.js";

export interface McpServerOptions {
  getClient: () => GoogleAdsClient;
  allowedCustomerIds?: string[];
  readOnly?: boolean;
  /* True when the server is exposed over HTTP (port > 0). Gates the
     fail-closed reading of an empty allowlist, which must not apply to a
     locally spawned stdio process. */
  hosted?: boolean;
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
    createReadOnlyToolServer(server, opts.readOnly ?? false),
    opts.getClient,
    opts.allowedCustomerIds ?? [],
    opts.hosted ?? false
  );
  registerGoogleAdsResources(server);
  registerGoogleAdsPrompts(server);
  return server;
}
