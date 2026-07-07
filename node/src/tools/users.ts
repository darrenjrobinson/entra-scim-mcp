import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ScimClient } from "../scim/client.js";
import { joinAttributes, wrapTool } from "./util.js";
import { buildUserFilter } from "../scim/filter.js";
import { buildCsaPatch, buildUserPatch } from "../scim/patch.js";
import { normalizeListResponse } from "../scim/pagination.js";
import {
  SCHEMA_ENTERPRISE_USER,
  SCHEMA_ENTRA_CSA,
  SCHEMA_ENTRA_USER,
  SCHEMA_PATCH_OP,
  SCHEMA_USER_CORE,
  type ScimListResponse,
  type ScimPatchOperation,
  type ScimUser,
} from "../scim/types.js";

const filterClauseSchema = z.object({
  attr: z.string(),
  op: z.enum(["eq", "ew"]),
  value: z.string(),
});

const patchOpSchema = z.object({
  op: z.enum(["add", "remove", "replace"]),
  path: z.string().optional(),
  value: z.unknown().optional(),
});

const emailSchema = z.object({
  value: z.string(),
  type: z.string().optional(),
  primary: z.boolean().optional(),
});

const phoneSchema = z.object({
  value: z.string(),
  type: z.string().optional(),
  primary: z.boolean().optional(),
});

const addressSchema = z.object({
  type: z.string().optional(),
  streetAddress: z.string().optional(),
  locality: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  formatted: z.string().optional(),
  primary: z.boolean().optional(),
});

