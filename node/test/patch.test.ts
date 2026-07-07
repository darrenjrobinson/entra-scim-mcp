import { describe, it, expect } from "vitest";
import {
  buildAddGroupMemberPatches,
  buildCsaPatch,
  buildGroupAttributePatch,
  buildRemoveGroupMemberPatch,
  buildUserPatch,
  GROUP_MEMBER_ADD_CHUNK_SIZE,
} from "../src/scim/patch.js";
import { PatchValidationError } from "../src/scim/errors.js";
import { SCHEMA_ENTRA_CSA, SCHEMA_PATCH_OP } from "../src/scim/types.js";

describe("buildUserPatch", () => {
  it("wraps operations with PatchOp schema header", () => {
    const body = buildUserPatch([
      { op: "replace", path: "displayName", value: "New Name" },
    ]);
    expect(body.schemas).toEqual([SCHEMA_PATCH_OP]);
    expect(body.Operations).toHaveLength(1);
  });

  it("requires at least one operation", () => {
    expect(() => buildUserPatch([])).toThrow(PatchValidationError);
  });

  it("rejects remove of mailNickname (plain path)", () => {
    expect(() =>
      buildUserPatch([{ op: "remove", path: "mailNickname" }]),
    ).toThrow(PatchValidationError);
  });

  it("rejects remove of mailNickname (extension path)", () => {
    expect(() =>
      buildUserPatch([
        {
          op: "remove",
          path:
            "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:User:mailNickname",
        },
      ]),
    ).toThrow(PatchValidationError);
  });

  it("allows replace of mailNickname", () => {
    const body = buildUserPatch([
      { op: "replace", path: "mailNickname", value: "newnick" },
    ]);
    expect(body.Operations[0]!.op).toBe("replace");
  });

  it("rejects addresses path filter other than [type eq \"work\"]", () => {
    expect(() =>
      buildUserPatch([
        {
          op: "replace",
          path: 'addresses[type eq "home"]',
          value: { streetAddress: "1 Main St" },
        },
      ]),
    ).toThrow(PatchValidationError);
  });

  it("accepts the canonical addresses[type eq \"work\"] filter", () => {
    const body = buildUserPatch([
      {
        op: "replace",
        path: 'addresses[type eq "work"]',
        value: { streetAddress: "1 Main St" },
      },
    ]);
    expect(body.Operations[0]!.path).toBe('addresses[type eq "work"]');
  });

  it('rejects addresses filter with non-canonical value casing ("WORK")', () => {
    expect(() =>
      buildUserPatch([
        {
          op: "replace",
          path: 'addresses[type eq "WORK"]',
          value: { streetAddress: "1 Main St" },
        },
      ]),
    ).toThrow(PatchValidationError);
  });

  it("accepts case variants of the attribute name and operator", () => {
    const body = buildUserPatch([
      {
        op: "replace",
        path: 'addresses[Type EQ "work"]',
        value: { streetAddress: "1 Main St" },
      },
    ]);
    expect(body.Operations).toHaveLength(1);
  });

  it("rejects replace of mailNickname with null (removal-equivalent)", () => {
    expect(() =>
      buildUserPatch([{ op: "replace", path: "mailNickname", value: null }]),
    ).toThrow(PatchValidationError);
  });

  it("rejects a path-less op nulling mailNickname inside the extension object", () => {
    expect(() =>
      buildUserPatch([
        {
          op: "replace",
          value: {
            "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:User": {
              mailNickname: null,
            },
          },
        },
      ]),
    ).toThrow(PatchValidationError);
    expect(() =>
      buildUserPatch([
        {
          op: "add",
          value: {
            "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:User:mailNickname":
              null,
          },
        },
      ]),
    ).toThrow(PatchValidationError);
  });

  it("allows replace of mailNickname with a real value via path-less op", () => {
    const body = buildUserPatch([
      {
        op: "replace",
        value: {
          "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:User": {
            mailNickname: "newnick",
          },
        },
      },
    ]);
    expect(body.Operations).toHaveLength(1);
  });
});

describe("buildAddGroupMemberPatches", () => {
  it("requires non-empty memberIds", () => {
    expect(() => buildAddGroupMemberPatches([])).toThrow(PatchValidationError);
  });

  it("emits a single PATCH for <= 20 members", () => {
    const ids = Array.from({ length: 15 }, (_, i) => `u-${i}`);
    const bodies = buildAddGroupMemberPatches(ids);
    expect(bodies).toHaveLength(1);
    expect((bodies[0]!.Operations[0]!.value as { value: string }[]).length).toBe(15);
    expect(bodies[0]!.Operations).toHaveLength(1);
  });

  it("chunks at the API cap of 20 members per PATCH", () => {
    const ids = Array.from({ length: 45 }, (_, i) => `u-${i}`);
    const bodies = buildAddGroupMemberPatches(ids);
    expect(bodies).toHaveLength(3);
    expect((bodies[0]!.Operations[0]!.value as unknown[]).length).toBe(20);
    expect((bodies[1]!.Operations[0]!.value as unknown[]).length).toBe(20);
    expect((bodies[2]!.Operations[0]!.value as unknown[]).length).toBe(5);
  });

  it("each chunk has exactly one Operations entry (no mixed ops)", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `u-${i}`);
    const bodies = buildAddGroupMemberPatches(ids);
    for (const body of bodies) {
      expect(body.Operations).toHaveLength(1);
      expect(body.Operations[0]!.op).toBe("add");
      expect(body.Operations[0]!.path).toBe("members");
    }
  });

  it("dedupes input member ids", () => {
    const bodies = buildAddGroupMemberPatches(["u-1", "u-1", "u-2"]);
    expect((bodies[0]!.Operations[0]!.value as unknown[]).length).toBe(2);
  });

  it("rejects chunkSize over the API cap", () => {
    expect(() => buildAddGroupMemberPatches(["u-1"], 25)).toThrow(
      PatchValidationError,
    );
  });

  it("never returns a chunk larger than the API cap", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `u-${i}`);
    const bodies = buildAddGroupMemberPatches(ids);
    for (const body of bodies) {
      expect((body.Operations[0]!.value as unknown[]).length).toBeLessThanOrEqual(
        GROUP_MEMBER_ADD_CHUNK_SIZE,
      );
    }
  });
});

