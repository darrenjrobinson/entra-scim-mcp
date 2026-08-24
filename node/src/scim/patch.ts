import { PatchValidationError } from "./errors.js";
import {
  SCHEMA_ENTRA_CSA,
  SCHEMA_ENTRA_USER,
  SCHEMA_PATCH_OP,
  type ScimPatchBody,
  type ScimPatchOperation,
} from "./types.js";

export const GROUP_MEMBER_ADD_CHUNK_SIZE = 20;

const MAILNICKNAME_PATH_FRAGMENTS = [
  "mailnickname",
  `${SCHEMA_ENTRA_USER.toLowerCase()}:mailnickname`,
];

export function buildUserPatch(operations: ScimPatchOperation[]): ScimPatchBody {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new PatchValidationError("At least one PATCH operation is required.");
  }
  const validated = operations.map((op, idx) => validateUserOperation(op, idx));
  return scimPatch(validated);
}

export function buildGroupAttributePatch(
  operations: ScimPatchOperation[],
): ScimPatchBody {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new PatchValidationError("At least one PATCH operation is required.");
  }
  for (const [idx, op] of operations.entries()) {
    if (touchesMembers(op)) {
      throw new PatchValidationError(
        `Operation ${idx}: group membership cannot be modified through update_group; use add_group_members or remove_group_member.`,
      );
    }
  }
  return scimPatch(operations);
}

export function buildCsaPatch(operations: ScimPatchOperation[]): ScimPatchBody {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new PatchValidationError("At least one PATCH operation is required.");
  }
  for (const [idx, op] of operations.entries()) {
    if (!op || typeof op !== "object") {
      throw new PatchValidationError(`Operation ${idx} is not an object.`);
    }
    if (op.op !== "add" && op.op !== "remove" && op.op !== "replace") {
      throw new PatchValidationError(
        `Operation ${idx} has invalid op '${String(op.op)}'.`,
      );
    }
    if (!targetsCsa(op)) {
      throw new PatchValidationError(
        `Operation ${idx} must target the CustomSecurityAttributes extension (path starting with "${SCHEMA_ENTRA_CSA}"); use update_user for other attributes.`,
      );
    }
  }
  return scimPatch(operations);
}

export function buildAddGroupMemberPatches(
  memberIds: string[],
  chunkSize: number = GROUP_MEMBER_ADD_CHUNK_SIZE,
): ScimPatchBody[] {
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    throw new PatchValidationError("memberIds must be a non-empty array.");
  }
  if (chunkSize < 1 || chunkSize > GROUP_MEMBER_ADD_CHUNK_SIZE) {
    throw new PatchValidationError(
      `chunkSize must be between 1 and ${GROUP_MEMBER_ADD_CHUNK_SIZE} (Entra SCIM API caps batch adds at ${GROUP_MEMBER_ADD_CHUNK_SIZE}).`,
    );
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const id of memberIds) {
    const trimmed = String(id ?? "").trim();
    if (!trimmed) {
      throw new PatchValidationError("memberIds contains an empty value.");
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      cleaned.push(trimmed);
    }
  }

  const bodies: ScimPatchBody[] = [];
  for (let i = 0; i < cleaned.length; i += chunkSize) {
    const slice = cleaned.slice(i, i + chunkSize);
    bodies.push(
      scimPatch([
        {
          op: "add",
          path: "members",
          value: slice.map((id) => ({ value: id })),
        },
      ]),
    );
  }
  return bodies;
}

export function buildRemoveGroupMemberPatch(memberId: string): ScimPatchBody {
  const trimmed = String(memberId ?? "").trim();
  if (!trimmed) {
    throw new PatchValidationError("memberId is required.");
  }
  return scimPatch([
    {
      op: "remove",
      path: `members[value eq "${escapeQuotes(trimmed)}"]`,
    },
  ]);
}

