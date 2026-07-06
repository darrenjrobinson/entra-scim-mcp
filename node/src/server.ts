import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ScimClient } from "./scim/client.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerUserTools } from "./tools/users.js";
import { registerGroupTools } from "./tools/groups.js";
import type { AuthConfig } from "./scim/auth.js";

export interface CreateServerOptions {
  auth: AuthConfig;
  client?: ScimClient;
  name?: string;
  version?: string;
}

export function createServer(options: CreateServerOptions): {
  server: McpServer;
  client: ScimClient;
} {
  const client =
    options.client ?? new ScimClient({ credential: options.auth.credential });

  const server = new McpServer({
    name: options.name ?? "entra-scim-mcp",
    version: options.version ?? "0.1.0",
  });

  registerDiscoveryTools(server, client);
  registerUserTools(server, client);
  registerGroupTools(server, client);

  return { server, client };
}
