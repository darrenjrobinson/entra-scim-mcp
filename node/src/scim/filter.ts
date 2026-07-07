import { FilterValidationError } from "./errors.js";
import { SCHEMA_ENTRA_USER, SCHEMA_ENTRA_CSA } from "./types.js";

export type FilterOp = "eq" | "ew";

export interface FilterClause {
  attr: string;
  op: FilterOp;
  value: string;
}

export type FilterInput = FilterClause | FilterClause[];

// Allow-lists derived from the Entra SCIM API constraints documented at
// https://learn.microsoft.com/entra/identity/app-provisioning/entra-id-scim-api-reference.
// Keys are case-insensitive; canonical casing is stored as the value.

const USER_EQ_ATTRS: Record<string, string> = {
  username: "userName",
  externalid: "externalId",
  id: "id",
  "groups.value": "groups.value",
  mailnickname: `${SCHEMA_ENTRA_USER}:mailNickname`,
  [`${SCHEMA_ENTRA_USER.toLowerCase()}:mailnickname`]: `${SCHEMA_ENTRA_USER}:mailNickname`,
};

const USER_EW_ATTRS: Record<string, string> = {
  username: "userName",
  mailnickname: `${SCHEMA_ENTRA_USER}:mailNickname`,
  [`${SCHEMA_ENTRA_USER.toLowerCase()}:mailnickname`]: `${SCHEMA_ENTRA_USER}:mailNickname`,
};

const GROUP_EQ_ATTRS: Record<string, string> = {
  displayname: "displayName",
  id: "id",
  "members.value": "members.value",
};

const GROUP_EW_ATTRS: Record<string, string> = {
  displayname: "displayName",
};

/** A filter clause whose attr has been resolved to the API's canonical casing. */
export interface ValidatedFilterClause {
  /** Canonical attribute name (e.g. "userName", "urn:...:User:mailNickname"). */
  attr: string;
  op: FilterOp;
  value: string;
}

export function buildUserFilter(input: FilterInput | undefined): string | undefined {
  return buildFilter(input, "user");
}

export function buildGroupFilter(input: FilterInput | undefined): string | undefined {
  return buildFilter(input, "group");
}

/**
 * Validate a set of clauses against the Entra SCIM constraints (allow-listed
 * attribute/operator pairs, and-only combining, externalId not combinable)
 * and resolve each attr to its canonical casing. Shared by the client-side
 * filter builder and the mock server's filter parser.
 */
export function validateFilterClauses(
  clauses: FilterClause[],
  kind: "user" | "group",
): ValidatedFilterClause[] {
  if (kind === "user") {
    const usesExternalId = clauses.some(
      (c) => typeof c.attr === "string" && c.attr.toLowerCase() === "externalid",
    );
    if (usesExternalId && clauses.length > 1) {
      throw new FilterValidationError(
        "externalId cannot be combined with other filter clauses (Entra SCIM API constraint).",
      );
    }
  }
  return clauses.map((c) => validateFilterClause(c, kind));
}

/** Validate one clause and resolve its attr to canonical casing. */
export function validateFilterClause(
  clause: FilterClause,
  kind: "user" | "group",
): ValidatedFilterClause {
  if (typeof clause.attr !== "string" || clause.attr.length === 0) {
    throw new FilterValidationError("Filter clause is missing 'attr'.");
  }
  if (typeof clause.value !== "string") {
    throw new FilterValidationError(
      `Filter value for '${clause.attr}' must be a string.`,
    );
  }
  if (clause.op !== "eq" && clause.op !== "ew") {
    throw new FilterValidationError(
      `Unsupported operator '${clause.op}'. Entra SCIM supports only 'eq' and 'ew'.`,
    );
  }
  if (rejectsCustomSecurityAttributesInFilter(clause.attr)) {
    throw new FilterValidationError(
      "Custom Security Attributes cannot be used in filters (Entra SCIM API constraint).",
    );
  }
  const [eqAttrs, ewAttrs] =
    kind === "user" ? [USER_EQ_ATTRS, USER_EW_ATTRS] : [GROUP_EQ_ATTRS, GROUP_EW_ATTRS];
  const lookup = clause.op === "eq" ? eqAttrs : ewAttrs;
  const canonical = lookup[clause.attr.toLowerCase()];
  if (!canonical) {
    throw new FilterValidationError(
      `Attribute '${clause.attr}' is not allowed with operator '${clause.op}' on ${kind} filters.`,
    );
  }
  return { attr: canonical, op: clause.op, value: clause.value };
}

function buildFilter(
  input: FilterInput | undefined,
  kind: "user" | "group",
): string | undefined {
  if (input === undefined) return undefined;
  const clauses = Array.isArray(input) ? input : [input];
  if (clauses.length === 0) return undefined;
  return validateFilterClauses(clauses, kind)
    .map((c) => `${c.attr} ${c.op} "${escapeQuotes(c.value)}"`)
    .join(" and ");
}

function rejectsCustomSecurityAttributesInFilter(attr: string): boolean {
  return attr.toLowerCase().includes(SCHEMA_ENTRA_CSA.toLowerCase());
}

function escapeQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
