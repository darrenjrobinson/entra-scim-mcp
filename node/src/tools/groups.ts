import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ScimClient } from "../scim/client.js";
import { joinAttributes, ToolError, wrapTool } from "./util.js";
import { buildGroupFilter } from "../scim/filter.js";
import { ScimError } from "../scim/errors.js";
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
  attr: z.string(),
  op: z.enum(["eq", "ew"]),
  value: z.string(),
});

const patchOpSchema = z.object({
  op: z.enum(["add", "remove", "replace"]),
  path: z.string().optional(),
  value: z.unknown().optional(),
});

export function registerGroupTools(server: McpServer, client: ScimClient): void {
  server.registerTool(
    "list_groups",
    {
      title: "List groups",
      description:
        "List Entra groups via SCIM. Filter supports 'eq' on displayName/id/members.value and 'ew' on displayName; only 'and' is supported.",
      inputSchema: {
        filter: z.array(filterClauseSchema).optional(),
        attributes: z.array(z.string()).optional(),
        excludedAttributes: z.array(z.string()).optional(),
        count: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      },
    },
    wrapTool(async (args: {
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
    }),
  );

  server.registerTool(
    "get_group",
    {
      title: "Get group by id",
      description:
        "Fetch a single group by id. Note: members are NOT returned. To find a user's groups, use list_groups with a members.value filter.",
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
      return client.request<ScimGroup>({
        method: "GET",
        path: `/groups/${encodeURIComponent(args.id)}`,
        query: {
          attributes: joinAttributes(args.attributes),
          excludedAttributes: joinAttributes(args.excludedAttributes),
        },
      });
    }),
  );

  server.registerTool(
    "create_group",
    {
      title: "Create group",
      description:
        "Create an Entra group via SCIM. displayName is required. Use the Entra extension flags to choose security vs. mail-enabled / Unified groups.",
      inputSchema: {
        displayName: z.string().min(1),
        description: z.string().optional(),
        mailNickname: z.string().optional(),
        mailEnabled: z.boolean().optional(),
        securityEnabled: z.boolean().optional(),
        externalId: z.string().optional(),
      },
    },
    wrapTool(async (args: {
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
      if (args.securityEnabled !== undefined) ext.securityEnabled = args.securityEnabled;

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
    }),
  );

  server.registerTool(
    "update_group",
    {
      title: "Update group attributes",
      description:
        "PATCH group attributes (displayName, description, etc). Membership changes are NOT allowed here — use add_group_members / remove_group_member.",
      inputSchema: {
        id: z.string().min(1),
        operations: z.array(patchOpSchema).min(1),
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
      description: "DELETE a group by id.",
      inputSchema: { id: z.string().min(1) },
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
      description: `Add one or more users to a group. Auto-chunks at ${GROUP_MEMBER_ADD_CHUNK_SIZE} member ids per PATCH call (Entra SCIM API constraint). Idempotent — adding an existing member is a no-op.`,
      inputSchema: {
        id: z.string().min(1).describe("Group object id."),
        memberIds: z
          .array(z.string().min(1))
          .min(1)
          .describe("User object ids to add to the group."),
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
        "Remove a single user from a group. The Entra SCIM API only allows one removal per PATCH call and no other ops in the same call.",
      inputSchema: {
        id: z.string().min(1).describe("Group object id."),
        memberId: z.string().min(1).describe("User object id to remove."),
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
