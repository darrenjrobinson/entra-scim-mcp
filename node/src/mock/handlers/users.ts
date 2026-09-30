import { FilterValidationError } from "../../scim/errors.js";
import type { ValidatedFilterClause } from "../../scim/filter.js";
import {
  SCHEMA_ENTERPRISE_USER,
  SCHEMA_ENTRA_USER,
  type ScimUserCreatePayload,
} from "../../scim/types.js";
import { MockScimError } from "../errors.js";
import { parseFilter, readClause, userMatches } from "../filter-parse.js";
import { applyUserPatch } from "../patch-apply.js";
import type { MockStore, StoredUser } from "../store.js";
import {
  DEFAULT_PAGE_SIZE,
  listResponseBody,
  paginate,
  parseAttrPath,
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

export function listUsers(ctx: HandlerContext, query: URLSearchParams): HandlerResponse {
  let users = ctx.store.listUsers();
  const rawFilter = query.get("filter");
  // `get` returns "" for a present-but-empty `?filter=` and null when the
  // parameter is absent. Only the second means "no filter": an empty value is
  // a client asking to filter and supplying nothing, and it goes to the parser
  // to be rejected like the whitespace-only filter it is a hair away from.
  if (rawFilter !== null) {
    const clauses = parseUserFilter(rawFilter, ctx.validatorCompat);
    const matchCtx = {
      groupIdsOfUser: (id: string) => ctx.store.groupIdsOfUser(id),
      groupIdsOwnedBy: (id: string) => ctx.store.groupIdsOwnedBy(id),
    };
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
  // mailNickname was required here until Aug 2026; Entra now derives it from
  // userName when it is omitted, null or empty (see deriveMailNickname).
];

/**
 * Entra's documented fallback: everything before the first "@" in userName,
 * or the whole userName when it has none. Fills in the extension (and its
 * schema URN) only when the caller left mailNickname missing, null or empty.
 */
function deriveMailNickname(user: ScimUserCreatePayload): ScimUserCreatePayload {
  if (nonEmpty(user[SCHEMA_ENTRA_USER]?.mailNickname)) return user;
  if (typeof user.userName !== "string" || user.userName.length === 0) return user;
  const at = user.userName.indexOf("@");
  const mailNickname = at === -1 ? user.userName : user.userName.slice(0, at);
  const schemas = Array.isArray(user.schemas) ? user.schemas : [];
  return {
    ...user,
    schemas: schemas.includes(SCHEMA_ENTRA_USER)
      ? schemas
      : [...schemas, SCHEMA_ENTRA_USER],
    [SCHEMA_ENTRA_USER]: { ...user[SCHEMA_ENTRA_USER], mailNickname },
  };
}

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
  const created = ctx.store.createUser(deriveMailNickname(user));
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

/**
 * The same grammar parseFilter accepts — `attr (eq|ew) "value"` joined by
 * `and` — with the Entra attribute allow-list left off.
 *
 * Compat mode exists so an RFC-standard client (the SCIM Validator) can filter
 * on attributes Entra does not permit, such as a plain `displayName` on users.
 * Dropping the allow-list is the whole of that licence; the grammar itself
 * stays as strict as the real parser, so a filter this accepts is one the
 * matcher can honour rather than one it quietly approximates.
 */
export function parsePermissiveFilter(raw: string): ValidatedFilterClause[] {
  const clauses: ValidatedFilterClause[] = [];
  let rest = raw.trim();

  // An empty filter used to return zero clauses, and zero clauses match
  // everything — so `?filter=` listed the entire tenant instead of failing.
  if (rest.length === 0) {
    throw new FilterValidationError("Filter is empty.");
  }

  for (;;) {
    const read = readClause(rest);
    if (read.clause.op !== "eq" && read.clause.op !== "ew") {
      throw new FilterValidationError(`Unparseable filter near: ${rest.slice(0, 40)}`);
    }
    clauses.push(read.clause);

    rest = read.rest;
    if (rest.length === 0) break;

    // A trailing `(and\s+)?` on the clause pattern used to make the joiner
    // optional, so two clauses written side by side with nothing between them
    // were silently read as an `and`.
    const joiner = rest.match(/^(and|or|not)\s+/i);
    if (!joiner) {
      throw new FilterValidationError(
        `Expected 'and' between filter clauses near: ${rest.slice(0, 40)}`,
      );
    }
    if (joiner[1]!.toLowerCase() !== "and") {
      throw new FilterValidationError(
        `Only the 'and' logical operator is supported (Entra SCIM API constraint); got '${joiner[1]}'.`,
      );
    }
    rest = rest.slice(joiner[0].length);
  }

  return clauses;
}

function sanitizeUser(user: StoredUser): Record<string, unknown> {
  const { password: _password, ...rest } = structuredClone(user);
  return rest;
}

const USER_MAX_PAGE_SIZE = 999;

/**
 * Users page at up to 999, but only under an `attributes` projection that
 * leaves out the enterprise manager. Without one, or with manager in it, the
 * API ignores a larger count and serves the default 100.
 */
function pageParams(query: URLSearchParams): PageParams {
  const attributes = query.get("attributes");
  const largePages =
    attributes !== null &&
    attributes.length > 0 &&
    !attributes.split(",").some(projectsManager);
  return {
    count: query.get("count"),
    cursor: query.get("cursor"),
    startIndex: query.get("startIndex"),
    maxPageSize: largePages ? USER_MAX_PAGE_SIZE : DEFAULT_PAGE_SIZE,
  };
}

/**
 * Does this projection entry return manager? The leaf (`...:manager`, and
 * sub-paths such as `...:manager.value`) does, and so does the bare
 * enterprise URN, which the projector treats as the whole extension.
 */
function projectsManager(entry: string): boolean {
  const path = parseAttrPath(entry);
  if (path.urn !== SCHEMA_ENTERPRISE_USER) return false;
  return path.segments.length === 0 || path.segments[0]!.toLowerCase() === "manager";
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
