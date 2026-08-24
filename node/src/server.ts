import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ScimClient } from "./scim/client.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerUserTools } from "./tools/users.js";
import { registerGroupTools } from "./tools/groups.js";
import type { AuthConfig } from "./scim/auth.js";

/**
 * The version this server reports in the MCP handshake.
 *
 * Read from package.json rather than repeated as a literal, so a release can
 * never ship a handshake that disagrees with the published package. The
 * relative path resolves the same from `src/` (vitest) and `dist/` (the built
 * binary), and package.json is present in every npm tarball regardless of the
 * `files` allow-list.
 */
const { version: PACKAGE_VERSION } = createRequire(import.meta.url)(
  "../package.json",
) as { version: string };

export { PACKAGE_VERSION };

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
    version: options.version ?? PACKAGE_VERSION,
  });

  registerDiscoveryTools(server, client);
  registerUserTools(server, client);
  registerGroupTools(server, client);

  return { server, client };
}