export function validateUserOperation(
  op: ScimPatchOperation,
  idx: number,
): ScimPatchOperation {
  if (!op || typeof op !== "object") {
    throw new PatchValidationError(`Operation ${idx} is not an object.`);
  }
  if (op.op !== "add" && op.op !== "remove" && op.op !== "replace") {
    throw new PatchValidationError(
      `Operation ${idx} has invalid op '${String(op.op)}'.`,
    );
  }
  if (op.op === "remove" && pathTargetsMailNickname(op.path)) {
    throw new PatchValidationError(
      "mailNickname cannot be removed via PATCH (Entra SCIM API constraint).",
    );
  }
  if ((op.op === "add" || op.op === "replace") && nullsOutMailNickname(op)) {
    throw new PatchValidationError(
      "mailNickname cannot be removed via PATCH (Entra SCIM API constraint); setting it to null is a removal.",
    );
  }
  if (op.path) {
    assertAddressFilterShape(op.path, idx);
  }
  return op;
}

function pathTargetsMailNickname(path: string | undefined): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  return MAILNICKNAME_PATH_FRAGMENTS.some((frag) => lower.endsWith(frag));
}

function nullsOutMailNickname(op: ScimPatchOperation): boolean {
  if (op.path) {
    return pathTargetsMailNickname(op.path) && op.value === null;
  }
  if (!op.value || typeof op.value !== "object" || Array.isArray(op.value)) {
    return false;
  }
  for (const [key, value] of Object.entries(op.value)) {
    if (pathTargetsMailNickname(key) && value === null) return true;
    // Nested extension object: { "urn:...:Entra:2.0:User": { mailNickname: null } }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [subKey, subValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (subKey.toLowerCase() === "mailnickname" && subValue === null) {
          return true;
        }
      }
    }
  }
  return false;
}

function assertAddressFilterShape(path: string, idx: number): void {
  if (!path.toLowerCase().includes("addresses[")) return;
  const match = path.match(/addresses\[([^\]]+)\]/i);
  if (!match) return;
  // Attribute name and operator are case-insensitive per SCIM, but the value
  // literal is what the API matches — it must be exactly "work".
  const filterMatch = match[1]!.trim().match(/^type\s+eq\s+"(.*)"$/i);
  if (!filterMatch || filterMatch[1] !== "work") {
    throw new PatchValidationError(
      `Operation ${idx}: addresses path filter must be exactly [type eq "work"] (Entra SCIM API constraint).`,
    );
  }
}

