#!/usr/bin/env node
/**
 * Live probe for the Aug/Sep 2026 API changes (PR #15). Billed: ~14 calls,
 * plus 1 + one per owner when ENTRA_SCIM_SMOKE_OWNED_GROUP_ID is set.
 *
 *   npx tsx scripts/probe-mailnickname.ts --confirm
 *
 * Every user it creates carries the scim-smoke- prefix, so
 * `live-smoke.ts --sweep --confirm` removes anything a crash leaves behind.
 */
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadAuthFromEnv } from "../src/scim/auth.js";
import { ScimClient } from "../src/scim/client.js";
import { createServer } from "../src/server.js";
import { SCHEMA_ENTRA_USER, SCHEMA_USER_CORE, SCIM_BASE_URL } from "../src/scim/types.js";
import { loadDotEnv } from "./lib/dotenv.mjs";

if (!process.argv.includes("--confirm")) {
  console.error("Billed live probe. Re-run with --confirm.");
  process.exit(2);
}

loadDotEnv(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"));
if (
  process.env.ENTRA_SCIM_DRY_RUN === "1" ||
  process.env.ENTRA_SCIM_STATIC_TOKEN?.trim()
) {
  console.error("Dry-run or static token set; this probe must hit the live API.");
  process.exit(2);
}
const auth = loadAuthFromEnv(process.env);
const scim = new ScimClient({ credential: auth.credential, baseUrl: SCIM_BASE_URL });
const { server } = createServer({ auth, client: scim });
const [ct, st] = InMemoryTransport.createLinkedPair();
const mcp = new Client({ name: "probe", version: "0.0.0" });
await Promise.all([server.connect(st), mcp.connect(ct)]);

const DOMAIN = process.env.ENTRA_SCIM_SMOKE_DOMAIN;
if (!DOMAIN) {
  console.error("ENTRA_SCIM_SMOKE_DOMAIN is required.");
  process.exit(2);
}
const tag = randomBytes(3).toString("hex");
const created: string[] = [];
/** Checks with a definite expected answer; any entry makes the run exit 1. */
const failures: string[] = [];
const password = `P${randomBytes(9).toString("base64url")}!9a`;

async function tool(name: string, args: Record<string, unknown>) {
  const r = await mcp.callTool({ name, arguments: args });
  return { ok: !r.isError, out: (r.structuredContent ?? r.content) as any };
}

function report(label: string, value: unknown) {
  console.log(`\n## ${label}\n${JSON.stringify(value, null, 2)}`);
}

const base = (userName: string) => ({
  userName,
  password,
  displayName: `SCIM Smoke ${userName}`,
  givenName: "Scim",
  familyName: "Smoke",
});

try {
  // 1. Omitted mailNickname, through the new provision_user.
  const aName = `scim-smoke-nick-${tag}@${DOMAIN}`;
  const a = await tool("provision_user", base(aName));
  report("1 omit mailNickname", {
    ok: a.ok,
    mailNickname: a.out?.[SCHEMA_ENTRA_USER]?.mailNickname,
    error: a.ok ? undefined : a.out,
  });
  if (a.ok) created.push(a.out.id);

  // 2. Empty-string mailNickname, raw (the tool refuses "").
  const bName = `scim-smoke-empty-${tag}@${DOMAIN}`;
  try {
    const b = await scim.request<any>({
      method: "POST",
      path: "/users",
      body: {
        schemas: [SCHEMA_USER_CORE, SCHEMA_ENTRA_USER],
        ...{
          userName: bName,
          password,
          displayName: `SCIM Smoke ${bName}`,
          active: true,
        },
        name: { givenName: "Scim", familyName: "Smoke" },
        [SCHEMA_ENTRA_USER]: { mailNickname: "" },
      },
    });
    created.push(b.id);
    report("2 empty mailNickname", {
      ok: true,
      mailNickname: b[SCHEMA_ENTRA_USER]?.mailNickname,
    });
  } catch (err) {
    report("2 empty mailNickname", { ok: false, error: String(err) });
  }

  // 3. Explicit duplicate of user 1's alias: is uniqueness enforced?
  if (a.ok) {
    const dupAlias = a.out[SCHEMA_ENTRA_USER]?.mailNickname;
    const c = await tool("provision_user", {
      ...base(`scim-smoke-dup-${tag}@${DOMAIN}`),
      mailNickname: dupAlias,
    });
    report("3 explicit duplicate alias", {
      ok: c.ok,
      mailNickname: c.out?.[SCHEMA_ENTRA_USER]?.mailNickname,
      error: c.ok ? undefined : c.out,
    });
    if (c.ok) created.push(c.out.id);
  }

  // 4. New filters, all unquoted booleans / not() — do they parse live?
  const filters: [string, Record<string, unknown>][] = [
    [
      "list_users active eq true, count 999, id+userName",
      {
        filter: [{ attr: "active", op: "eq", value: "true" }],
        attributes: ["id", "userName"],
        count: 999,
      },
    ],
    [
      "list_users not(mailNickname ew '-nomatch') and userName ew '@domain'",
      {
        filter: [
          { attr: "mailNickname", op: "ew", value: "-nomatch", not: true },
          { attr: "userName", op: "ew", value: `@${DOMAIN}` },
        ],
        attributes: ["id", "userName"],
      },
    ],
  ];
  for (const [label, args] of filters) {
    const r = await tool("list_users", args);
    report(
      label,
      r.ok
        ? { ok: true, returned: r.out.resources?.length, total: r.out.totalResults }
        : r.out,
    );
  }
  for (const [label, args] of [
    [
      "list_groups securityEnabled eq true",
      {
        filter: [{ attr: "securityEnabled", op: "eq", value: "true" }],
        attributes: ["id"],
      },
    ],
    [
      "list_groups mailEnabled eq false",
      { filter: [{ attr: "mailEnabled", op: "eq", value: "false" }], attributes: ["id"] },
    ],
  ] as const) {
    const r = await tool("list_groups", args);
    report(label, r.ok ? { ok: true, returned: r.out.resources?.length } : r.out);
  }
  // 5. Ownership filters, both directions, against a known owned group.
  // Skipped without ENTRA_SCIM_SMOKE_OWNED_GROUP_ID: with no group to aim at,
  // an empty result cannot tell a broken filter from a tenant with no owners.
  const ownedGroupId = process.env.ENTRA_SCIM_SMOKE_OWNED_GROUP_ID?.trim();
  if (!ownedGroupId) {
    report("ownership filters", { skipped: "set ENTRA_SCIM_SMOKE_OWNED_GROUP_ID" });
  } else {
    const owners = await tool("list_users", {
      filter: [{ attr: "ownedGroups.value", op: "eq", value: ownedGroupId }],
      attributes: ["id"],
    });
    const ownerIds: string[] = owners.ok
      ? (owners.out.resources ?? []).map((r: { id: string }) => r.id)
      : [];
    const found = owners.ok && ownerIds.length > 0;
    if (!found) failures.push("ownedGroups.value returned no owners");
    report("list_users ownedGroups.value eq <group>", {
      pass: found,
      owners: ownerIds.length,
      ...(owners.ok ? {} : { error: owners.out }),
    });
    for (const ownerId of ownerIds) {
      const groups = await tool("list_groups", {
        filter: [{ attr: "owners.value", op: "eq", value: ownerId }],
        attributes: ["id"],
      });
      const includes =
        groups.ok &&
        (groups.out.resources ?? []).some((r: { id: string }) => r.id === ownedGroupId);
      if (!includes) failures.push(`owners.value for ${ownerId} missed the group`);
      report(`list_groups owners.value eq <owner ${ownerId}>`, {
        pass: includes,
        returned: groups.ok ? groups.out.resources?.length : undefined,
        ...(groups.ok ? {} : { error: groups.out }),
      });
    }
  }
} finally {
  for (const id of created) {
    const d = await tool("deprovision_user", { id });
    console.log(`cleanup ${id}: ${d.ok ? "deleted" : JSON.stringify(d.out)}`);
  }
}

if (failures.length > 0) {
  console.error(`\nFAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nall checks with an expected answer passed");
