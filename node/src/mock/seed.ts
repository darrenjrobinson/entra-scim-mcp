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

/** Load seed data from a JSON file shaped like SeedData ({users, groups}). */
export async function loadSeedFile(path: string): Promise<SeedData> {
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text) as SeedData;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Seed file ${path} must contain a JSON object.`);
  }
  return parsed;
}
