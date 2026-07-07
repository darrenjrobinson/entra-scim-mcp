import { FilterValidationError } from "../scim/errors.js";
import {
  validateFilterClauses,
  type FilterClause,
  type ValidatedFilterClause,
} from "../scim/filter.js";
import { SCHEMA_ENTRA_USER } from "../scim/types.js";
import type { StoredGroup, StoredUser } from "./store.js";

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
    if (attr === "groups.value") {
      return ctx
        .groupIdsOfUser(user.id)
        .some((gid) => equalsCi(gid, clause.value));
    }
    const actual = userAttrValue(user, attr);
    return compare(actual, clause);
  });
}

export function groupMatches(
  group: StoredGroup,
  clauses: ValidatedFilterClause[],
): boolean {
  return clauses.every((clause) => {
    if (clause.attr === "members.value") {
      return group.members.some((m) => equalsCi(m.value, clause.value));
    }
    const actual = group[clause.attr];
    return compare(typeof actual === "string" ? actual : undefined, clause);
  });
}

function userAttrValue(user: StoredUser, canonicalAttr: string): string | undefined {
  if (canonicalAttr === `${SCHEMA_ENTRA_USER}:mailNickname`) {
    const ext = user[SCHEMA_ENTRA_USER];
    return ext && typeof ext === "object"
      ? (ext as { mailNickname?: string }).mailNickname
      : undefined;
  }
  const value = user[canonicalAttr];
  return typeof value === "string" ? value : undefined;
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
