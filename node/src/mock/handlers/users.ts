import { FilterValidationError } from "../../scim/errors.js";
import { SCHEMA_ENTRA_USER, type ScimUserCreatePayload } from "../../scim/types.js";
import { MockScimError } from "../errors.js";
import { parseFilter, userMatches } from "../filter-parse.js";
import { applyUserPatch } from "../patch-apply.js";
import type { MockStore, StoredUser } from "../store.js";
import {
  listResponseBody,
  paginate,
  projectResource,
  type PageParams,
} from "./shared.js";

export interface HandlerContext {
  store: MockStore;
  validatorCompat: boolean;
}

export interface HandlerResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export function listUsers(
  ctx: HandlerContext,
  query: URLSearchParams,
): HandlerResponse {
  let users = ctx.store.listUsers();
  const rawFilter = query.get("filter");
  if (rawFilter) {
    const clauses = parseUserFilter(rawFilter, ctx.validatorCompat);
    const matchCtx = { groupIdsOfUser: (id: string) => ctx.store.groupIdsOfUser(id) };
    users = users.filter((user) => userMatches(user, clauses, matchCtx));
  }
  const page = paginate(users, pageParams(query), ctx.validatorCompat);
  const resources = page.page.map((user) =>
    projectResource(
      sanitizeUser(user),
      query.get("attributes"),
      query.get("excludedAttributes"),
    ),
  );
  return {
    status: 200,
    body: listResponseBody(resources, page),
  };
}

export function getUser(
  ctx: HandlerContext,
  id: string,
  query: URLSearchParams,
): HandlerResponse {
  const user = ctx.store.getUser(id);
  if (!user) {
    throw new MockScimError(404, `User '${id}' not found.`);
  }
  return {
    status: 200,
    body: projectResource(
      sanitizeUser(user),
      query.get("attributes"),
      query.get("excludedAttributes"),
    ),
  };
}

const REQUIRED_CREATE_ATTRS: {
  label: string;
  present: (u: ScimUserCreatePayload) => boolean;
}[] = [
  { label: "userName", present: (u) => nonEmpty(u.userName) },
  { label: "password", present: (u) => nonEmpty(u.password) },
  { label: "displayName", present: (u) => nonEmpty(u.displayName) },
  { label: "active", present: (u) => typeof u.active === "boolean" },
  { label: "name.givenName", present: (u) => nonEmpty(u.name?.givenName) },
  { label: "name.familyName", present: (u) => nonEmpty(u.name?.familyName) },
  {
    label: `${SCHEMA_ENTRA_USER}:mailNickname`,
    present: (u) => nonEmpty(u[SCHEMA_ENTRA_USER]?.mailNickname),
  },
];

export function createUser(ctx: HandlerContext, body: unknown): HandlerResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new MockScimError(400, "Request body must be a JSON object.", "invalidSyntax");
  }
  const user = body as ScimUserCreatePayload;
  // The Entra inbound API's required set is far stricter than RFC 7643, which
  // marks only userName required. The SCIM Validator generates RFC-standard
  // users (and cannot send a password at all), so compat mode enforces the RFC
  // minimum instead — otherwise every generated create would 400.
  const required = ctx.validatorCompat
    ? REQUIRED_CREATE_ATTRS.filter((a) => a.label === "userName")
    : REQUIRED_CREATE_ATTRS;
  const missing = required.filter((a) => !a.present(user)).map((a) => a.label);
  if (missing.length > 0) {
    throw new MockScimError(
      400,
      `Missing required attributes: ${missing.join(", ")}.`,
      "invalidValue",
    );
  }
  const created = ctx.store.createUser(user);
  return {
    status: 201,
    body: sanitizeUser(created),
    headers: { Location: `/users/${created.id}` },
  };
}

export function patchUser(
  ctx: HandlerContext,
  id: string,
  body: unknown,
): HandlerResponse {
  const user = ctx.store.getUser(id);
  if (!user) {
    throw new MockScimError(404, `User '${id}' not found.`);
  }
  const updated = applyUserPatch(user, body, ctx.validatorCompat);
  ctx.store.putUser(updated);
  if (ctx.validatorCompat) {
    return { status: 200, body: sanitizeUser(ctx.store.getUser(id)!) };
  }
  return { status: 204 };
}

export function deleteUser(ctx: HandlerContext, id: string): HandlerResponse {
  if (!ctx.store.deleteUser(id)) {
    throw new MockScimError(404, `User '${id}' not found.`);
  }
  return { status: 204 };
}

function parseUserFilter(raw: string, validatorCompat: boolean) {
  try {
    return parseFilter(raw, "user");
  } catch (err) {
    if (validatorCompat && err instanceof FilterValidationError) {
      // Compat mode accepts filters outside the Entra allow-list; parse the
      // grammar without allow-list validation by retrying against the group
      // rules too, then fall back to a permissive parse.
      return parsePermissiveFilter(raw);
    }
    throw err;
  }
}

export function parsePermissiveFilter(raw: string) {
  // Same grammar, no allow-list: attr (eq|ew) "value" joined by and.
  const clauses: { attr: string; op: "eq" | "ew"; value: string }[] = [];
  let rest = raw.trim();
  const pattern = /^(\S+)\s+(eq|ew)\s+"((?:[^"\\]|\\.)*)"\s*(and\s+)?/i;
  while (rest.length > 0) {
    const match = rest.match(pattern);
    if (!match) {
      throw new FilterValidationError(`Unparseable filter near: ${rest.slice(0, 40)}`);
    }
    clauses.push({
      attr: match[1]!,
      op: match[2]!.toLowerCase() as "eq" | "ew",
      value: match[3]!.replace(/\\(["\\])/g, "$1"),
    });
    rest = rest.slice(match[0].length);
  }
  return clauses;
}

function sanitizeUser(user: StoredUser): Record<string, unknown> {
  const { password: _password, ...rest } = structuredClone(user);
  return rest;
}

function pageParams(query: URLSearchParams): PageParams {
  return {
    count: query.get("count"),
    cursor: query.get("cursor"),
    startIndex: query.get("startIndex"),
  };
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
