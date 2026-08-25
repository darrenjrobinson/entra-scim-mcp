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
  type ScimUserCreatePayload,
} from "../scim/types.js";

const filterClauseSchema = z.object({
  attr: z
    .string()
    .describe(
      "Attribute to filter on. 'eq' accepts userName, externalId, id, groups.value and mailNickname; 'ew' accepts userName and mailNickname only.",
    ),
  op: z.enum(["eq", "ew"]).describe("'eq' is an exact match, 'ew' an ends-with match."),
  value: z.string().describe("Value to compare against. Not case-sensitive."),
});

/**
 * A SCIM patch operation, with the `path` description tailored per tool.
 *
 * Path syntax is the hardest part of these tools to get right from the outside:
 * the API accepts a narrow subset of RFC 7644, and the accepted subset differs
 * between ordinary attributes and Custom Security Attributes. One shared schema
 * with a single generic description described neither well enough to call
 * without trial and error.
 */
const patchOpSchema = (pathHint: string) =>
  z.object({
    op: z
      .enum(["add", "remove", "replace"])
      .describe(
        "'replace' overwrites, 'add' appends to a multi-valued attribute, 'remove' clears. Prefer 'replace' for single-valued attributes: 'add' on one is accepted but is just an overwrite.",
      ),
    path: z.string().optional().describe(pathHint),
    value: z
      .unknown()
      .optional()
      .describe(
        "The new value: string, boolean, object or array depending on the attribute. Omit for 'remove'.",
      ),
  });

const USER_PATH_HINT =
  'Attribute path. Simple: "displayName", "active", "name.givenName". Extension attribute: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department". Multi-valued with a filter: "emails[type eq \\"work\\"].value".';

