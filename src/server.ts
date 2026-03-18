import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GoogleAdsClient } from "./google-ads-client.js";
import { registerGoogleAdsPrompts } from "./prompts.js";
import { registerGoogleAdsResources } from "./resources.js";
import { registerGoogleAdsTools } from "./tools.js";

export interface McpServerOptions {
  getClient: () => GoogleAdsClient;
  allowedCustomerIds?: string[];
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
  registerGoogleAdsTools(server, opts.getClient, opts.allowedCustomerIds ?? []);
  registerGoogleAdsResources(server);
  registerGoogleAdsPrompts(server);
  return server;
}
