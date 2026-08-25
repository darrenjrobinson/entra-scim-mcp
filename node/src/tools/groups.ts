import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ScimClient } from "../scim/client.js";
import { joinAttributes, ToolError, wrapTool } from "./util.js";
import { buildGroupFilter } from "../scim/filter.js";
import { DryRunRequest, ScimError } from "../scim/errors.js";
import {
  buildAddGroupMemberPatches,
  buildGroupAttributePatch,
  buildRemoveGroupMemberPatch,
  GROUP_MEMBER_ADD_CHUNK_SIZE,
} from "../scim/patch.js";
import { normalizeListResponse } from "../scim/pagination.js";
import {
  SCHEMA_ENTRA_GROUP,
  SCHEMA_GROUP_CORE,
  type ScimGroup,
  type ScimListResponse,
  type ScimPatchOperation,
} from "../scim/types.js";

const filterClauseSchema = z.object({
  attr: z
    .string()
    .describe(
      "Attribute to filter on. 'eq' accepts displayName, id and members.value; 'ew' accepts displayName only.",
    ),
  op: z.enum(["eq", "ew"]).describe("'eq' is an exact match, 'ew' an ends-with match."),
  value: z.string().describe("Value to compare against. Not case-sensitive."),
});

/** See the note on the equivalent factory in users.ts. */
const patchOpSchema = (pathHint: string) =>
  z.object({
    op: z
      .enum(["add", "remove", "replace"])
      .describe(
        "'replace' overwrites, 'add' appends to a multi-valued attribute, 'remove' clears. Prefer 'replace' for single-valued attributes.",
      ),
    path: z.string().optional().describe(pathHint),
    value: z.unknown().optional().describe("The new value. Omit for 'remove'."),
  });

const GROUP_PATH_HINT =
  'Attribute path. Core: "displayName", "externalId". Entra extension: "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:Group:description", or the same URN ending in mailNickname / mailEnabled / securityEnabled. A "members" path is rejected before the request is sent — membership has its own tools.';