describe("buildRemoveGroupMemberPatch", () => {
  it("emits a single remove operation with the [value eq …] filter", () => {
    const body = buildRemoveGroupMemberPatch("u-1");
    expect(body.Operations).toHaveLength(1);
    expect(body.Operations[0]!.op).toBe("remove");
    expect(body.Operations[0]!.path).toBe('members[value eq "u-1"]');
  });

  it("requires a non-empty memberId", () => {
    expect(() => buildRemoveGroupMemberPatch("")).toThrow(PatchValidationError);
    expect(() => buildRemoveGroupMemberPatch("   ")).toThrow(PatchValidationError);
  });

  it("escapes quotes in the member id", () => {
    const body = buildRemoveGroupMemberPatch('u"1');
    expect(body.Operations[0]!.path).toBe('members[value eq "u\\"1"]');
  });
});

describe("buildGroupAttributePatch", () => {
  it("rejects operations that touch members", () => {
    expect(() =>
      buildGroupAttributePatch([
        { op: "add", path: "members", value: [{ value: "u-1" }] },
      ]),
    ).toThrow(PatchValidationError);
  });

  it("allows displayName / description replace", () => {
    const body = buildGroupAttributePatch([
      { op: "replace", path: "displayName", value: "New" },
    ]);
    expect(body.Operations[0]!.path).toBe("displayName");
  });

  it("rejects a path-less op whose value carries members", () => {
    expect(() =>
      buildGroupAttributePatch([
        { op: "replace", value: { members: [{ value: "u-1" }] } },
      ]),
    ).toThrow(PatchValidationError);
    expect(() =>
      buildGroupAttributePatch([
        { op: "add", value: { Members: [{ value: "u-1" }] } },
      ]),
    ).toThrow(PatchValidationError);
  });

  it("rejects a path-less op whose value carries a URN-qualified members key", () => {
    expect(() =>
      buildGroupAttributePatch([
        {
          op: "add",
          value: {
            "urn:ietf:params:scim:schemas:core:2.0:Group:members": [
              { value: "u-1" },
            ],
          },
        },
      ]),
    ).toThrow(PatchValidationError);
  });

  it("allows a path-less op whose value has no members key", () => {
    const body = buildGroupAttributePatch([
      { op: "replace", value: { displayName: "New" } },
    ]);
    expect(body.Operations).toHaveLength(1);
  });
});

describe("buildCsaPatch", () => {
  it("requires at least one operation", () => {
    expect(() => buildCsaPatch([])).toThrow(PatchValidationError);
  });

  it("accepts operations targeting a CSA path", () => {
    const body = buildCsaPatch([
      { op: "replace", path: `${SCHEMA_ENTRA_CSA}:Engineering.Project`, value: "Apollo" },
    ]);
    expect(body.schemas).toEqual([SCHEMA_PATCH_OP]);
    expect(body.Operations).toHaveLength(1);
  });

  it("accepts a path-less op whose value is keyed by the CSA urn", () => {
    const body = buildCsaPatch([
      {
        op: "add",
        value: { [SCHEMA_ENTRA_CSA]: { Engineering: { Project: "Apollo" } } },
      },
    ]);
    expect(body.Operations).toHaveLength(1);
  });

  it("accepts a path-less op keyed by a URN-qualified CSA sub-attribute", () => {
    const body = buildCsaPatch([
      {
        op: "add",
        value: { [`${SCHEMA_ENTRA_CSA}:Project.ProjectName`]: "Apollo" },
      },
    ]);
    expect(body.Operations).toHaveLength(1);
  });

  it("rejects operations targeting non-CSA attributes", () => {
    expect(() =>
      buildCsaPatch([{ op: "remove", path: "mailNickname" }]),
    ).toThrow(PatchValidationError);
    expect(() =>
      buildCsaPatch([{ op: "replace", path: "displayName", value: "x" }]),
    ).toThrow(PatchValidationError);
  });

  it("rejects a path-less op whose value mixes in non-CSA keys", () => {
    expect(() =>
      buildCsaPatch([
        {
          op: "replace",
          value: {
            [SCHEMA_ENTRA_CSA]: { Engineering: { Project: "Apollo" } },
            displayName: "x",
          },
        },
      ]),
    ).toThrow(PatchValidationError);
  });

  it("rejects invalid op names", () => {
    expect(() =>
      buildCsaPatch([
        { op: "merge" as never, path: `${SCHEMA_ENTRA_CSA}:Set.Attr`, value: "x" },
      ]),
    ).toThrow(PatchValidationError);
  });
});