const CSA_PATH_HINT =
  'Fully-qualified CSA path: "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes:<Set>.<Attribute>" — for example "...:CustomSecurityAttributes:Engineering.Team". The set and attribute must already be defined in the tenant; this cannot create them.';

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
        "List Entra users via SCIM. Filter supports 'eq' on userName/externalId/id/groups.value/mailNickname and 'ew' on userName/mailNickname; only 'and' is supported. Cursor-based pagination. This is also how you resolve a userName to an object id, since every other user tool takes the id. Prefer a filter plus a narrow 'attributes' list over listing everything: each page is a separate billed request.",
      inputSchema: {
        filter: z
          .array(filterClauseSchema)
          .optional()
          .describe(
            "Filter clauses ANDed together. Each clause: { attr, op: 'eq'|'ew', value }. Omit to list all users.",
          ),
        attributes: z
          .array(z.string())
          .optional()
          .describe(
            'Attributes to include, e.g. ["userName", "displayName"]. Narrowing the projection is the cheapest way to keep a listing small. Custom Security Attributes cannot be requested here — use get_user_custom_security_attributes.',
          ),
        excludedAttributes: z
          .array(z.string())
          .optional()
          .describe(
            "Attributes to exclude from the response. Mutually exclusive with attributes.",
          ),
        count: z.number().int().positive().optional().describe("Page size."),
        cursor: z
          .string()
          .optional()
          .describe(
            "Pagination cursor from a prior call's nextCursor. Omit for the first page.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    wrapTool(
      async (args: {
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
      },
    ),
  );

  server.registerTool(
    "get_user",
    {
      title: "Get user by id",
      description:
        "Fetch a single user by Entra object id. Two things are never in the response, whatever you project: Custom Security Attributes (the schema marks them returned:\"request\" — use get_user_custom_security_attributes) and group memberships (filter list_groups on members.value instead). To look a user up by userName rather than id, use list_users with an 'eq' filter.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe(
            "Entra object id (GUID). This is the SCIM 'id', not userName — resolve a userName with list_users.",
          ),
        attributes: z
          .array(z.string())
          .optional()
          .describe("Attributes to include in the response. Omit for the default set."),
        excludedAttributes: z
          .array(z.string())
          .optional()
          .describe(
            "Attributes to exclude from the response. Mutually exclusive with attributes.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    wrapTool(
      async (args: {
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
      },
    ),
  );

  server.registerTool(
    "provision_user",
    {
      title: "Provision user",
      description:
        "Create a user in Entra via SCIM. Enforces the required attribute set: userName, password, displayName, givenName, familyName, mailNickname. active defaults to true. Not idempotent — a second call with the same userName fails with a uniqueness conflict, so check with list_users first if a retry might be a duplicate. Group membership is not settable here: create the user, then call add_group_members.",
      inputSchema: {
        userName: z
          .string()
          .min(1)
          .describe(
            "UPN-style user name (e.g. user@contoso.com). The domain must already be verified on the tenant, or the create is rejected.",
          ),
        password: z
          .string()
          .min(1)
          .describe(
            "Initial password; must satisfy the tenant's password policy. Never echoed back — it is stripped from every tool result, dry-run output included.",
          ),
        displayName: z.string().min(1).describe("Name shown in directory listings."),
        givenName: z.string().min(1).describe("First name; sent as name.givenName."),
        familyName: z.string().min(1).describe("Surname; sent as name.familyName."),
        mailNickname: z
          .string()
          .min(1)
          .describe(
            "Mail alias, local part only (no @domain). Required by Entra and, once set, cannot be removed by update_user.",
          ),
        active: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether the account can sign in. Defaults to true."),
        externalId: z
          .string()
          .optional()
          .describe(
            "Your own system's identifier for this user, stored for correlation. Filterable via list_users.",
          ),
        userType: z.string().optional().describe('"Member" or "Guest".'),
        emails: z
          .array(emailSchema)
          .optional()
          .describe(
            'Email addresses, e.g. [{ value: "a@contoso.com", type: "work", primary: true }].',
          ),
        phoneNumbers: z
          .array(phoneSchema)
          .optional()
          .describe('Phone numbers, e.g. [{ value: "+61 2 0000 0000", type: "work" }].'),
        addresses: z
          .array(addressSchema)
          .optional()
          .describe(
            'Postal addresses. Only type "work" can be patched later, so prefer that type here.',
          ),
        department: z
          .string()
          .optional()
          .describe("Sent in the enterprise user extension."),
        employeeNumber: z
          .string()
          .optional()
          .describe("Sent in the enterprise user extension."),
        managerId: z
          .string()
          .optional()
          .describe(
            "Entra object id of the user's manager. Must be an existing user; a userName is not accepted.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Creates only. A duplicate userName is rejected by the API rather than
        // merged over an existing user, so nothing is ever overwritten here.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    wrapTool(
      async (args: {
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

        const body: ScimUserCreatePayload = {
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
      },
    ),
  );

  server.registerTool(
    "update_user",
    {
      title: "Update user",
      description:
        'PATCH a user with SCIM operations — e.g. { op: "replace", path: "displayName", value: "Ada L" }, or { op: "replace", path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department", value: "R&D" }. Operations are validated before anything is sent: removing mailNickname (or nulling it out) is blocked, because Entra cannot re-derive it, and addresses[...] paths must use exactly [type eq "work"] — the only filter the API accepts there. Other complex multi-valued paths (e.g. emails[type eq "work" and primary eq true].value) are passed through as-is. Not the tool for Custom Security Attributes (use update_user_custom_security_attributes), employeeLeaveDateTime (use update_user_lifecycle), or group membership (use add_group_members / remove_group_member).',
      inputSchema: {
        id: z.string().min(1).describe("Entra object id of the user to patch."),
        operations: z
          .array(patchOpSchema(USER_PATH_HINT))
          .min(1)
          .describe(
            "Operations applied in order as a single PATCH — they all succeed or all fail together.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        // "remove" and "replace" both discard whatever was there before, and
        // this API offers no undo.
        destructiveHint: true,
        // An "add" against a multi-valued attribute accumulates, so repeating a
        // call is not reliably a no-op.
        idempotentHint: false,
        openWorldHint: true,
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
      description:
        "DELETE a user by id. The user is soft-deleted into the Entra recycle bin and is restorable for 30 days — but only through Microsoft Graph, not SCIM, so this server cannot undo it. Deleting also strips every group membership, which is why a later remove_group_member for this user returns 404. A second call for the same id returns 404 rather than succeeding quietly.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe(
            "Entra object id of the user to delete. Resolve a userName with list_users first — there is no confirmation step.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
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
      title: "Update user lifecycle",
      description:
        "PATCH lifecycle attributes on a user — currently employeeLeaveDateTime. Not an inert field: Entra Lifecycle Workflows can be scheduled off it, so writing a past or imminent date may start offboarding. Called with no attributes set it changes nothing and returns { noChanges: true } without issuing a request. Requires User-LifeCycleInfo.ReadWrite.All on the app registration, which is separate from the permissions the other tools need.",
      inputSchema: {
        id: z.string().min(1).describe("Entra object id of the user."),
        employeeLeaveDateTime: z
          .string()
          .optional()
          .describe(
            'ISO-8601 datetime in UTC (e.g. "2026-12-31T17:00:00Z"). Omit to leave it unchanged.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Overwrites the stored date with no history, and the write can trigger
        // an offboarding workflow this API cannot call back.
        destructiveHint: true,
        // Writing the same datetime twice lands in the same state.
        idempotentHint: true,
        openWorldHint: true,
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
        "Fetch Custom Security Attributes for a user, projected by attribute set. attributeSets is required — the API rejects the bare extension URN with a 400. CSAs never come back from a plain get_user; they are only returned when named explicitly here. A set the user holds no values in comes back empty, which is a valid answer rather than an error. Requires CustomSecAttributeAssignment.Read.All (covered by CustomSecAttributeAssignment.ReadWrite.All).",
      inputSchema: {
        id: z.string().min(1).describe("Entra object id of the user."),
        attributeSets: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            'Attribute set names to project, e.g. ["Engineering"]. Projection is set-granular: the API documents urn:...:CustomSecurityAttributes:<Set>, not individual attribute names. Set names are defined in the tenant and no SCIM call lists them, so ask rather than guess.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    wrapTool(async (args: { id: string; attributeSets: string[] }) => {
      const attributes = args.attributeSets
        .map((set) => `${SCHEMA_ENTRA_CSA}:${set}`)
        .join(",");
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
        'PATCH CustomSecurityAttributes on a user. Set a value with { op: "replace", path: "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes:Engineering.Team", value: "Platform" }. Clear one with op "remove" on the same path, or by replacing a multi-valued attribute with an empty array — both delete the assignment outright. The attribute set and attribute must already exist in the tenant; this cannot define them, and an unknown path is a 400. Read the result back with get_user_custom_security_attributes, not get_user. Requires CustomSecAttributeAssignment.ReadWrite.All.',
      inputSchema: {
        id: z.string().min(1).describe("Entra object id of the user."),
        operations: z
          .array(patchOpSchema(CSA_PATH_HINT))
          .min(1)
          .describe("Operations applied in order as a single PATCH."),
      },
      annotations: {
        readOnlyHint: false,
        // "remove", and a "replace" with an empty array, both delete
        // assignments — and CSAs are commonly read by Conditional Access.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
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
