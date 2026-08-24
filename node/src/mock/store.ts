import { randomUUID } from "node:crypto";
import type {
  ScimGroup,
  ScimGroupMember,
  ScimUserCreatePayload,
} from "../scim/types.js";
import { MockScimError } from "./errors.js";

/**
 * Held with the password still on it — the store is the write side. Reads go
 * out through sanitizeUser in ./handlers/users.js, which strips it.
 */
export interface StoredUser extends ScimUserCreatePayload {
  id: string;
}

export interface StoredGroup extends ScimGroup {
  id: string;
  /** Kept internally; never returned on reads (Entra constraint). */
  members: ScimGroupMember[];
}

export interface SeedData {
  users?: ScimUserCreatePayload[];
  groups?: ScimGroup[];
}

/**
 * In-memory user/group store with the same integrity rules the real API
 * enforces: case-insensitive userName uniqueness (409), whole-operation
 * failure on invalid member ids, idempotent member adds.
 */
export class MockStore {
  private users = new Map<string, StoredUser>();
  private groups = new Map<string, StoredGroup>();
  /** lowercase userName -> id */
  private userNameIndex = new Map<string, string>();

  // -- users ----------------------------------------------------------------

  createUser(input: ScimUserCreatePayload): StoredUser {
    const userName = input.userName;
    if (typeof userName !== "string" || userName.length === 0) {
      throw new MockScimError(400, "userName is required.", "invalidValue");
    }
    this.assertUserNameFree(userName, undefined);
    const id = randomUUID();
    const now = isoNow();
    const user: StoredUser = {
      ...normalizePrimaryFlags(structuredClone(input)),
      id,
      meta: {
        resourceType: "user",
        created: now,
        lastModified: now,
        location: `/users/${id}`,
      },
    };
    this.users.set(id, user);
    this.userNameIndex.set(userName.toLowerCase(), id);
    return user;
  }

  getUser(id: string): StoredUser | undefined {
    return this.users.get(id);
  }

  listUsers(): StoredUser[] {
    return [...this.users.values()];
  }

  /** Replace a user's record (PATCH result), re-enforcing userName uniqueness. */
  putUser(updated: StoredUser): void {
    const existing = this.users.get(updated.id);
    if (!existing) {
      throw new MockScimError(404, `User '${updated.id}' not found.`);
    }
    const newName = updated.userName;
    if (typeof newName !== "string" || newName.length === 0) {
      throw new MockScimError(400, "userName cannot be removed.", "invalidValue");
    }
    this.assertUserNameFree(newName, updated.id);
    const oldName = existing.userName;
    if (typeof oldName === "string") {
      this.userNameIndex.delete(oldName.toLowerCase());
    }
    updated.meta = {
      ...existing.meta,
      ...updated.meta,
      lastModified: isoNow(),
    };
    this.users.set(updated.id, normalizePrimaryFlags(updated));
    this.userNameIndex.set(newName.toLowerCase(), updated.id);
  }

  deleteUser(id: string): boolean {
    const user = this.users.get(id);
    if (!user) return false;
    this.users.delete(id);
    if (typeof user.userName === "string") {
      this.userNameIndex.delete(user.userName.toLowerCase());
    }
    for (const group of this.groups.values()) {
      group.members = group.members.filter((m) => m.value !== id);
    }
    return true;
  }

  // -- groups ---------------------------------------------------------------

  createGroup(input: ScimGroup): StoredGroup {
    if (typeof input.displayName !== "string" || input.displayName.length === 0) {
      throw new MockScimError(400, "displayName is required.", "invalidValue");
    }
    const id = randomUUID();
    const now = isoNow();
    const { members: _ignored, ...rest } = structuredClone(input);
    const group: StoredGroup = {
      ...rest,
      id,
      members: [],
      meta: {
        resourceType: "group",
        created: now,
        lastModified: now,
        location: `/groups/${id}`,
      },
    };
    this.groups.set(id, group);
    return group;
  }

  getGroup(id: string): StoredGroup | undefined {
    return this.groups.get(id);
  }

  listGroups(): StoredGroup[] {
    return [...this.groups.values()];
  }

  putGroup(updated: StoredGroup): void {
    const existing = this.groups.get(updated.id);
    if (!existing) {
      throw new MockScimError(404, `Group '${updated.id}' not found.`);
    }
    // Membership changes only go through addGroupMembers/removeGroupMember.
    updated.members = existing.members;
    updated.meta = { ...existing.meta, ...updated.meta, lastModified: isoNow() };
    this.groups.set(updated.id, updated);
  }

