import { FilterValidationError } from "../../scim/errors.js";
import { touchesMembers } from "../../scim/patch.js";
import type { ScimGroup, ScimPatchOperation } from "../../scim/types.js";
import { MockScimError } from "../errors.js";
import { groupMatches, parseFilter } from "../filter-parse.js";
import { applyGroupPatch } from "../patch-apply.js";
import type { MockStore, StoredGroup } from "../store.js";
import type { HandlerContext, HandlerResponse } from "./users.js";
import { parsePermissiveFilter } from "./users.js";
import {
  listResponseBody,
  paginate,
  projectResource,
  type PageParams,
} from "./shared.js";

export function listGroups(
  ctx: HandlerContext,
  query: URLSearchParams,
): HandlerResponse {
  let groups = ctx.store.listGroups();
  const rawFilter = query.get("filter");
  if (rawFilter) {
    const clauses = parseGroupFilter(rawFilter, ctx.validatorCompat);
    groups = groups.filter((group) => groupMatches(group, clauses));
  }
  const page = paginate(groups, pageParams(query), ctx.validatorCompat);
  const resources = page.page.map((group) =>
    projectResource(
      sanitizeGroup(group, ctx.validatorCompat),
      query.get("attributes"),
      query.get("excludedAttributes"),
    ),
  );
  return { status: 200, body: listResponseBody(resources, page) };
}

export function getGroup(
  ctx: HandlerContext,
  id: string,
  query: URLSearchParams,
): HandlerResponse {
  const group = ctx.store.getGroup(id);
  if (!group) {
    throw new MockScimError(404, `Group '${id}' not found.`);
  }
  return {
    status: 200,
    body: projectResource(
      sanitizeGroup(group, ctx.validatorCompat),
      query.get("attributes"),
      query.get("excludedAttributes"),
    ),
  };
}

export function createGroup(ctx: HandlerContext, body: unknown): HandlerResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new MockScimError(400, "Request body must be a JSON object.", "invalidSyntax");
  }
  const group = body as ScimGroup;
  if (typeof group.displayName !== "string" || group.displayName.length === 0) {
    throw new MockScimError(400, "Missing required attributes: displayName.", "invalidValue");
  }
  // Entra permits duplicate group displayNames, so strict mode accepts them.
  // The SCIM Validator treats displayName as the Group joining property and
  // requires a duplicate POST to 409, so compat mode enforces uniqueness.
  if (ctx.validatorCompat) {
    const name = group.displayName.toLowerCase();
    const clash = ctx.store
      .listGroups()
      .some((g) => (g.displayName ?? "").toLowerCase() === name);
    if (clash) {
      throw new MockScimError(
        409,
        `A group with displayName '${group.displayName}' already exists.`,
        "uniqueness",
      );
    }
  }
  const created = ctx.store.createGroup(group);
  return {
    status: 201,
    body: sanitizeGroup(created, ctx.validatorCompat),
    headers: { Location: `/groups/${created.id}` },
  };
}

export function patchGroup(
  ctx: HandlerContext,
  id: string,
  body: unknown,
): HandlerResponse {
  const group = ctx.store.getGroup(id);
  if (!group) {
    throw new MockScimError(404, `Group '${id}' not found.`);
  }
  if (ctx.validatorCompat) {
    applyCompatGroupPatch(ctx.store, group, body);
    return {
      status: 200,
      body: sanitizeGroup(ctx.store.getGroup(id)!, ctx.validatorCompat),
    };
  }
  applyGroupPatch(group, body, ctx.store);
  return { status: 204 };
}

export function deleteGroup(ctx: HandlerContext, id: string): HandlerResponse {
  if (!ctx.store.deleteGroup(id)) {
    throw new MockScimError(404, `Group '${id}' not found.`);
  }
  return { status: 204 };
}

/**
 * Validator-compat PATCH semantics: RFC-standard SCIM rather than Entra's
 * restrictions — membership ops may mix with attribute ops, replace on
 * members is allowed, and multi-member removes work.
 */
function applyCompatGroupPatch(
  store: MockStore,
  group: StoredGroup,
  body: unknown,
): void {
  const record = body as Record<string, unknown> | null;
  const rawOps = record?.Operations ?? record?.operations;
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    throw new MockScimError(400, "PATCH body must contain Operations.", "invalidSyntax");
  }
  const ops = rawOps as ScimPatchOperation[];
  const memberOps = ops.filter((op) => touchesMembers(op));
  const attributeOps = ops.filter((op) => !touchesMembers(op));

  for (const op of memberOps) {
    applyCompatMemberOp(store, group, op);
  }
  if (attributeOps.length > 0) {
    applyGroupPatch(
      group,
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: attributeOps,
      },
      store,
    );
  }
}

function applyCompatMemberOp(
  store: MockStore,
  group: StoredGroup,
  op: ScimPatchOperation,
): void {
  const filterMatch = op.path?.match(/members\[value eq "((?:[^"\\]|\\.)+)"\]/i);
  if (op.op === "remove") {
    if (filterMatch) {
      store.removeGroupMember(group.id, filterMatch[1]!.replace(/\\(["\\])/g, "$1"));
      return;
    }
    // remove all members (or the listed ones, when a value array is given)
    const ids = memberIdsFromValue(op.value);
    const current = store.getGroup(group.id)!.members.map((m) => m.value);
    for (const id of ids ?? current) {
      store.removeGroupMember(group.id, id);
    }
    return;
  }
  const ids = memberIdsFromValue(extractPathlessMembers(op)) ?? [];
  if (op.op === "replace") {
    const current = store.getGroup(group.id)!.members.map((m) => m.value);
    for (const id of current) store.removeGroupMember(group.id, id);
  }
  if (ids.length > 0) store.addGroupMembers(group.id, ids);
}

function extractPathlessMembers(op: ScimPatchOperation): unknown {
  if (op.path || !op.value || typeof op.value !== "object" || Array.isArray(op.value)) {
    return op.value;
  }
  const entry = Object.entries(op.value).find(([key]) =>
    /(^|[^a-zA-Z])members(\b|\[|\.)/i.test(key),
  );
  return entry ? entry[1] : op.value;
}

function memberIdsFromValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) =>
      entry && typeof entry === "object"
        ? (entry as { value?: unknown }).value
        : undefined,
    )
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

function parseGroupFilter(raw: string, validatorCompat: boolean) {
  try {
    return parseFilter(raw, "group");
  } catch (err) {
    if (validatorCompat && err instanceof FilterValidationError) {
      return parsePermissiveFilter(raw);
    }
    throw err;
  }
}

function sanitizeGroup(
  group: StoredGroup,
  validatorCompat: boolean,
): Record<string, unknown> {
  const { members, ...rest } = structuredClone(group);
  // Entra never returns members on group reads; RFC-standard clients (the
  // validator) expect them.
  return validatorCompat ? { ...rest, members } : rest;
}

function pageParams(query: URLSearchParams): PageParams {
  return {
    count: query.get("count"),
    cursor: query.get("cursor"),
    startIndex: query.get("startIndex"),
  };
}
