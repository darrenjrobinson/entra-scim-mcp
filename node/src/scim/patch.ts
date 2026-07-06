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

function validateUserOperation(
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

function assertAddressFilterShape(path: string, idx: number): void {
  if (!path.toLowerCase().includes("addresses[")) return;
  const match = path.match(/addresses\[([^\]]+)\]/i);
  if (!match) return;
  const filter = match[1]!.trim().toLowerCase();
  if (filter !== 'type eq "work"') {
    throw new PatchValidationError(
      `Operation ${idx}: addresses path filter must be exactly [type eq "work"] (Entra SCIM API constraint).`,
    );
  }
}

function touchesMembers(op: ScimPatchOperation): boolean {
  if (op?.path) {
    return /(^|[^a-zA-Z])members(\b|\[|\.)/i.test(op.path);
  }
  // A path-less add/replace applies its value object attribute-by-attribute,
  // so a "members" key in the value modifies membership just like path: "members".
  if (op?.value && typeof op.value === "object" && !Array.isArray(op.value)) {
    return Object.keys(op.value).some((key) => key.toLowerCase() === "members");
  }
  return false;
}

function targetsCsa(op: ScimPatchOperation): boolean {
  const urn = SCHEMA_ENTRA_CSA.toLowerCase();
  if (op.path) {
    const lower = op.path.toLowerCase();
    return lower === urn || lower.startsWith(`${urn}:`) || lower.startsWith(`${urn}.`);
  }
  // A path-less op is acceptable only when every key in its value object is
  // the CSA extension URN, so the op cannot reach other user attributes.
  if (op.value && typeof op.value === "object" && !Array.isArray(op.value)) {
    const keys = Object.keys(op.value);
    return keys.length > 0 && keys.every((key) => key.toLowerCase() === urn);
  }
  return false;
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
