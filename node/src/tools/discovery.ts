import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ScimClient } from "../scim/client.js";
import { wrapTool } from "./util.js";

export function registerDiscoveryTools(server: McpServer, client: ScimClient): void {
  server.registerTool(
    "get_service_provider_config",
    {
      title: "Get SCIM service provider config",
      description:
        "Fetch the Entra SCIM service provider configuration (supported features: patch, filter, pagination, bulk). Answers what the endpoint supports, not what is in the directory. The response is the same for every tenant and changes only when Microsoft changes the API, so fetch it once and reuse it rather than calling it before each operation.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    wrapTool(async () => {
      return client.request({ method: "GET", path: "/serviceproviderconfig" });
    }),
  );

  server.registerTool(
    "list_resource_types",
    {
      title: "List SCIM resource types",
      description:
        "List the SCIM resource types Entra supports (User, Group) and the schemas each one uses. Pass id to fetch a single type. Static per API version — cache it rather than re-fetching.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe('Resource type identifier (e.g. "User", "Group"). Omit to list all.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    wrapTool(async ({ id }: { id?: string }) => {
      const path = id ? `/resourcetypes/${encodeURIComponent(id)}` : "/resourcetypes";
      return client.request({ method: "GET", path });
    }),
  );

  server.registerTool(
    "list_schemas",
    {
      title: "List SCIM schemas",
      description:
        "List Entra SCIM schemas (core User, core Group, enterprise extension, Entra extensions, CustomSecurityAttributes) with each attribute's type, mutability and whether it is returned by default. Use it to check an attribute name or extension URN before building a patch path. Pass id to fetch a single schema. Static per API version — cache it rather than re-fetching. It describes the schema shape only: it does not list the tenant's Custom Security Attribute sets or their values.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe(
            'Schema URN (e.g. "urn:ietf:params:scim:schemas:core:2.0:User"). Omit to list all.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    wrapTool(async ({ id }: { id?: string }) => {
      const path = id ? `/schemas/${encodeURIComponent(id)}` : "/schemas";
      return client.request({ method: "GET", path });
    }),
  );
}
