import { PatchValidationError } from "../scim/errors.js";
import {
  parsePatchEnvelopeOnly,
  touchesMembers,
  validateGroupPatchBody,
  validateUserPatchBody,
} from "../scim/patch.js";
import {
  SCHEMA_ENTERPRISE_USER,
  SCHEMA_ENTRA_CSA,
  SCHEMA_ENTRA_GROUP,
  SCHEMA_ENTRA_USER,
  SCHEMA_GROUP_CORE,
  SCHEMA_USER_CORE,
  type ScimPatchOperation,
} from "../scim/types.js";
import { MockScimError } from "./errors.js";
import type { MockStore, StoredGroup, StoredUser } from "./store.js";

const USER_URNS = [SCHEMA_ENTERPRISE_USER, SCHEMA_ENTRA_USER, SCHEMA_ENTRA_CSA];
const GROUP_URNS = [SCHEMA_ENTRA_GROUP];
const USER_CORE_URNS = [SCHEMA_USER_CORE];
const GROUP_CORE_URNS = [SCHEMA_GROUP_CORE];

/**
 * Validate and apply a user PATCH body, returning the updated copy. The
 * caller persists it (store.putUser re-checks userName uniqueness).
 */
export function applyUserPatch(
  user: StoredUser,
  body: unknown,
  validatorCompat = false,
): StoredUser {
  // The Entra operation guards (addresses must use [type eq "work"], no
  // mailNickname removal) are not RFC rules. The SCIM Validator sends standard
  // shapes like addresses[primary eq true].locality, so compat mode parses the
  // envelope without them.
  const ops = validatorCompat
    ? parsePatchEnvelopeOnly(body)
    : validateUserPatchBody(body);
  const updated = structuredClone(user);
  for (const op of ops) {
    applyOperation(updated, op, USER_URNS, USER_CORE_URNS);
  }
  if (validatorCompat) normalizeManager(updated);
  dropEmptyCsaValues(updated);
  return updated;
}

/**
 * Verified on a live tenant 2026-08-24: replacing a multi-valued custom
 * security attribute with `[]` removes the assignment — a follow-up read does
 * not return the attribute at all, rather than returning an empty array. Match
 * that, or the mock reports a cleared attribute as present-but-empty.
 */
function dropEmptyCsaValues(user: StoredUser): void {
  const csa = user[SCHEMA_ENTRA_CSA];
  if (!csa || typeof csa !== "object") return;
  for (const [setName, set] of Object.entries(csa)) {
    if (!set || typeof set !== "object") continue;
    const values = set as Record<string, unknown>;
    for (const [attr, value] of Object.entries(values)) {
      if (Array.isArray(value) && value.length === 0) delete values[attr];
    }
    if (Object.keys(values).length === 0) delete csa[setName];
  }
}

/**
 * RFC 7643 models enterprise `manager` as complex with a `value` sub-attribute,
 * and the SCIM Validator PATCHes it as a bare id string then asserts
 * `manager.value` on read-back. Normalise so the round trip holds. An empty
 * string is the validator's "remove manager" form and is left untouched.
 */
function normalizeManager(user: StoredUser): void {
  const ext = user[SCHEMA_ENTERPRISE_USER] as { manager?: unknown } | undefined;
  if (!ext || typeof ext !== "object") return;
  if (typeof ext.manager === "string" && ext.manager.length > 0) {
    ext.manager = { value: ext.manager };
  }
}

/**
 * Validate and apply a group PATCH body. Membership operations go through the
 * store (idempotent add / whole-op failure semantics); attribute operations
 * are applied and persisted via putGroup.
 */
export function applyGroupPatch(
  group: StoredGroup,
  body: unknown,
  store: MockStore,
): void {
  const ops = validateGroupPatchBody(body);
  const memberOp = ops.find((op) => touchesMembers(op));
  if (memberOp) {
    // validateGroupPatchBody guarantees a membership op is the only op.
    if (memberOp.op === "add") {
      store.addGroupMembers(group.id, extractMemberIds(memberOp));
    } else {
      store.removeGroupMember(group.id, memberIdFromRemovePath(memberOp.path!));
    }
    return;
  }
  const updated = structuredClone(group);
  for (const op of ops) {
    applyOperation(updated, op, GROUP_URNS, GROUP_CORE_URNS);
  }
  store.putGroup(updated);
}