const MEMBERS_ATTR_PATTERN = /(^|[^a-zA-Z])members(\b|\[|\.)/i;

export function touchesMembers(op: ScimPatchOperation): boolean {
  if (op?.path) {
    return MEMBERS_ATTR_PATTERN.test(op.path);
  }
  // A path-less add/replace applies its value object attribute-by-attribute,
  // so a "members" key in the value modifies membership just like path: "members".
  // Keys may be URN-qualified (RFC 7644 §3.5.2.1), e.g.
  // "urn:ietf:params:scim:schemas:core:2.0:Group:members" — match with the
  // same pattern used for paths.
  if (op?.value && typeof op.value === "object" && !Array.isArray(op.value)) {
    return Object.keys(op.value).some((key) => MEMBERS_ATTR_PATTERN.test(key));
  }
  return false;
}

function targetsCsa(op: ScimPatchOperation): boolean {
  const urn = SCHEMA_ENTRA_CSA.toLowerCase();
  if (op.path) {
    const lower = op.path.toLowerCase();
    return lower === urn || lower.startsWith(`${urn}:`) || lower.startsWith(`${urn}.`);
  }
  // A path-less op is acceptable only when every key in its value object
  // targets the CSA extension — either the bare URN or a URN-qualified
  // sub-attribute (RFC 7644 allows fully qualified names in value objects) —
  // so the op cannot reach other user attributes.
  if (op.value && typeof op.value === "object" && !Array.isArray(op.value)) {
    const keys = Object.keys(op.value);
    return (
      keys.length > 0 &&
      keys.every((key) => {
        const lower = key.toLowerCase();
        return (
          lower === urn ||
          lower.startsWith(`${urn}:`) ||
          lower.startsWith(`${urn}.`)
        );
      })
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Whole-body validation of *incoming* PATCH payloads. Used by the mock server
// so it enforces exactly the constraints the client-side builders above
// guarantee on outgoing requests — one source of truth for the API's rules.
// ---------------------------------------------------------------------------

/** Validate a parsed PATCH body against the user PATCH constraints. */
export function validateUserPatchBody(body: unknown): ScimPatchOperation[] {
  const ops = parsePatchEnvelope(body);
  ops.forEach((op, idx) => validateUserOperation(op, idx));
  return ops;
}

/**
 * Validate a parsed PATCH body against the group PATCH constraints:
 * membership changes must be the only operation in the call, adds are capped
 * at 20 members per PATCH, and removals must name exactly one member.
 */
export function validateGroupPatchBody(body: unknown): ScimPatchOperation[] {
  const ops = parsePatchEnvelope(body);
  for (const [idx, op] of ops.entries()) {
    if (!op || typeof op !== "object") {
      throw new PatchValidationError(`Operation ${idx} is not an object.`);
    }
    if (op.op !== "add" && op.op !== "remove" && op.op !== "replace") {
      throw new PatchValidationError(
        `Operation ${idx} has invalid op '${String(op.op)}'.`,
      );
    }
  }

  const memberOps = ops.filter((op) => touchesMembers(op));
  if (memberOps.length === 0) return ops;

  if (ops.length > 1) {
    throw new PatchValidationError(
      "Group membership changes must be the only operation in a PATCH call (Entra SCIM API constraint).",
    );
  }
  const op = memberOps[0]!;
  if (op.op === "remove") {
    const path = op.path ?? "";
    if (!/^members\[value eq "(?:[^"\\]|\\.)+"\]$/i.test(path.trim())) {
      throw new PatchValidationError(
        'Member removal must use the members[value eq "<userId>"] path form, one member per PATCH (Entra SCIM API constraint).',
      );
    }
    return ops;
  }
  if (op.op === "replace") {
    throw new PatchValidationError(
      "Group membership supports only 'add' and 'remove' operations (Entra SCIM API constraint).",
    );
  }
  const members = memberAddValues(op);
  if (!Array.isArray(members) || members.length === 0) {
    throw new PatchValidationError(
      "Membership 'add' requires a non-empty array of { value: <userId> } entries.",
    );
  }
  if (members.length > GROUP_MEMBER_ADD_CHUNK_SIZE) {
    throw new PatchValidationError(
      `At most ${GROUP_MEMBER_ADD_CHUNK_SIZE} members can be added per PATCH call (Entra SCIM API constraint).`,
    );
  }
  return ops;
}

function memberAddValues(op: ScimPatchOperation): unknown {
  if (op.path) return op.value;
  // Path-less add: the members array sits under a (possibly URN-qualified)
  // "members" key in the value object.
  if (op.value && typeof op.value === "object" && !Array.isArray(op.value)) {
    for (const [key, value] of Object.entries(op.value)) {
      if (MEMBERS_ATTR_PATTERN.test(key)) return value;
    }
  }
  return op.value;
}

/**
 * RFC-level envelope parse with none of the Entra-specific operation guards.
 * Exported for the mock's validator-compat mode, which must accept standard
 * SCIM PATCH shapes (e.g. `addresses[primary eq true].locality`) that the real
 * inbound API rejects.
 */
export function parsePatchEnvelopeOnly(body: unknown): ScimPatchOperation[] {
  return parsePatchEnvelope(body);
}

function parsePatchEnvelope(body: unknown): ScimPatchOperation[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PatchValidationError("PATCH body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const schemas = record.schemas;
  if (
    !Array.isArray(schemas) ||
    !schemas.some(
      (s) => typeof s === "string" && s.toLowerCase() === SCHEMA_PATCH_OP.toLowerCase(),
    )
  ) {
    throw new PatchValidationError(
      `PATCH body schemas must include ${SCHEMA_PATCH_OP}.`,
    );
  }
  // The documented examples use both "Operations" and "operations".
  const rawOps = record.Operations ?? record.operations;
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    throw new PatchValidationError(
      "PATCH body must contain a non-empty Operations array.",
    );
  }
  return rawOps as ScimPatchOperation[];
}

function scimPatch(operations: ScimPatchOperation[]): ScimPatchBody {
  return {
    schemas: [SCHEMA_PATCH_OP],
    Operations: operations,
  };
}

function escapeQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
