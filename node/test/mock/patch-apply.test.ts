import { describe, it, expect } from "vitest";
import { applyGroupPatch, applyUserPatch } from "../../src/mock/patch-apply.js";
import { MockScimError } from "../../src/mock/errors.js";
import { MockStore } from "../../src/mock/store.js";
import { PatchValidationError } from "../../src/scim/errors.js";
import {
  SCHEMA_ENTERPRISE_USER,
  SCHEMA_ENTRA_CSA,
  SCHEMA_ENTRA_GROUP,
  SCHEMA_ENTRA_USER,
  SCHEMA_GROUP_CORE,
  SCHEMA_PATCH_OP,
  SCHEMA_USER_CORE,
  type ScimPatchOperation,
} from "../../src/scim/types.js";
import type { StoredUser } from "../../src/mock/store.js";

function patch(ops: ScimPatchOperation[]): unknown {
  return { schemas: [SCHEMA_PATCH_OP], Operations: ops };
}

function makeUser(): StoredUser {
  return {
    schemas: [SCHEMA_USER_CORE],
    id: "u-1",
    userName: "a@x.com",
    displayName: "A",
    active: true,
    name: { givenName: "A", familyName: "X" },
    addresses: [{ type: "work", locality: "Sydney" }],
    emails: [{ value: "a@x.com", type: "work", primary: true }],
    [SCHEMA_ENTRA_USER]: { mailNickname: "a" },
  };
}

describe("applyUserPatch", () => {
  it("replaces a simple attribute", () => {
    const updated = applyUserPatch(makeUser(), patch([
      { op: "replace", path: "displayName", value: "New" },
    ]));
    expect(updated.displayName).toBe("New");
  });

  it("replaces a nested attribute (name.givenName)", () => {
    const updated = applyUserPatch(makeUser(), patch([
      { op: "replace", path: "name.givenName", value: "Zed" },
    ]));
    expect(updated.name?.givenName).toBe("Zed");
    expect(updated.name?.familyName).toBe("X");
  });

  it("replaces via a core-URN-qualified path with an object value", () => {
    const updated = applyUserPatch(makeUser(), patch([
      {
        op: "replace",
        path: `${SCHEMA_USER_CORE}:name`,
        value: { givenName: "Jane", familyName: "Doe" },
      },
    ]));
    expect(updated.name).toEqual({ givenName: "Jane", familyName: "Doe" });
  });

  it("updates the Entra extension via URN path", () => {
    const updated = applyUserPatch(makeUser(), patch([
      { op: "replace", path: `${SCHEMA_ENTRA_USER}:mailNickname`, value: "nn" },
    ]));
    expect(updated[SCHEMA_ENTRA_USER]?.mailNickname).toBe("nn");
  });

  it("creates the enterprise extension when patched into existence", () => {
    const updated = applyUserPatch(makeUser(), patch([
      {
        op: "replace",
        path: `${SCHEMA_ENTERPRISE_USER}:manager`,
        value: { value: "u-9" },
      },
    ]));
    expect(updated[SCHEMA_ENTERPRISE_USER]?.manager).toEqual({ value: "u-9" });
  });

  it("sets custom security attributes via Set.Attr path", () => {
    const updated = applyUserPatch(makeUser(), patch([
      {
        op: "add",
        path: `${SCHEMA_ENTRA_CSA}:Project.ProjectName`,
        value: "IdentityHubV2",
      },
    ]));
    expect(updated[SCHEMA_ENTRA_CSA]).toEqual({
      Project: { ProjectName: "IdentityHubV2" },
    });
  });

  it("updates the work address through the filtered path", () => {
    const updated = applyUserPatch(makeUser(), patch([
      {
        op: "replace",
        path: 'addresses[type eq "work"]',
        value: { locality: "Melbourne" },
      },
    ]));
    expect(updated.addresses?.[0]).toMatchObject({
      type: "work",
      locality: "Melbourne",
    });
  });

  it("updates a sub-attribute through a multi-condition filter", () => {
    const updated = applyUserPatch(makeUser(), patch([
      {
        op: "replace",
        path: 'emails[type eq "work" and primary eq true].value',
        value: "new@x.com",
      },
    ]));
    expect(updated.emails?.[0]?.value).toBe("new@x.com");
  });

  it("throws noTarget when replacing a filtered element with no match", () => {
    const user = makeUser();
    user.addresses = [];
    const err = captureError(() =>
      applyUserPatch(user, patch([
        {
          op: "replace",
          path: 'addresses[type eq "work"]',
          value: { locality: "Melbourne" },
        },
      ])),
    );
    expect(err).toBeInstanceOf(MockScimError);
    expect((err as MockScimError).scimType).toBe("noTarget");
  });

  it("applies path-less merges attribute-by-attribute", () => {
    const updated = applyUserPatch(makeUser(), patch([
      {
        op: "replace",
        value: {
          displayName: "Merged",
          [SCHEMA_ENTRA_USER]: { userType: "Member" },
        },
      },
    ]));
    expect(updated.displayName).toBe("Merged");
    expect(updated[SCHEMA_ENTRA_USER]?.userType).toBe("Member");
  });

  it("removes an attribute", () => {
    const updated = applyUserPatch(makeUser(), patch([
      { op: "remove", path: "displayName" },
    ]));
    expect(updated.displayName).toBeUndefined();
  });

  it("still enforces the user PATCH rules", () => {
    expect(() =>
      applyUserPatch(makeUser(), patch([{ op: "remove", path: "mailNickname" }])),
    ).toThrow(PatchValidationError);
  });
});

describe("applyGroupPatch", () => {
  function setup() {
    const store = new MockStore();
    const u1 = store.createUser({ schemas: [SCHEMA_USER_CORE], userName: "a@x.com" });
    const u2 = store.createUser({ schemas: [SCHEMA_USER_CORE], userName: "b@x.com" });
    const group = store.createGroup({
      schemas: [SCHEMA_GROUP_CORE],
      displayName: "G",
      [SCHEMA_ENTRA_GROUP]: { description: "old" },
    });
    return { store, u1, u2, group };
  }

  it("applies attribute patches", () => {
    const { store, group } = setup();
    applyGroupPatch(group, patch([
      { op: "replace", path: "displayName", value: "New" },
      {
        op: "replace",
        path: `${SCHEMA_ENTRA_GROUP}:description`,
        value: "new desc",
      },
    ]), store);
    const stored = store.getGroup(group.id)!;
    expect(stored.displayName).toBe("New");
    expect(stored[SCHEMA_ENTRA_GROUP]?.description).toBe("new desc");
  });

  it("routes member adds through the store", () => {
    const { store, group, u1, u2 } = setup();
    applyGroupPatch(group, patch([
      { op: "add", path: "members", value: [{ value: u1.id }, { value: u2.id }] },
    ]), store);
    expect(store.getGroup(group.id)?.members).toHaveLength(2);
  });

  it("routes single-member removes through the store", () => {
    const { store, group, u1 } = setup();
    store.addGroupMembers(group.id, [u1.id]);
    applyGroupPatch(group, patch([
      { op: "remove", path: `members[value eq "${u1.id}"]` },
    ]), store);
    expect(store.getGroup(group.id)?.members).toHaveLength(0);
  });

  it("rejects membership mixed with attribute changes", () => {
    const { store, group, u1 } = setup();
    expect(() =>
      applyGroupPatch(group, patch([
        { op: "add", path: "members", value: [{ value: u1.id }] },
        { op: "replace", path: "displayName", value: "New" },
      ]), store),
    ).toThrow(PatchValidationError);
  });
});

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}