// ---------------------------------------------------------------------------
// Membership helpers
// ---------------------------------------------------------------------------

function extractMemberIds(op: ScimPatchOperation): string[] {
  let raw = op.value;
  if (!op.path && raw && typeof raw === "object" && !Array.isArray(raw)) {
    // Path-less add: members array under a (possibly URN-qualified) key.
    const entry = Object.entries(raw).find(([key]) =>
      /(^|[^a-zA-Z])members(\b|\[|\.)/i.test(key),
    );
    raw = entry?.[1];
  }
  if (!Array.isArray(raw)) {
    throw new PatchValidationError(
      "Membership 'add' requires an array of { value: <userId> } entries.",
    );
  }
  return raw.map((entry, idx) => {
    const value =
      entry && typeof entry === "object"
        ? (entry as { value?: unknown }).value
        : undefined;
    if (typeof value !== "string" || value.length === 0) {
      throw new PatchValidationError(`Member entry ${idx} is missing a string 'value'.`);
    }
    return value;
  });
}

function memberIdFromRemovePath(path: string): string {
  const match = path.trim().match(/^members\[value eq "((?:[^"\\]|\\.)+)"\]$/i);
  if (!match) {
    throw new PatchValidationError(
      'Member removal must use the members[value eq "<userId>"] path form.',
    );
  }
  return match[1]!.replace(/\\(["\\])/g, "$1");
}

// ---------------------------------------------------------------------------
// Generic SCIM path application
// ---------------------------------------------------------------------------

interface PathSegment {
  name: string;
  filter?: FilterCondition[];
}

interface FilterCondition {
  field: string;
  value: string | boolean;
}

function applyOperation(
  target: Record<string, unknown>,
  op: ScimPatchOperation,
  extensionUrns: string[],
  coreUrns: string[],
): void {
  if (!op.path) {
    applyPathlessOperation(target, op, extensionUrns, coreUrns);
    return;
  }

  const { container, rest } = resolveContainer(
    target,
    op.path,
    extensionUrns,
    coreUrns,
    op.op !== "remove",
  );

  if (rest === "") {
    // The path was exactly an extension URN.
    const urn = matchUrn(op.path, extensionUrns);
    if (!urn) {
      throw new MockScimError(400, `Unsupported path: ${op.path}`, "invalidPath");
    }
    const key = resolveKey(target, urn) ?? urn;
    if (op.op === "remove") {
      delete target[key];
    } else if (op.value && typeof op.value === "object" && !Array.isArray(op.value)) {
      const existing = target[key];
      target[key] =
        op.op === "add" && existing && typeof existing === "object"
          ? {
              ...(existing as Record<string, unknown>),
              ...(op.value as Record<string, unknown>),
            }
          : op.value;
    } else {
      throw new MockScimError(
        400,
        `Value for extension path '${op.path}' must be an object.`,
        "invalidValue",
      );
    }
    return;
  }

  if (!container) return; // remove on a missing container: nothing to do

  applySegments(container, parseSegments(rest, op.path), op);
}

function applyPathlessOperation(
  target: Record<string, unknown>,
  op: ScimPatchOperation,
  extensionUrns: string[],
  coreUrns: string[],
): void {
  if (op.op === "remove") {
    throw new MockScimError(400, "'remove' requires a path.", "noTarget");
  }
  if (!op.value || typeof op.value !== "object" || Array.isArray(op.value)) {
    throw new MockScimError(
      400,
      "A path-less operation requires an object value.",
      "invalidValue",
    );
  }
  for (const [key, value] of Object.entries(op.value)) {
    applyOperation(target, { op: op.op, path: key, value }, extensionUrns, coreUrns);
  }
}

/**
 * Resolve a possibly URN-qualified path to its containing object and the
 * remaining attribute path. Creates extension containers on write.
 */
function resolveContainer(
  target: Record<string, unknown>,
  path: string,
  extensionUrns: string[],
  coreUrns: string[],
  createMissing: boolean,
): { container: Record<string, unknown> | undefined; rest: string } {
  const extensionUrn = matchUrn(path, extensionUrns);
  if (extensionUrn) {
    const rest = stripUrnPrefix(path, extensionUrn);
    if (rest === "") return { container: target, rest: "" };
    const key = resolveKey(target, extensionUrn) ?? extensionUrn;
    let container = target[key];
    if (!container || typeof container !== "object") {
      if (!createMissing) return { container: undefined, rest };
      container = {};
      target[key] = container;
    }
    return { container: container as Record<string, unknown>, rest };
  }
  const coreUrn = matchUrn(path, coreUrns);
  if (coreUrn) {
    return { container: target, rest: stripUrnPrefix(path, coreUrn) };
  }
  return { container: target, rest: path };
}

function matchUrn(path: string, urns: string[]): string | undefined {
  const lower = path.toLowerCase();
  return urns.find((urn) => {
    const u = urn.toLowerCase();
    return lower === u || lower.startsWith(`${u}:`) || lower.startsWith(`${u}.`);
  });
}

function stripUrnPrefix(path: string, urn: string): string {
  const rest = path.slice(urn.length);
  return rest.startsWith(":") || rest.startsWith(".") ? rest.slice(1) : rest;
}

function applySegments(
  container: Record<string, unknown>,
  segments: PathSegment[],
  op: ScimPatchOperation,
): void {
  let current = container;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const key = resolveKey(current, seg.name) ?? seg.name;
    if (seg.filter) {
      const element = selectArrayElement(current, key, seg, op);
      if (!element) return; // remove on no match: nothing to do
      current = element;
      continue;
    }
    let next = current[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      if (op.op === "remove") return;
      next = {};
      current[key] = next;
    }
    current = next as Record<string, unknown>;
  }

  const last = segments[segments.length - 1]!;
  const key = resolveKey(current, last.name) ?? last.name;

  if (last.filter) {
    const existing = current[key];
    if (op.op === "remove") {
      if (Array.isArray(existing)) {
        current[key] = existing.filter((el) => !elementMatches(el, last.filter!));
      }
      return;
    }
    const element = selectArrayElement(current, key, last, op);
    if (!element) return;
    if (op.value && typeof op.value === "object" && !Array.isArray(op.value)) {
      Object.assign(element, op.value);
    } else {
      throw new MockScimError(
        400,
        `Value for filtered path '${last.name}[...]' must be an object.`,
        "invalidValue",
      );
    }
    return;
  }

  if (op.op === "remove") {
    delete current[key];
    return;
  }
  if (
    op.op === "add" &&
    current[key] &&
    typeof current[key] === "object" &&
    !Array.isArray(current[key]) &&
    op.value &&
    typeof op.value === "object" &&
    !Array.isArray(op.value)
  ) {
    Object.assign(current[key] as Record<string, unknown>, op.value);
    return;
  }
  current[key] = op.value;
}

/**
 * Select the first array element matching the segment filter. For add (and
 * replace-with-no-match on add semantics) a new element seeded from the
 * filter's string conditions is created; replace/remove with no match returns
 * undefined (RFC 7644 noTarget — the mock treats replace-no-match as 400).
 */
function selectArrayElement(
  parent: Record<string, unknown>,
  key: string,
  seg: PathSegment,
  op: ScimPatchOperation,
): Record<string, unknown> | undefined {
  let array = parent[key];
  if (!Array.isArray(array)) {
    if (op.op === "remove") return undefined;
    array = [];
    parent[key] = array;
  }
  const match = (array as unknown[]).find((el) => elementMatches(el, seg.filter!));
  if (match && typeof match === "object") {
    return match as Record<string, unknown>;
  }
  if (op.op === "add") {
    const created: Record<string, unknown> = {};
    for (const cond of seg.filter!) {
      created[cond.field] = cond.value;
    }
    (array as unknown[]).push(created);
    return created;
  }
  if (op.op === "replace") {
    throw new MockScimError(
      400,
      `No ${seg.name} element matches the path filter.`,
      "noTarget",
    );
  }
  return undefined;
}

function elementMatches(element: unknown, conditions: FilterCondition[]): boolean {
  if (!element || typeof element !== "object") return false;
  const record = element as Record<string, unknown>;
  return conditions.every((cond) => {
    const key = resolveKey(record, cond.field);
    if (!key) return false;
    const actual = record[key];
    if (typeof cond.value === "boolean") {
      // The SCIM Validator writes primary as the string "true" then filters
      // with `primary eq true`, so a strict compare finds no target. JSON
      // values arrive untyped over the wire; match either form.
      if (typeof actual === "string") {
        return actual.toLowerCase() === String(cond.value);
      }
      return actual === cond.value;
    }
    return (
      typeof actual === "string" && actual.toLowerCase() === cond.value.toLowerCase()
    );
  });
}

function parseSegments(rest: string, fullPath: string): PathSegment[] {
  const segments: PathSegment[] = [];
  let remaining = rest;
  // The \[ is redundant inside the character class, but it keeps the pair
  // symmetric with the \] that is required, which reads better in a pattern
  // this dense.
  // eslint-disable-next-line no-useless-escape
  const segPattern = /^([^.\[\]]+)(\[((?:[^"\]]|"(?:[^"\\]|\\.)*")*)\])?/;
  while (remaining.length > 0) {
    const match = remaining.match(segPattern);
    if (!match || match[1]!.length === 0) {
      throw new MockScimError(400, `Unsupported path: ${fullPath}`, "invalidPath");
    }
    const segment: PathSegment = { name: match[1]! };
    if (match[3] !== undefined) {
      segment.filter = parseSegmentFilter(match[3], fullPath);
    }
    segments.push(segment);
    remaining = remaining.slice(match[0].length);
    if (remaining.startsWith(".")) {
      remaining = remaining.slice(1);
      if (remaining.length === 0) {
        throw new MockScimError(400, `Unsupported path: ${fullPath}`, "invalidPath");
      }
    } else if (remaining.length > 0) {
      throw new MockScimError(400, `Unsupported path: ${fullPath}`, "invalidPath");
    }
  }
  if (segments.length === 0) {
    throw new MockScimError(400, `Unsupported path: ${fullPath}`, "invalidPath");
  }
  return segments;
}

function parseSegmentFilter(raw: string, fullPath: string): FilterCondition[] {
  const conditions: FilterCondition[] = [];
  let remaining = raw.trim();
  const condPattern = /^(\w+)\s+eq\s+("(?:[^"\\]|\\.)*"|true|false)/i;
  while (remaining.length > 0) {
    const match = remaining.match(condPattern);
    if (!match) {
      throw new MockScimError(
        400,
        `Unsupported path filter in: ${fullPath}`,
        "invalidPath",
      );
    }
    const rawValue = match[2]!;
    conditions.push({
      field: match[1]!,
      value: rawValue.startsWith('"')
        ? rawValue.slice(1, -1).replace(/\\(["\\])/g, "$1")
        : rawValue.toLowerCase() === "true",
    });
    remaining = remaining.slice(match[0].length).trimStart();
    if (remaining.length === 0) break;
    const joiner = remaining.match(/^and\s+/i);
    if (!joiner) {
      throw new MockScimError(
        400,
        `Unsupported path filter in: ${fullPath}`,
        "invalidPath",
      );
    }
    remaining = remaining.slice(joiner[0].length);
  }
  if (conditions.length === 0) {
    throw new MockScimError(
      400,
      `Unsupported path filter in: ${fullPath}`,
      "invalidPath",
    );
  }
  return conditions;
}

/** Case-insensitive key lookup (SCIM attribute names are case-insensitive). */
function resolveKey(obj: Record<string, unknown>, name: string): string | undefined {
  if (name in obj) return name;
  const lower = name.toLowerCase();
  return Object.keys(obj).find((key) => key.toLowerCase() === lower);
}