export function registerGroupTools(server: McpServer, client: ScimClient): void {
  server.registerTool(
    "list_groups",
    {
      title: "List groups",
      description:
        "List Entra groups via SCIM. Filter supports 'eq' on displayName/id/members.value and 'ew' on displayName; only 'and' is supported. Cursor-based pagination. A members.value filter is the only way to discover which groups a user belongs to — neither get_user nor get_group reports membership.",
      inputSchema: {
        filter: z
          .array(filterClauseSchema)
          .optional()
          .describe(
            "Filter clauses ANDed together. Each clause: { attr, op: 'eq'|'ew', value }. To list a user's groups, pass [{ attr: 'members.value', op: 'eq', value: '<userId>' }].",
          ),
        attributes: z
          .array(z.string())
          .optional()
          .describe(
            'Attributes to include, e.g. ["displayName", "id"]. Narrowing the projection is the cheapest way to keep a listing small.',
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
        const result = await client.request<ScimListResponse<ScimGroup>>({
          method: "GET",
          path: "/groups",
          query: {
            filter: buildGroupFilter(args.filter),
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
    "get_group",
    {
      title: "Get group by id",
      description:
        "Fetch a single group by id. Note: members are NOT returned, at any page size or projection. To find a user's groups, use list_groups with a members.value filter; to check one specific membership, filter list_groups on both id and members.value.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe(
            "Entra object id of the group. Resolve a displayName with list_groups.",
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
        return client.request<ScimGroup>({
          method: "GET",
          path: `/groups/${encodeURIComponent(args.id)}`,
          query: {
            attributes: joinAttributes(args.attributes),
            excludedAttributes: joinAttributes(args.excludedAttributes),
          },
        });
      },
    ),
  );

  server.registerTool(
    "create_group",
    {
      title: "Create group",
      description:
        "Create an Entra group via SCIM. displayName is required; the Entra extension flags decide the group type. securityEnabled true with mailEnabled false (or omitted) is a security group. mailEnabled true with securityEnabled false is a Microsoft 365 / Unified group and needs mailNickname. Entra does not support creating mail-enabled security groups, so setting both flags true is rejected. displayName is not unique in Entra — creating the same name twice yields two groups, so check with list_groups if a retry might duplicate. Members cannot be set here: create the group, then call add_group_members.",
      inputSchema: {
        displayName: z.string().min(1).describe("Group name. Not required to be unique."),
        description: z.string().optional().describe("Sent in the Entra group extension."),
        mailNickname: z
          .string()
          .optional()
          .describe(
            "Mail alias, local part only (no @domain). Required when mailEnabled is true.",
          ),
        mailEnabled: z
          .boolean()
          .optional()
          .describe("True creates a mail-enabled (Microsoft 365 / Unified) group."),
        securityEnabled: z
          .boolean()
          .optional()
          .describe("True creates a security group, usable for access assignment."),
        externalId: z
          .string()
          .optional()
          .describe(
            "Your own system's identifier for this group, stored for correlation.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Creates only; never touches an existing group.
        destructiveHint: false,
        // displayName is not unique, so a repeat call creates a second group.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    wrapTool(
      async (args: {
        displayName: string;
        description?: string;
        mailNickname?: string;
        mailEnabled?: boolean;
        securityEnabled?: boolean;
        externalId?: string;
      }) => {
        const ext: Record<string, unknown> = {};
        if (args.description !== undefined) ext.description = args.description;
        if (args.mailNickname !== undefined) ext.mailNickname = args.mailNickname;
        if (args.mailEnabled !== undefined) ext.mailEnabled = args.mailEnabled;
        if (args.securityEnabled !== undefined)
          ext.securityEnabled = args.securityEnabled;

        const body: ScimGroup = {
          schemas: [SCHEMA_GROUP_CORE, SCHEMA_ENTRA_GROUP],
          displayName: args.displayName,
          ...(args.externalId ? { externalId: args.externalId } : {}),
          ...(Object.keys(ext).length > 0 ? { [SCHEMA_ENTRA_GROUP]: ext } : {}),
        };

        return client.request<ScimGroup>({
          method: "POST",
          path: "/groups",
          body,
        });
      },
    ),
  );

  server.registerTool(
    "update_group",
    {
      title: "Update group attributes",
      description:
        'PATCH group attributes — e.g. { op: "replace", path: "displayName", value: "Platform Engineering" }, or the Entra extension URN ending in ":description". Membership changes are NOT allowed here: a "members" path is rejected client-side before any request is sent, so use add_group_members / remove_group_member instead. Group type flags (mailEnabled, securityEnabled) are fixed at creation and cannot be patched.',
      inputSchema: {
        id: z.string().min(1).describe("Entra object id of the group to patch."),
        operations: z
          .array(patchOpSchema(GROUP_PATH_HINT))
          .min(1)
          .describe(
            "Operations applied in order as a single PATCH — they all succeed or all fail together.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        // "remove" and "replace" discard the previous value with no undo.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    wrapTool(async (args: { id: string; operations: ScimPatchOperation[] }) => {
      const body = buildGroupAttributePatch(args.operations);
      await client.request({
        method: "PATCH",
        path: `/groups/${encodeURIComponent(args.id)}`,
        body,
      });
      return { ok: true, id: args.id };
    }),
  );

  server.registerTool(
    "delete_group",
    {
      title: "Delete group",
      description:
        "DELETE a group by id. Microsoft 365 / Unified groups are soft-deleted and restorable for 30 days, security groups are removed permanently — and either way restoration is a Microsoft Graph operation, not a SCIM one, so this server cannot undo it. The group's members are not deleted, only their membership. Any access granted through this group is revoked. A second call for the same id returns 404.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe(
            "Entra object id of the group to delete. Resolve a displayName with list_groups first — there is no confirmation step, and displayName is not unique.",
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
        path: `/groups/${encodeURIComponent(args.id)}`,
      });
      return { ok: true, id: args.id };
    }),
  );

  server.registerTool(
    "add_group_members",
    {
      title: "Add group members",
      description: `Add one or more users to a group. Auto-chunks at ${GROUP_MEMBER_ADD_CHUNK_SIZE} member ids per PATCH call (Entra SCIM API constraint), and duplicate ids in the input are deduped. Idempotent — adding an existing member is a no-op, so retrying after a partial failure is safe. If a chunk fails mid-sequence the error reports addedMemberIds, failedMemberIds and notAttemptedMemberIds, because earlier chunks are already committed and cannot be rolled back.`,
      inputSchema: {
        id: z.string().min(1).describe("Group object id."),
        memberIds: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "User object ids to add to the group. Ids, not userNames — resolve those with list_users first.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Purely additive: no existing membership is removed or overwritten.
        destructiveHint: false,
        // The API treats a re-add as success.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    wrapTool(async (args: { id: string; memberIds: string[] }) => {
      const bodies = buildAddGroupMemberPatches(args.memberIds);
      // The deduped/trimmed ids actually sent, per chunk.
      const chunks = bodies.map((body) =>
        (body.Operations[0]!.value as { value: string }[]).map((m) => m.value),
      );
      const addedMemberIds: string[] = [];
      for (const [i, body] of bodies.entries()) {
        try {
          await client.request({
            method: "PATCH",
            path: `/groups/${encodeURIComponent(args.id)}`,
            body,
          });
        } catch (err) {
          if (err instanceof DryRunRequest) throw err;
          // Earlier chunks are already committed in Entra — the agent must
          // know that, or it will report total failure after a partial write.
          throw new ToolError({
            error: "AddGroupMembersPartialFailure",
            detail:
              `PATCH ${i + 1} of ${bodies.length} failed; ` +
              `${addedMemberIds.length} member(s) from earlier calls were already added and remain in the group. ` +
              "Adds are idempotent, so retrying with failed + not-attempted ids is safe.",
            id: args.id,
            addedMemberIds,
            failedMemberIds: chunks[i]!,
            notAttemptedMemberIds: chunks.slice(i + 1).flat(),
            cause:
              err instanceof ScimError
                ? err.toJSON()
                : { detail: err instanceof Error ? err.message : String(err) },
          });
        }
        addedMemberIds.push(...chunks[i]!);
      }
      return {
        ok: true,
        id: args.id,
        memberIds: addedMemberIds,
        patchCalls: bodies.length,
      };
    }),
  );

  server.registerTool(
    "remove_group_member",
    {
      title: "Remove group member",
      description:
        "Remove a single user from a group. The Entra SCIM API only allows one removal per PATCH call and no other ops in the same call, so removing several members means several calls. A 404 here does not mean the group is missing: the API answers \"Resource '<groupId>' does not exist or one of its queried reference-property objects are not present\" — naming the group, not the member — whenever the user is not a member, including when that user has been deleted. Confirm with list_groups filtered on members.value before concluding the group is gone.",
      inputSchema: {
        id: z.string().min(1).describe("Group object id."),
        memberId: z
          .string()
          .min(1)
          .describe(
            "User object id to remove. Must currently be a member, or the call 404s naming the group.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Revokes whatever access the group conferred.
        destructiveHint: true,
        // A second removal 404s rather than reporting success.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    wrapTool(async (args: { id: string; memberId: string }) => {
      const body = buildRemoveGroupMemberPatch(args.memberId);
      await client.request({
        method: "PATCH",
        path: `/groups/${encodeURIComponent(args.id)}`,
        body,
      });
      return { ok: true, id: args.id, memberId: args.memberId };
    }),
  );
}
