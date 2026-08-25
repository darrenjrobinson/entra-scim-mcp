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

/**
 * Sent once in the handshake, ahead of any tool call.
 *
 * Everything here is true of the whole server, so repeating it in eighteen tool
 * descriptions would cost more context than it bought — and the two facts that
 * bite hardest (ids rather than names, and membership only being readable in
 * one direction) are the ones a caller cannot discover from the schema of the
 * tool it happens to reach for first.
 */
const BASE_INSTRUCTIONS = `Microsoft Entra ID SCIM 2.0 provisioning. Tools cover user and group lifecycle against a live tenant.

True of every tool, and not visible in any single tool's schema:

- Ids, not names. Anything addressing one object takes an Entra object id (GUID). Resolve a userName with list_users and a group displayName with list_groups first — and note displayName is not unique, so a name can match several groups.
- Membership reads one way only. Neither get_user nor get_group returns group membership at any projection. Use list_groups filtered on members.value eq "<userId>".
- Custom Security Attributes are invisible to ordinary reads. get_user never returns them; get_user_custom_security_attributes does, and requires the attribute set name.
- The filter grammar is far narrower than SCIM's: only "eq" and "ew", only "and", and only on the attributes each tool names. Anything else is rejected before a request is sent.
- Nothing is transactional across tools. A sequence that fails halfway leaves the earlier writes in place; add_group_members reports exactly which ids landed for that reason.
- Every call is a billed Microsoft Graph request. Prefer one filtered list over many gets, project with "attributes", and treat the discovery tools (get_service_provider_config, list_resource_types, list_schemas) as static per API version — fetch once and reuse.`;

const DRY_RUN_INSTRUCTIONS = `

DRY RUN IS ACTIVE (ENTRA_SCIM_DRY_RUN=1). No tool reaches the tenant and no token is acquired. Every call runs full client-side validation and then returns { dryRun: true, request: <the request that would have been sent> }. Nothing is created, changed or deleted, so do not report any change as applied — a result here proves the request was well-formed, nothing more.`;

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

  const server = new McpServer(
    {
      name: options.name ?? "entra-scim-mcp",
      version: options.version ?? PACKAGE_VERSION,
    },
    {
      instructions: client.dryRun
        ? `${BASE_INSTRUCTIONS}${DRY_RUN_INSTRUCTIONS}`
        : BASE_INSTRUCTIONS,
    },
  );

  registerDiscoveryTools(server, client);
  registerUserTools(server, client);
  registerGroupTools(server, client);

  return { server, client };
}
