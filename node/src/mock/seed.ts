import { readFile } from "node:fs/promises";
import {
  SCHEMA_ENTRA_GROUP,
  SCHEMA_ENTRA_USER,
  SCHEMA_GROUP_CORE,
  SCHEMA_USER_CORE,
} from "../scim/types.js";
import type { SeedData } from "./store.js";

/** A small demo tenant so the mock is useful straight from npx. */
export function demoSeed(): SeedData {
  return {
    users: [
      {
        schemas: [SCHEMA_USER_CORE, SCHEMA_ENTRA_USER],
        userName: "adele.vance@contoso.local",
        displayName: "Adele Vance",
        active: true,
        name: { givenName: "Adele", familyName: "Vance" },
        [SCHEMA_ENTRA_USER]: { mailNickname: "adelev", userType: "Member" },
      },
      {
        schemas: [SCHEMA_USER_CORE, SCHEMA_ENTRA_USER],
        userName: "alex.wilber@contoso.local",
        displayName: "Alex Wilber",
        active: true,
        name: { givenName: "Alex", familyName: "Wilber" },
        [SCHEMA_ENTRA_USER]: { mailNickname: "alexw", userType: "Member" },
      },
    ],
    groups: [
      {
        schemas: [SCHEMA_GROUP_CORE, SCHEMA_ENTRA_GROUP],
        displayName: "All Employees",
        [SCHEMA_ENTRA_GROUP]: {
          description: "Demo group seeded by entra-scim-mock-server",
          mailEnabled: false,
          mailNickname: "all-employees",
          securityEnabled: true,
        },
      },
    ],
  };
}

/**
 * Load seed data from a JSON file shaped like SeedData ({users, groups}).
 *
 * The shape is checked rather than asserted. A cast let anything through to
 * MockStore, where the wrong type surfaced as a SCIM 400 raised from inside a
 * store method — an error about a request, for a file, at a CLI that had not
 * started serving yet. Worse, a nested shape the store dereferences without
 * checking (`members: [null]`) reached it as a bare TypeError.
 *
 * So validation goes as deep as the store reads: the fields it requires, and
 * every field it dereferences. Attributes beyond those stay unchecked on
 * purpose — SCIM resources carry arbitrary URN-keyed extension objects, and a
 * seed file is allowed to include them.
 *
 * Reference integrity is still the store's: a member naming a user that is not
 * in the file is a semantic error, and MockStore reports it against the id.
 */
export async function loadSeedFile(path: string): Promise<SeedData> {
  const text = await readFile(path, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Seed file ${path} is not valid JSON: ${detail}`, {
      cause: err,
    });
  }

  // `typeof null` is "object", and so is an array; neither is a SeedData.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Seed file ${path} must contain a JSON object with optional "users" and "groups" arrays.`,
    );
  }

  const record = parsed as Record<string, unknown>;
  const users = objectArray(path, "users", record.users);
  const groups = objectArray(path, "groups", record.groups);
  if (!users && !groups) {
    throw new Error(
      `Seed file ${path} has neither "users" nor "groups"; use --no-seed for an empty tenant.`,
    );
  }

  users?.forEach((user, i) => {
    validateUser(path, `users[${i}]`, user);
  });
  groups?.forEach((group, i) => {
    validateGroup(path, `groups[${i}]`, group);
  });

  // Checked above, field by field, for everything the store touches.
  return {
    ...(users ? { users: users as SeedData["users"] } : {}),
    ...(groups ? { groups: groups as SeedData["groups"] } : {}),
  };
}

/** MockStore.createUser rejects a missing userName; say so about the file. */
function validateUser(path: string, at: string, user: Record<string, unknown>): void {
  requireNonEmptyString(path, `${at}.userName`, user.userName);
  optionalStringArray(path, `${at}.schemas`, user.schemas);
}

/**
 * Groups need more care than users: MockStore.seed maps over `members` and
 * reads `.value` off each entry without checking either.
 */
function validateGroup(path: string, at: string, group: Record<string, unknown>): void {
  requireNonEmptyString(path, `${at}.displayName`, group.displayName);
  optionalStringArray(path, `${at}.schemas`, group.schemas);

  const members = group.members;
  if (members === undefined || members === null) return;
  if (!Array.isArray(members)) {
    throw new Error(`Seed file ${path}: "${at}.members" must be an array.`);
  }
  members.forEach((member: unknown, i: number) => {
    if (member === null || typeof member !== "object" || Array.isArray(member)) {
      throw new Error(
        `Seed file ${path}: "${at}.members[${i}]" must be a JSON object with a "value".`,
      );
    }
    requireNonEmptyString(
      path,
      `${at}.members[${i}].value`,
      (member as Record<string, unknown>).value,
    );
  });
}

function requireNonEmptyString(path: string, key: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Seed file ${path}: "${key}" must be a non-empty string.`);
  }
}

function optionalStringArray(path: string, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.some((v: unknown) => typeof v !== "string")) {
    throw new Error(`Seed file ${path}: "${key}" must be an array of strings.`);
  }
}

/** Validate an optional top-level key as an array of JSON objects. */
function objectArray(
  path: string,
  key: string,
  value: unknown,
): Record<string, unknown>[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Seed file ${path}: "${key}" must be an array.`);
  }
  value.forEach((entry: unknown, i: number) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Seed file ${path}: "${key}[${i}]" must be a JSON object.`);
    }
  });
  return value as Record<string, unknown>[];
}
