import { FilterValidationError } from "../scim/errors.js";
import {
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
 * Parse the restricted Entra filter grammar — `attr (eq|ew) "value"` clauses
 * joined by `and` only — and validate each clause against the same allow-lists
 * the client-side builder uses. Throws FilterValidationError on anything the
 * real API would reject with 400 invalidFilter.
 */
export function parseFilter(
  raw: string,
  kind: "user" | "group",
): ValidatedFilterClause[] {
  const clauses: FilterClause[] = [];
  let rest = raw.trim();
  if (rest.length === 0) {
    throw new FilterValidationError("Filter is empty.");
  }
  const clausePattern = /^(\S+)\s+(\S+)\s+"((?:[^"\\]|\\.)*)"/;
  while (true) {
    const match = rest.match(clausePattern);
    if (!match) {
      throw new FilterValidationError(
        `Unparseable filter near: ${rest.slice(0, 40)}`,
      );
    }
    clauses.push({
      attr: match[1]!,
      op: match[2]!.toLowerCase() as FilterClause["op"],
      value: unescapeQuotes(match[3]!),
    });
    rest = rest.slice(match[0].length).trimStart();
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
  return validateFilterClauses(clauses, kind);
}

export interface UserMatchContext {
  /** Direct group memberships, for groups.value clauses. */
  groupIdsOfUser(userId: string): string[];
}

export function userMatches(
  user: StoredUser,
  clauses: ValidatedFilterClause[],
  ctx: UserMatchContext,
): boolean {
  return clauses.every((clause) => {
    const attr = clause.attr;
    if (attr.toLowerCase() === "groups.value") {
      return ctx
        .groupIdsOfUser(user.id)
        .some((gid) => equalsCi(gid, clause.value));
    }
    return compare(resolveAttrValue(user, attr), clause);
  });
}

export function groupMatches(
  group: StoredGroup,
  clauses: ValidatedFilterClause[],
): boolean {
  return clauses.every((clause) => {
    if (clause.attr.toLowerCase() === "members.value") {
      return group.members.some((m) => equalsCi(m.value, clause.value));
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

function compare(
  actual: string | undefined,
  clause: ValidatedFilterClause,
): boolean {
  if (typeof actual !== "string") return false;
  if (clause.op === "eq") return equalsCi(actual, clause.value);
  return actual.toLowerCase().endsWith(clause.value.toLowerCase());
}

function equalsCi(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function unescapeQuotes(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}
