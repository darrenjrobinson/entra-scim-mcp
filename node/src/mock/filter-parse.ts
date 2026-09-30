import { FilterValidationError } from "../scim/errors.js";
import {
  isBooleanFilterAttr,
  validateFilterClauses,
  type FilterClause,
  type ValidatedFilterClause,
} from "../scim/filter.js";
import {
  SCHEMA_ENTERPRISE_USER,
  SCHEMA_ENTRA_CSA,
  SCHEMA_ENTRA_GROUP,
  SCHEMA_ENTRA_USER,
  SCHEMA_GROUP_CORE,
  SCHEMA_USER_CORE,
} from "../scim/types.js";
import type { StoredGroup, StoredUser } from "./store.js";

const KNOWN_URNS = [
  SCHEMA_ENTERPRISE_USER,
  SCHEMA_ENTRA_USER,
  SCHEMA_ENTRA_CSA,
  SCHEMA_ENTRA_GROUP,
  SCHEMA_USER_CORE,
  SCHEMA_GROUP_CORE,
];

/**
 * One clause: `attr op "value"`, or `attr op true|false` for booleans, either
 * optionally wrapped as `not(...)`. Group 1 is the not( opener, 2 the attr,
 * 3 the op, 4 a quoted value, 5 a bare boolean.
 */
const CLAUSE_PATTERN =
  /^(not\s*\(\s*)?(\S+?)\s+(\S+)\s+(?:"((?:[^"\\]|\\.)*)"|(true|false)\b)/i;

/**
 * Read the clause at the start of `rest`, returning it and the unread tail.
 * Shared with the validator-compat permissive parser so both accept the same
 * grammar; only the allow-list check differs.
 */
export function readClause(rest: string): {
  clause: FilterClause;
  /** True when the value was a bare boolean rather than a quoted string. */
  bare: boolean;
  rest: string;
} {
  const match = rest.match(CLAUSE_PATTERN);
  if (!match) {
    throw new FilterValidationError(`Unparseable filter near: ${rest.slice(0, 40)}`);
  }
  let tail = rest.slice(match[0].length);
  const negated = match[1] !== undefined;
  if (negated) {
    const close = tail.match(/^\s*\)/);
    if (!close) {
      throw new FilterValidationError(`Unclosed not( near: ${rest.slice(0, 40)}`);
    }
    tail = tail.slice(close[0].length);
  }
  const clause: FilterClause = {
    attr: match[2]!,
    op: match[3]!.toLowerCase() as FilterClause["op"],
    value: match[4] !== undefined ? unescapeQuotes(match[4]) : match[5]!,
  };
  if (negated) clause.not = true;
  return { clause, bare: match[4] === undefined, rest: tail.trimStart() };
}

/**
 * Parse the restricted Entra filter grammar — `attr (eq|ew) "value"` clauses,
 * bare booleans, `not(...)` around a clause, joined by `and` only — and
 * validate each clause against the same allow-lists the client-side builder
 * uses. Throws FilterValidationError on anything the real API would reject
 * with 400 invalidFilter.
 */
export function parseFilter(
  raw: string,
  kind: "user" | "group",
): ValidatedFilterClause[] {
  const clauses: FilterClause[] = [];
  const bare: boolean[] = [];
  let rest = raw.trim();
  if (rest.length === 0) {
    throw new FilterValidationError("Filter is empty.");
  }
  while (true) {
    const read = readClause(rest);
    clauses.push(read.clause);
    bare.push(read.bare);
    rest = read.rest;
    if (rest.length === 0) break;
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
  const validated = validateFilterClauses(clauses, kind);
  validated.forEach((clause, i) => {
    if (bare[i] && !isBooleanFilterAttr(clause.attr)) {
      throw new FilterValidationError(
        `Filter value for '${clause.attr}' must be a quoted string.`,
      );
    }
  });
  return validated;
}

export interface UserMatchContext {
  /** Direct group memberships, for groups.value clauses. */
  groupIdsOfUser(userId: string): string[];
  /** Groups the user owns, for ownedGroups.value clauses. */
  groupIdsOwnedBy(userId: string): string[];
}

const OWNED_GROUPS_VALUE = `${SCHEMA_ENTRA_USER}:ownedGroups.value`.toLowerCase();
const OWNERS_VALUE = `${SCHEMA_ENTRA_GROUP}:owners.value`.toLowerCase();

export function userMatches(
  user: StoredUser,
  clauses: ValidatedFilterClause[],
  ctx: UserMatchContext,
): boolean {
  return clauses.every((clause) => {
    const attr = clause.attr.toLowerCase();
    if (attr === "groups.value") {
      return ctx.groupIdsOfUser(user.id).some((gid) => equalsCi(gid, clause.value));
    }
    if (attr === OWNED_GROUPS_VALUE) {
      return ctx.groupIdsOwnedBy(user.id).some((gid) => equalsCi(gid, clause.value));
    }
    return compare(resolveAttrValue(user, clause.attr), clause);
  });
}

export function groupMatches(
  group: StoredGroup,
  clauses: ValidatedFilterClause[],
): boolean {
  return clauses.every((clause) => {
    const attr = clause.attr.toLowerCase();
    if (attr === "members.value") {
      return group.members.some((m) => equalsCi(m.value, clause.value));
    }
    if (attr === OWNERS_VALUE) {
      return group.owners.some((o) => equalsCi(o, clause.value));
    }
    return compare(resolveAttrValue(group, clause.attr), clause);
  });
}

/**
 * Resolve a (possibly URN-qualified, possibly dotted) attribute path to a
 * string value, case-insensitively. Also serves the validator-compat mode's
 * permissive filters, so it handles arbitrary paths, not just the allow-list.
 */
function resolveAttrValue(
  resource: Record<string, unknown>,
  attr: string,
): string | undefined {
  let container: unknown = resource;
  let rest = attr;
  const lower = attr.toLowerCase();
  for (const urn of KNOWN_URNS) {
    const u = urn.toLowerCase();
    if (lower === u || lower.startsWith(`${u}:`) || lower.startsWith(`${u}.`)) {
      if (u === SCHEMA_USER_CORE.toLowerCase() || u === SCHEMA_GROUP_CORE.toLowerCase()) {
        rest = attr.slice(urn.length + 1);
      } else {
        container = findValueCi(resource, urn);
        rest = lower === u ? "" : attr.slice(urn.length + 1);
      }
      break;
    }
  }
  for (const segment of rest.split(".").filter(Boolean)) {
    if (!container || typeof container !== "object" || Array.isArray(container)) {
      return undefined;
    }
    container = findValueCi(container as Record<string, unknown>, segment);
  }
  if (typeof container === "string") return container;
  if (typeof container === "boolean" || typeof container === "number") {
    return String(container);
  }
  return undefined;
}

function findValueCi(obj: Record<string, unknown>, name: string): unknown {
  if (name in obj) return obj[name];
  const lower = name.toLowerCase();
  const key = Object.keys(obj).find((k) => k.toLowerCase() === lower);
  return key ? obj[key] : undefined;
}

function compare(actual: string | undefined, clause: ValidatedFilterClause): boolean {
  const hit =
    typeof actual === "string" &&
    (clause.op === "eq"
      ? equalsCi(actual, clause.value)
      : actual.toLowerCase().endsWith(clause.value.toLowerCase()));
  // A missing value does not end with anything, so its negation matches.
  return clause.not ? !hit : hit;
}

function equalsCi(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function unescapeQuotes(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}