export function registerUserTools(server: McpServer, client: ScimClient): void {
  server.registerTool(
    "list_users",
    {
      title: "List users",
      description:
        "List Entra users via SCIM. Filter supports 'eq' on userName/externalId/id/groups.value/mailNickname and 'ew' on userName/mailNickname; only 'and' is supported. Cursor-based pagination.",
      inputSchema: {
        filter: z
          .array(filterClauseSchema)
          .optional()
          .describe(
            "Filter clauses ANDed together. Each clause: { attr, op: 'eq'|'ew', value }.",
          ),
        attributes: z
          .array(z.string())
          .optional()
          .describe("Attributes to include in the response."),
        excludedAttributes: z
          .array(z.string())
          .optional()
          .describe("Attributes to exclude from the response."),
        count: z.number().int().positive().optional().describe("Page size."),
        cursor: z.string().optional().describe("Pagination cursor from prior call."),
      },
    },
    wrapTool(async (args: {
      filter?: { attr: string; op: "eq" | "ew"; value: string }[];
      attributes?: string[];
      excludedAttributes?: string[];
      count?: number;
      cursor?: string;
    }) => {
      const result = await client.request<ScimListResponse<ScimUser>>({
        method: "GET",
        path: "/users",
        query: {
          filter: buildUserFilter(args.filter),
          attributes: joinAttributes(args.attributes),
          excludedAttributes: joinAttributes(args.excludedAttributes),
          count: args.count,
          cursor: args.cursor,
        },
      });
      return normalizeListResponse(result);
    }),
  );

  server.registerTool(
    "get_user",
    {
      title: "Get user by id",
      description: "Fetch a single user by SCIM/Entra object id.",
      inputSchema: {
        id: z.string().min(1),
        attributes: z.array(z.string()).optional(),
        excludedAttributes: z.array(z.string()).optional(),
      },
    },
    wrapTool(async (args: {
      id: string;
      attributes?: string[];
      excludedAttributes?: string[];
    }) => {
      return client.request<ScimUser>({
        method: "GET",
        path: `/users/${encodeURIComponent(args.id)}`,
        query: {
          attributes: joinAttributes(args.attributes),
          excludedAttributes: joinAttributes(args.excludedAttributes),
        },
      });
    }),
  );

  server.registerTool(
    "provision_user",
    {
      title: "Provision user",
      description:
        "Create a user in Entra via SCIM. Enforces the required attribute set: userName, password, displayName, givenName, familyName, mailNickname. active defaults to true.",
      inputSchema: {
        userName: z
          .string()
          .min(1)
          .describe("UPN-style user name (e.g. user@contoso.com)."),
        password: z.string().min(1),
        displayName: z.string().min(1),
        givenName: z.string().min(1),
        familyName: z.string().min(1),
        mailNickname: z.string().min(1),
        active: z.boolean().optional().default(true),
        externalId: z.string().optional(),
        userType: z.string().optional().describe('"Member" or "Guest".'),
        emails: z.array(emailSchema).optional(),
        phoneNumbers: z.array(phoneSchema).optional(),
        addresses: z.array(addressSchema).optional(),
        department: z.string().optional(),
        employeeNumber: z.string().optional(),
        managerId: z
          .string()
          .optional()
          .describe("Entra object id of the user's manager."),
      },
    },
    wrapTool(async (args: {
      userName: string;
      password: string;
      displayName: string;
      givenName: string;
      familyName: string;
      mailNickname: string;
      active?: boolean;
      externalId?: string;
      userType?: string;
      emails?: { value: string; type?: string; primary?: boolean }[];
      phoneNumbers?: { value: string; type?: string; primary?: boolean }[];
      addresses?: {
        type?: string;
        streetAddress?: string;
        locality?: string;
        region?: string;
        postalCode?: string;
        country?: string;
        formatted?: string;
        primary?: boolean;
      }[];
      department?: string;
      employeeNumber?: string;
      managerId?: string;
    }) => {
      const enterprise: Record<string, unknown> = {};
      if (args.department) enterprise.department = args.department;
      if (args.employeeNumber) enterprise.employeeNumber = args.employeeNumber;
      if (args.managerId) enterprise.manager = { value: args.managerId };

      const entra: Record<string, unknown> = { mailNickname: args.mailNickname };
      if (args.userType) entra.userType = args.userType;

      const schemas = [SCHEMA_USER_CORE, SCHEMA_ENTRA_USER];
      if (Object.keys(enterprise).length > 0) schemas.push(SCHEMA_ENTERPRISE_USER);

      const body: ScimUser = {
        schemas,
        userName: args.userName,
        password: args.password,
        displayName: args.displayName,
        active: args.active ?? true,
        name: {
          givenName: args.givenName,
          familyName: args.familyName,
        },
        ...(args.externalId ? { externalId: args.externalId } : {}),
        ...(args.emails ? { emails: args.emails } : {}),
        ...(args.phoneNumbers ? { phoneNumbers: args.phoneNumbers } : {}),
        ...(args.addresses ? { addresses: args.addresses } : {}),
        [SCHEMA_ENTRA_USER]: entra,
        ...(Object.keys(enterprise).length > 0
          ? { [SCHEMA_ENTERPRISE_USER]: enterprise }
          : {}),
      };

      return client.request<ScimUser>({
        method: "POST",
        path: "/users",
        body,
      });
    }),
  );

  server.registerTool(
    "update_user",
    {
      title: "Update user",
      description:
        "PATCH a user. Operations are validated: removing mailNickname (or nulling it out) is blocked, and addresses[...] paths must use exactly [type eq \"work\"]. Other complex multi-valued paths (e.g. emails[type eq \"work\" and primary eq true].value) are passed through as-is.",
      inputSchema: {
        id: z.string().min(1),
        operations: z.array(patchOpSchema).min(1),
      },
    },
    wrapTool(async (args: { id: string; operations: ScimPatchOperation[] }) => {
      const body = buildUserPatch(args.operations);
      await client.request({
        method: "PATCH",
        path: `/users/${encodeURIComponent(args.id)}`,
        body,
      });
      return { ok: true, id: args.id };
    }),
  );

  server.registerTool(
    "deprovision_user",
    {
      title: "Deprovision user",
      description: "DELETE a user by id.",
      inputSchema: { id: z.string().min(1) },
    },
    wrapTool(async (args: { id: string }) => {
      await client.request({
        method: "DELETE",
        path: `/users/${encodeURIComponent(args.id)}`,
      });
      return { ok: true, id: args.id };
    }),
  );

  server.registerTool(
    "update_user_lifecycle",
    {
      title: "Update user lifecycle (e.g. employeeLeaveDateTime)",
      description:
        "PATCH lifecycle attributes on a user. Requires User-LifeCycleInfo.ReadWrite.All on the app registration.",
      inputSchema: {
        id: z.string().min(1),
        employeeLeaveDateTime: z
          .string()
          .optional()
          .describe('ISO-8601 datetime (e.g. "2026-12-31T17:00:00Z").'),
      },
    },
    wrapTool(async (args: { id: string; employeeLeaveDateTime?: string }) => {
      const ops: ScimPatchOperation[] = [];
      if (args.employeeLeaveDateTime !== undefined) {
        ops.push({
          op: "replace",
          path: `${SCHEMA_ENTRA_USER}:employeeLeaveDateTime`,
          value: args.employeeLeaveDateTime,
        });
      }
      if (ops.length === 0) {
        return { ok: true, id: args.id, noChanges: true };
      }
      await client.request({
        method: "PATCH",
        path: `/users/${encodeURIComponent(args.id)}`,
        body: { schemas: [SCHEMA_PATCH_OP], Operations: ops },
      });
      return { ok: true, id: args.id };
    }),
  );

  server.registerTool(
    "get_user_custom_security_attributes",
    {
      title: "Get user Custom Security Attributes",
      description:
        "Fetch only the CustomSecurityAttributes extension for a user. Pass attributeSets to project specific attribute sets (the form the API documents); omitting it requests the whole extension URN, which the API may ignore. Requires CustomSecAttributeAssignment.Read.All.",
      inputSchema: {
        id: z.string().min(1),
        attributeSets: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            'Attribute set names to project, e.g. ["Engineering"]. Recommended: the documented projection form is urn:...:CustomSecurityAttributes:<Set>.',
          ),
      },
    },
    wrapTool(async (args: { id: string; attributeSets?: string[] }) => {
      const attributes = args.attributeSets?.length
        ? args.attributeSets.map((set) => `${SCHEMA_ENTRA_CSA}:${set}`).join(",")
        : SCHEMA_ENTRA_CSA;
      return client.request<ScimUser>({
        method: "GET",
        path: `/users/${encodeURIComponent(args.id)}`,
        query: { attributes },
      });
    }),
  );

  server.registerTool(
    "update_user_custom_security_attributes",
    {
      title: "Update user Custom Security Attributes",
      description:
        'PATCH CustomSecurityAttributes on a user. Operation paths look like "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes:<Set>.<Attr>". Requires CustomSecAttributeAssignment.ReadWrite.All.',
      inputSchema: {
        id: z.string().min(1),
        operations: z.array(patchOpSchema).min(1),
      },
    },
    wrapTool(async (args: { id: string; operations: ScimPatchOperation[] }) => {
      const body = buildCsaPatch(args.operations);
      await client.request({
        method: "PATCH",
        path: `/users/${encodeURIComponent(args.id)}`,
        body,
      });
      return { ok: true, id: args.id };
    }),
  );
}
