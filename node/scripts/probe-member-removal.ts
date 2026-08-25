#!/usr/bin/env node
/**
 * Settle one question against a live tenant: what does the Entra SCIM API do
 * when you remove a group member that does not resolve to a user?
 *
 * The mock answers 400 for that case, mirroring add_group_members. Nothing had
 * ever checked it, and a mock that is stricter than the API produces false
 * failures the same way a lenient one hides real behaviour. This probe is the
 * cheapest way to find out, and to find out again if Microsoft changes it.
 *
 * Four cases, one control:
 *   A  member whose user was deleted after being added   <- the open question
 *   B  a live user that is not a member of the group
 *   C  a well-formed GUID that was never a user
 *   D  a real member                                     <- control, must pass
 *
 * ~20 billed calls. Everything it creates is deleted in a finally block, and
 * the identities use the same scim-smoke- prefix as live-smoke.ts so
 * `npx tsx scripts/live-smoke.ts --sweep --confirm` can recover orphans.
 *
 *   npx tsx scripts/probe-member-removal.ts --confirm
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadAuthFromEnv } from "../src/scim/auth.js";
import { ScimClient } from "../src/scim/client.js";
import { SCIM_BASE_URL } from "../src/scim/types.js";
import { createServer } from "../src/server.js";
import { loadDotEnv } from "./lib/dotenv.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
loadDotEnv(resolve(scriptDir, "..", ".env"));

const { values } = parseArgs({
  options: { confirm: { type: "boolean" }, rehearse: { type: "boolean" } },
});

function fail(message: string): never {
  process.stderr.write(`probe: ${message}\n`);
  process.exit(2);
}

const baseUrl = process.env.ENTRA_SCIM_BASE_URL?.trim() || SCIM_BASE_URL;
const dryRun = process.env.ENTRA_SCIM_DRY_RUN === "1";
const staticToken = Boolean(process.env.ENTRA_SCIM_STATIC_TOKEN?.trim());
const rehearse = Boolean(values.rehearse);

if ((dryRun || staticToken) && !rehearse) {
  fail(
    "ENTRA_SCIM_DRY_RUN or ENTRA_SCIM_STATIC_TOKEN is set; such a run proves nothing. Pass --rehearse to acknowledge, or unset it.",
  );
}
if (!rehearse && !values.confirm && process.env.ENTRA_SCIM_LIVE !== "1") {
  fail(
    "this makes ~20 billed calls against a real tenant. Re-run with --confirm or ENTRA_SCIM_LIVE=1.",
  );
}

const domain = process.env.ENTRA_SCIM_SMOKE_DOMAIN?.trim();
if (!domain)
  fail(
    "ENTRA_SCIM_SMOKE_DOMAIN is required (the verified domain for throwaway identities).",
  );

// A static token cannot be combined with a real credential, and .env holds
// one. In a rehearsal the real credential is exactly what we do not want, so
// set it aside rather than weakening the guardrail — same as live-smoke.ts.
let authEnv = process.env;
if (rehearse && staticToken) {
  const {
    ENTRA_CLIENT_SECRET: _secret,
    ENTRA_CLIENT_CERT_PATH: _cert,
    ...rest
  } = process.env;
  authEnv = rest;
}

const auth = loadAuthFromEnv(authEnv, { baseUrl, dryRun });
if (!rehearse && auth.mode === "static") {
  fail(
    "resolved auth mode is 'static'; a live run needs a client secret or certificate.",
  );
}

const scimClient = new ScimClient({ credential: auth.credential, baseUrl, dryRun });
const { server } = createServer({ auth, client: scimClient });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcp = new Client({ name: "probe-member-removal", version: "0.1.0" });
await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

process.stdout.write(
  `auth: mode=${auth.mode} tenant=${auth.tenantId} endpoint=${baseUrl}\n`,
);
process.stdout.write(`domain: ${domain}\n\n`);

let calls = 0;

interface Outcome {
  ok: boolean;
  status?: number;
  scimType?: string;
  detail?: string;
  /** The tool's own payload, so a created id can be read off the result. */
  [key: string]: unknown;
}

async function call(tool: string, args: Record<string, unknown>): Promise<Outcome> {
  calls += 1;
  const result = await mcp.callTool({ name: tool, arguments: args });
  const out = (result.structuredContent ?? {}) as Record<string, unknown>;
  if (result.isError) {
    return {
      ok: false,
      status: typeof out.status === "number" ? out.status : undefined,
      scimType: typeof out.scimType === "string" ? out.scimType : undefined,
      detail:
        typeof out.detail === "string" ? out.detail : JSON.stringify(out).slice(0, 200),
    };
  }
  return { ok: true, ...(out as object) };
}

