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
        "Fetch the Entra SCIM service provider configuration (supported features: patch, filter, pagination, bulk).",
      inputSchema: {},
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
        "List the SCIM resource types Entra supports (User, Group). Pass id to fetch a single type.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe('Resource type identifier (e.g. "User", "Group"). Omit to list all.'),
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
        "List Entra SCIM schemas (core User, core Group, enterprise extension, Entra extensions, CustomSecurityAttributes). Pass id to fetch a single schema.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe(
            'Schema URN (e.g. "urn:ietf:params:scim:schemas:core:2.0:User"). Omit to list all.',
          ),
      },
    },
    wrapTool(async ({ id }: { id?: string }) => {
      const path = id ? `/schemas/${encodeURIComponent(id)}` : "/schemas";
      return client.request({ method: "GET", path });
    }),
  );
}