  deleteGroup(id: string): boolean {
    return this.groups.delete(id);
  }

  /**
   * Idempotent member add. Any invalid member id fails the whole operation
   * with the documented error message.
   */
  addGroupMembers(groupId: string, memberIds: string[]): void {
    const group = this.requireGroup(groupId);
    for (const memberId of memberIds) {
      if (!this.users.has(memberId)) {
        throw new MockScimError(
          400,
          `Resource '${memberId}' does not exist or one of its queried reference-property objects are not present.`,
          "invalidValue",
        );
      }
    }
    const present = new Set(group.members.map((m) => m.value));
    for (const memberId of memberIds) {
      if (!present.has(memberId)) {
        group.members.push({ value: memberId });
        present.add(memberId);
      }
    }
    group.meta = { ...group.meta, lastModified: isoNow() };
  }

  /**
   * Remove one member.
   *
   * Removing a user that exists but is not currently a member is already a
   * silent no-op — the filter matches nothing — so the operation is idempotent
   * over every state reachable with a live member id.
   *
   * A memberId naming no user at all is a 400, and that is deliberate rather
   * than an oversight. It mirrors addGroupMembers, which rejects the same id
   * with the same documented message, and it matches an API that resolves
   * member references against the directory. The case this covers is
   * deleteUser followed by remove_group_member: deleteUser has already
   * stripped the membership, so the id no longer resolves. A mock that
   * shrugged there would be more lenient than the thing it stands in for, and
   * mock leniency is exactly what hid two live defects from this suite before.
   *
   * Not yet confirmed against a live tenant — the real API may well answer 204
   * here. Until someone spends the call, strict is the direction that fails
   * loudly rather than quietly.
   */
  removeGroupMember(groupId: string, memberId: string): void {
    const group = this.requireGroup(groupId);
    if (!this.users.has(memberId)) {
      throw new MockScimError(
        400,
        `Resource '${memberId}' does not exist or one of its queried reference-property objects are not present.`,
        "invalidValue",
      );
    }
    group.members = group.members.filter((m) => m.value !== memberId);
    group.meta = { ...group.meta, lastModified: isoNow() };
  }

  /** Group ids the user is a direct member of (for groups.value filters). */
  groupIdsOfUser(userId: string): string[] {
    const ids: string[] = [];
    for (const group of this.groups.values()) {
      if (group.members.some((m) => m.value === userId)) ids.push(group.id);
    }
    return ids;
  }

  // -- lifecycle ------------------------------------------------------------

  seed(data: SeedData): { userIds: string[]; groupIds: string[] } {
    const userIds = (data.users ?? []).map((u) => this.createUser(u).id);
    const groupIds = (data.groups ?? []).map((g) => {
      const created = this.createGroup(g);
      const memberIds = (g.members ?? []).map((m) => m.value);
      if (memberIds.length > 0) this.addGroupMembers(created.id, memberIds);
      return created.id;
    });
    return { userIds, groupIds };
  }

  reset(): void {
    this.users.clear();
    this.groups.clear();
    this.userNameIndex.clear();
  }

  private requireGroup(id: string): StoredGroup {
    const group = this.groups.get(id);
    if (!group) {
      throw new MockScimError(404, `Group '${id}' not found.`);
    }
    return group;
  }

  private assertUserNameFree(userName: string, selfId: string | undefined): void {
    const existing = this.userNameIndex.get(userName.toLowerCase());
    if (existing && existing !== selfId) {
      throw new MockScimError(
        409,
        `A user with userName '${userName}' already exists.`,
        "uniqueness",
      );
    }
  }
}

/**
 * RFC 7643 types `primary` on multi-valued attributes as boolean, but the
 * Microsoft SCIM Validator sends it as the string "true" and then looks the
 * element up with `primary eq true` when verifying what it fetched back — so
 * echoing the string verbatim makes correctly-applied values read as missing.
 * Coerce on the way into the store, for every multi-valued attribute.
 */
function normalizePrimaryFlags<T extends Record<string, unknown>>(record: T): T {
  for (const value of Object.values(record)) {
    if (!Array.isArray(value)) continue;
    for (const element of value) {
      if (!element || typeof element !== "object") continue;
      const entry = element as { primary?: unknown };
      if (typeof entry.primary !== "string") continue;
      const flag = entry.primary.trim().toLowerCase();
      if (flag === "true") entry.primary = true;
      else if (flag === "false") entry.primary = false;
    }
  }
  return record;
}

function isoNow(): string {
  return new Date().toISOString();
}