function show(label: string, outcome: Outcome): void {
  const verdict = outcome.ok
    ? "ACCEPTED (2xx)"
    : `REJECTED ${outcome.status ?? "?"}${outcome.scimType ? ` ${outcome.scimType}` : ""}`;
  process.stdout.write(`  ${label.padEnd(48)} ${verdict}\n`);
  if (!outcome.ok && outcome.detail) {
    process.stdout.write(`  ${" ".repeat(48)} ${outcome.detail.slice(0, 150)}\n`);
  }
}

const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const created: { users: string[]; groups: string[] } = { users: [], groups: [] };

function newUser(n: number): Record<string, unknown> {
  const nick = `scim-smoke-${runId}-${n}`;
  return {
    userName: `${nick}@${domain}`,
    password: `Aa1!${randomUUID()}`,
    displayName: `SCIM Probe ${runId} ${n}`,
    givenName: "SCIM",
    familyName: "Probe",
    mailNickname: nick,
  };
}

/** Ask the API whether `userId` is still a member of `groupId`. */
async function isMember(groupId: string, userId: string): Promise<string> {
  const out = await call("list_groups", {
    filter: [{ attr: "members.value", op: "eq", value: userId }],
  });
  if (!out.ok) return `query failed: ${out.detail ?? ""}`;
  const resources = (out.resources ?? out.Resources) as { id?: string }[] | undefined;
  const ids = (resources ?? []).map((r) => r.id);
  return ids.includes(groupId) ? "still a member" : "not a member";
}

try {
  const group = await call("create_group", {
    displayName: `SCIM Smoke ${runId}`,
    mailNickname: `scim-smoke-${runId}-g`,
    securityEnabled: true,
    mailEnabled: false,
  });
  if (!group.ok) fail(`create_group failed: ${group.detail ?? ""}`);
  const groupId = String(group.id);
  created.groups.push(groupId);

  const ids: string[] = [];
  for (const n of [1, 2, 3]) {
    const u = await call("provision_user", newUser(n));
    if (!u.ok) fail(`provision_user ${n} failed: ${u.detail ?? ""}`);
    ids.push(String(u.id));
    created.users.push(String(u.id));
  }
  const [ballast, subject, stranger] = ids as [string, string, string];

  process.stdout.write(
    `group=${groupId}
ballast=${ballast}
subject=${subject}
stranger=${stranger}

`,
  );

  // Ballast stays a member throughout, so no probe below ever runs against an
  // empty group — that was the confound in the first run of this.
  await call("add_group_members", { id: groupId, memberIds: [ballast, subject] });

  process.stdout.write(`Probes (the group keeps a ballast member throughout):
`);

  show(
    "D  control: remove a real member",
    await call("remove_group_member", { id: groupId, memberId: subject }),
  );
  show(
    "B  live user, never a member",
    await call("remove_group_member", { id: groupId, memberId: stranger }),
  );
  show(
    "C  well-formed GUID, never a user",
    await call("remove_group_member", { id: groupId, memberId: randomUUID() }),
  );

  // The review #6 ordering: add, delete the user, then try to remove it.
  await call("add_group_members", { id: groupId, memberIds: [subject] });
  process.stdout.write(`
  before delete, subject is: ${await isMember(groupId, subject)}
`);

  const deleted = await call("deprovision_user", { id: subject });
  if (deleted.ok) created.users = created.users.filter((id) => id !== subject);
  process.stdout.write(`  after delete,  subject is: ${await isMember(groupId, subject)}

`);

  show(
    "A  member whose user was just deleted",
    await call("remove_group_member", { id: groupId, memberId: subject }),
  );

  // Does the error name the member, or just echo the request target?
  show(
    "E  real member, but a bogus GROUP id",
    await call("remove_group_member", { id: randomUUID(), memberId: ballast }),
  );
} finally {
  process.stdout.write(`
Cleanup:
`);
  for (const id of created.users) {
    const out = await call("deprovision_user", { id });
    process.stdout
      .write(`  user  ${id} ${out.ok ? "deleted" : `LEFT BEHIND: ${out.detail ?? ""}`}
`);
  }
  for (const id of created.groups) {
    const out = await call("delete_group", { id });
    process.stdout
      .write(`  group ${id} ${out.ok ? "deleted" : `LEFT BEHIND: ${out.detail ?? ""}`}
`);
  }
  process.stdout.write(`
billed calls: ${calls}
`);
}

process.exit(0);
