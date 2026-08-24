#!/usr/bin/env node
/**
 * Live-tenant smoke test: exercises all 18 MCP tools against a real Entra SCIM
 * endpoint, through the real MCP protocol layer.
 *
 * Uses the same harness shape as test/integration/tools-e2e.test.ts — an
 * in-memory MCP client calling tools by name — so zod input validation,
 * wrapTool error mapping and structured output are all covered, not just
 * ScimClient. The only substitutions are a real credential and the real base
 * URL.
 *
 * Every SCIM call is billed, so the run is a single ordered pass (~21 calls),
 * not a matrix. It does not abort on the first failure: a failed step marks its
 * dependents SKIP and everything independent still runs, so one run gives a
 * complete picture of which tools the live API accepts.
 *
 *   ENTRA_SCIM_LIVE=1 npm run smoke:live              # bash
 *   $env:ENTRA_SCIM_LIVE=1; npm run smoke:live        # PowerShell
 *
 * Pass flags by calling tsx directly — npm swallows them on Windows:
 *   npx tsx scripts/live-smoke.ts --rehearse          # dry-run / mock, zero cost
 *   npx tsx scripts/live-smoke.ts --sweep --confirm   # delete orphans from a crash
 */
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadAuthFromEnv } from "../src/scim/auth.js";
import { ScimClient } from "../src/scim/client.js";
import { createServer } from "../src/server.js";
import { SCHEMA_ENTRA_CSA, SCIM_BASE_URL } from "../src/scim/types.js";
import { loadDotEnv } from "./lib/dotenv.mjs";

/** Every tool registered by createServer. The run must touch all of them. */
const ALL_TOOLS = [
  "get_service_provider_config",
  "list_resource_types",
  "list_schemas",
  "list_users",
  "get_user",
  "provision_user",
  "update_user",
  "deprovision_user",
  "update_user_lifecycle",
  "get_user_custom_security_attributes",
  "update_user_custom_security_attributes",
  "list_groups",
  "get_group",
  "create_group",
  "update_group",
  "delete_group",
  "add_group_members",
  "remove_group_member",
] as const;

const CSA_SETUP_HINT =
  "needs ENTRA_SCIM_SMOKE_CSA_SET + ENTRA_SCIM_SMOKE_CSA_ATTR, and an attribute set that exists in the tenant (Entra portal > Protection > Custom security attributes)";

const SMOKE_PREFIX = "scim-smoke-";
const GROUP_PREFIX = "SCIM Smoke ";
/** Never delete these, whatever a filter returns. */
const PROTECTED_USERNAMES = new Set(["darrenjrobinson@credentialite.com"]);

type Status = "PASS" | "FAIL" | "SKIP";

interface StepResult {
  n: number;
  tool: string;
  status: Status;
  note: string;
}

type ToolOutput = Record<string, any>;

const steps: StepResult[] = [];
const attempted = new Set<string>();
const passed = new Set<string>();
let calls = 0;
let stepNo = 0;

function record(tool: string, status: Status, note: string): void {
  stepNo += 1;
  steps.push({ n: stepNo, tool, status, note });
  attempted.add(tool);
  if (status === "PASS") passed.add(tool);
  const icon = status === "PASS" ? "ok  " : status === "FAIL" ? "FAIL" : "skip";
  process.stdout.write(
    `  ${String(stepNo).padStart(2)}. [${icon}] ${tool}${note ? ` — ${note}` : ""}\n`,
  );
}

function skip(tool: string, why: string): void {
  record(tool, "SKIP", why);
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolve(scriptDir, "..");
  const envFile = resolve(packageDir, ".env");

  const { values } = parseArgs({
    options: {
      confirm: { type: "boolean" },
      rehearse: { type: "boolean" },
      "allow-dry-run": { type: "boolean" },
      sweep: { type: "boolean" },
      "csa-only": { type: "boolean" },
      help: { type: "boolean" },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const loaded = loadDotEnv(envFile);
  process.stdout.write(
    `env: ${loaded.length ? `${loaded.length} var(s) from ${envFile}` : `nothing loaded from ${envFile}`}\n`,
  );

  const rehearse = Boolean(values.rehearse || values["allow-dry-run"]);
  const dryRun = process.env.ENTRA_SCIM_DRY_RUN === "1";
  const staticToken = Boolean(process.env.ENTRA_SCIM_STATIC_TOKEN?.trim());
  const baseUrl = process.env.ENTRA_SCIM_BASE_URL?.trim() || SCIM_BASE_URL;

  // A rehearsal proves the script's own logic; it proves nothing about the live
  // API, so it must never be mistaken for a real pass.
  if ((dryRun || staticToken) && !rehearse) {
    fail(
      `Refusing to run: ${dryRun ? "ENTRA_SCIM_DRY_RUN=1" : "ENTRA_SCIM_STATIC_TOKEN"} is set, so this run ` +
        `would prove nothing about the live API.\n` +
        `Pass --rehearse to acknowledge that, or unset it for a real run.`,
    );
  }
  if (!dryRun && !staticToken && !rehearse) {
    const confirmed = values.confirm || process.env.ENTRA_SCIM_LIVE === "1";
    if (!confirmed) {
      process.stdout.write(
        `\nThis will make ~21 billed SCIM calls against a real tenant, and create\n` +
          `then delete throwaway users and a group.\n\n` +
          `  tenant:   ${process.env.ENTRA_TENANT_ID ?? "(unset)"}\n` +
          `  client:   ${process.env.ENTRA_CLIENT_ID ?? "(unset)"}\n` +
          `  endpoint: ${baseUrl}\n` +
          `  domain:   ${process.env.ENTRA_SCIM_SMOKE_DOMAIN ?? "(unset — required)"}\n\n` +
          `Re-run with ENTRA_SCIM_LIVE=1, or pass --confirm.\n`,
      );
      process.exit(2);
    }
  }

  // A static token cannot be combined with a real credential, and once .env
  // holds a live secret that guardrail would block every mock rehearsal. In
  // rehearsal the real credential is exactly what we do not want, so set it
  // aside rather than weakening the guardrail.
  let authEnv = process.env;
  if (rehearse && staticToken) {
    const { ENTRA_CLIENT_SECRET, ENTRA_CLIENT_CERT_PATH, ...rest } = process.env;
    if (ENTRA_CLIENT_SECRET?.trim() || ENTRA_CLIENT_CERT_PATH?.trim()) {
      process.stdout.write(
        "note: ignoring the credential in .env for this rehearsal — the static token targets the mock\n",
      );
    }
    authEnv = rest;
  }

  const auth = loadAuthFromEnv(authEnv, { baseUrl, dryRun });
  if (!rehearse && auth.mode === "static") {
    fail(
      "Refusing to run: resolved auth mode is 'static'. A live run needs a client secret or certificate.",
    );
  }
  process.stdout.write(
    `auth: mode=${auth.mode} tenant=${auth.tenantId} endpoint=${baseUrl}` +
      `${rehearse ? " (REHEARSAL — proves nothing about the live API)" : ""}\n`,
  );

  const scimClient = new ScimClient({ credential: auth.credential, baseUrl, dryRun });
  const { server } = createServer({ auth, client: scimClient });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "live-smoke", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

  /**
   * Call a tool and classify the outcome. Returns the structured payload, or
   * null when the step failed — callers use that to SKIP dependents.
   */
  async function call(
    tool: string,
    args: Record<string, unknown>,
    check?: (out: ToolOutput) => string | undefined,
  ): Promise<ToolOutput | null> {
    calls += 1;
    let result;
    try {
      result = await mcp.callTool({ name: tool, arguments: args });
    } catch (err) {
      record(tool, "FAIL", `transport: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const out = (result.structuredContent ?? {}) as ToolOutput;

    if (result.isError) {
      const parts = [
        out.error ? `${out.error}` : "",
        out.status !== undefined ? `status=${out.status}` : "",
        out.scimType ? `scimType=${out.scimType}` : "",
        out.detail ? `${out.detail}` : "",
      ].filter(Boolean);
      record(tool, "FAIL", parts.join(" ") || JSON.stringify(out).slice(0, 200));
      return null;
    }
    // wrapTool turns a dry-run into a successful "here is the request I would
    // have sent" payload, not an error.
    if (out.dryRun) {
      record(tool, "PASS", `dry-run ${out.request?.method} ${shortPath(out.request?.url)}`);
      return { ...out, id: `dry-run-${tool}` };
    }

    const problem = check?.(out);
    if (problem) {
      record(tool, "FAIL", `unexpected response: ${problem}`);
      return null;
    }
    record(tool, "PASS", describe(tool, out));
    return out;
  }

  if (values.sweep) {
    await sweep(call, Boolean(values.confirm));
    await mcp.close().catch(() => {});
    summarize({ sweepOnly: true });
    return;
  }

  const domain = process.env.ENTRA_SCIM_SMOKE_DOMAIN?.trim();
  if (!domain) {
    fail(
      "ENTRA_SCIM_SMOKE_DOMAIN is required — the verified domain to create the throwaway test identities in.",
    );
  }
  const runId = stamp();
  const csaSet = process.env.ENTRA_SCIM_SMOKE_CSA_SET?.trim();
  const csaAttr = process.env.ENTRA_SCIM_SMOKE_CSA_ATTR?.trim();
  const csaValue = parseCsaValue(process.env.ENTRA_SCIM_SMOKE_CSA_VALUE, runId);

  const identities = [1, 2].map((i) => ({
    userName: `${SMOKE_PREFIX}${runId}-${i}@${domain}`,
    mailNickname: `scimsmoke${runId}${i}`,
    displayName: `SCIM Smoke ${runId} User ${i}`,
  }));
  const groupName = `${GROUP_PREFIX}${runId}`;

  if (values["csa-only"]) {
    if (!csaSet) fail(`--csa-only ${CSA_SETUP_HINT}`);
    const attrs = parseCsaAttrs(
      process.env.ENTRA_SCIM_SMOKE_CSA_ATTRS,
      csaAttr,
      csaValue,
      runId,
    );
    if (attrs.length === 0) fail(`--csa-only ${CSA_SETUP_HINT}`);
    await runCsaOnly(call, identities[0]!, csaSet, attrs);
    await mcp.close().catch(() => {});
    summarize({ sweepOnly: true });
    return;
  }

  process.stdout.write(
    `\nrun ${runId} will create:\n` +
      identities.map((u) => `  user   ${u.userName}\n`).join("") +
      `  group  ${groupName}\n\n`,
  );

  // Anything created is registered immediately, so the finally block can clean
  // up even if the run dies between create and delete.
  const liveUsers = new Map<string, string>();
  let liveGroup: { id: string; name: string } | undefined;

  try {
    // --- discovery: the cheapest proof that credential, consent and the SCIM
    //     Provisioning API feature/billing link are all good ---
    await call("get_service_provider_config", {});
    await call("list_resource_types", {});
    await call("list_schemas", {});

    // --- users ---
    const userIds: (string | undefined)[] = [];
    for (const [i, ident] of identities.entries()) {
      const created = await call(
        "provision_user",
        {
          userName: ident.userName,
          password: newPassword(),
          displayName: ident.displayName,
          givenName: "Smoke",
          familyName: `Test${i + 1}`,
          mailNickname: ident.mailNickname,
          department: "SCIM MCP Smoke",
          emails: [{ value: ident.userName, type: "work", primary: true }],
          // A work address has to exist for the update_user step below to have
          // something to replace.
          addresses: [{ type: "work", locality: "Melbourne", country: "AU" }],
        },
        (out) => {
          if (!out.id) return "no id in response";
          // A password must never come back out of the API.
          if (out.password !== undefined) return "response echoed the password";
          return undefined;
        },
      );
      if (created?.id) {
        userIds.push(created.id);
        liveUsers.set(created.id, ident.userName);
      } else {
        userIds.push(undefined);
      }
    }
    const [user1, user2] = userIds;

    if (!user1) {
      for (const t of ["get_user", "update_user", "list_users", "update_user_lifecycle"]) {
        skip(t, "provision_user failed for user 1");
      }
      skip("get_user_custom_security_attributes", "provision_user failed for user 1");
      skip("update_user_custom_security_attributes", "provision_user failed for user 1");
    } else {
      await call("get_user", { id: user1 }, (out) =>
        out.id === user1 ? undefined : `id mismatch: asked for ${user1}, got ${out.id}`,
      );

      await call("update_user", {
        id: user1,
        operations: [
          {
            op: "replace",
            path: "displayName",
            value: `${identities[0]!.displayName} (updated)`,
          },
          // Exercises the [type eq "work"] address guard against the real API.
          { op: "replace", path: 'addresses[type eq "work"].locality', value: "Sydney" },
        ],
      });

      await call(
        "list_users",
        { filter: [{ attr: "userName", op: "eq", value: identities[0]!.userName }], count: 5 },
        (out) =>
          (out.resources ?? []).some((r: any) => r.id === user1)
            ? undefined
            : "filter userName eq did not return the user just created",
      );

      // Requires User-LifeCycleInfo.ReadWrite.All; employeeLeaveDateTime is the
      // only input the tool takes.
      await call("update_user_lifecycle", {
        id: user1,
        employeeLeaveDateTime: "2030-12-31T17:00:00Z",
      });

      // Both CSA tools need an attribute set that already exists in the
      // tenant. attributeSets is required: the bare extension URN is rejected
      // with a 400 (settled on the live tenant 2026-08-24).
      if (csaSet) {
        await call("get_user_custom_security_attributes", {
          id: user1,
          attributeSets: [csaSet],
        });
      } else {
        skip("get_user_custom_security_attributes", CSA_SETUP_HINT);
      }
      if (csaSet && csaAttr) {
        process.stdout.write(
          `      note: assigning ${csaSet}.${csaAttr} = ${JSON.stringify(csaValue)} ` +
            `(${typeof csaValue}) — must match the attribute's declared data type\n`,
        );
        await call("update_user_custom_security_attributes", {
          id: user1,
          operations: [
            { op: "add", path: `${SCHEMA_ENTRA_CSA}:${csaSet}.${csaAttr}`, value: csaValue },
          ],
        });
      } else {
        skip("update_user_custom_security_attributes", CSA_SETUP_HINT);
      }
    }

    // --- groups ---
    const group = await call(
      "create_group",
      {
        displayName: groupName,
        description: "Throwaway group from the entra-scim-mcp live smoke test.",
        mailNickname: `scimsmokegrp${runId}`,
        securityEnabled: true,
        mailEnabled: false,
      },
      (out) => (out.id ? undefined : "no id in response"),
    );
    if (group?.id) liveGroup = { id: group.id, name: groupName };

    if (!group?.id) {
      for (const t of [
        "get_group",
        "update_group",
        "add_group_members",
        "list_groups",
        "remove_group_member",
        "delete_group",
      ]) {
        skip(t, "create_group failed");
      }
    } else {
      const groupId: string = group.id;

      await call("get_group", { id: groupId }, (out) =>
        out.members === undefined
          ? undefined
          : "get_group returned members, which the API is documented not to do",
      );

      await call("update_group", {
        id: groupId,
        operations: [{ op: "replace", path: "displayName", value: `${groupName} (updated)` }],
      });

      const memberIds = [user1, user2].filter((id): id is string => Boolean(id));
      if (memberIds.length === 0) {
        skip("add_group_members", "no users were provisioned");
        skip("list_groups", "no users were provisioned to filter on");
        skip("remove_group_member", "no users were provisioned");
      } else {
        const added = await call("add_group_members", { id: groupId, memberIds });

        // The documented way to read membership: get_group never returns it.
        await call(
          "list_groups",
          { filter: [{ attr: "members.value", op: "eq", value: memberIds[0]! }], count: 5 },
          (out) => {
            if (!added) return undefined;
            return (out.resources ?? []).some((r: any) => r.id === groupId)
              ? undefined
              : "members.value filter did not return the group the user was just added to";
          },
        );

        if (added) {
          await call("remove_group_member", { id: groupId, memberId: memberIds[0]! });
        } else {
          skip("remove_group_member", "add_group_members failed");
        }
      }

      const deleted = await call("delete_group", { id: groupId });
      if (deleted) liveGroup = undefined;
    }

    // --- teardown, as a tested step rather than just cleanup ---
    if (liveUsers.size === 0) {
      skip("deprovision_user", "no users were provisioned");
    } else {
      for (const [id, userName] of [...liveUsers.entries()]) {
        const gone = await call("deprovision_user", { id });
        if (gone) liveUsers.delete(id);
        else process.stdout.write(`      note: ${userName} (${id}) still exists\n`);
      }
    }
  } finally {
    await cleanup(mcp, liveUsers, liveGroup);
    await mcp.close().catch(() => {});
  }

  summarize({ sweepOnly: false });
}

/** Best-effort teardown of anything the run created but did not delete. */
async function cleanup(
  mcp: Client,
  liveUsers: Map<string, string>,
  liveGroup: { id: string; name: string } | undefined,
): Promise<void> {
  if (!liveGroup && liveUsers.size === 0) return;
  process.stdout.write(
    `\ncleanup: removing ${liveUsers.size} user(s), ${liveGroup ? 1 : 0} group(s) left behind\n`,
  );
  const leftovers: string[] = [];

  if (liveGroup) {
    calls += 1;
    const r = await mcp
      .callTool({ name: "delete_group", arguments: { id: liveGroup.id } })
      .catch(() => undefined);
    if (!r || r.isError) leftovers.push(`group ${liveGroup.name} (${liveGroup.id})`);
  }
  for (const [id, userName] of liveUsers) {
    calls += 1;
    const r = await mcp
      .callTool({ name: "deprovision_user", arguments: { id } })
      .catch(() => undefined);
    if (!r || r.isError) leftovers.push(`user ${userName} (${id})`);
  }

  if (leftovers.length) {
    process.stdout.write(
      `\n!! ORPHANS LEFT IN THE TENANT — delete these manually, or re-run with --sweep --confirm:\n` +
        leftovers.map((l) => `     ${l}\n`).join(""),
    );
  } else {
    process.stdout.write("cleanup: done, nothing left behind\n");
  }
}

export interface CsaAttr {
  name: string;
  type: CsaType;
  value: unknown;
}

/**
 * Just the two Custom Security Attribute tools, on one throwaway user —
 * ~9 billed calls instead of ~21. Goes further than the full pass in three
 * ways: it reads every value back (a PATCH the API accepts but stores nothing
 * would otherwise look like a pass), it covers each declared data type, and it
 * exercises removal, which the Entra docs never spell out for CSAs.
 */
async function runCsaOnly(
  call: (
    tool: string,
    args: Record<string, unknown>,
    check?: (out: ToolOutput) => string | undefined,
  ) => Promise<ToolOutput | null>,
  ident: { userName: string; mailNickname: string; displayName: string },
  csaSet: string,
  attrs: CsaAttr[],
): Promise<void> {
  process.stdout.write(
    `\nCSA-only run on ${ident.userName}\n` +
      `  set ${csaSet}, ${attrs.length} attribute(s):\n` +
      attrs
        .map((a) => `    ${a.name} (${a.type}) = ${JSON.stringify(a.value)}\n`)
        .join("") +
      "\n",
  );

  const created = await call(
    "provision_user",
    {
      userName: ident.userName,
      password: newPassword(),
      displayName: ident.displayName,
      givenName: "Smoke",
      familyName: "Csa",
      mailNickname: ident.mailNickname,
    },
    (out) => (out.id ? undefined : "no id in response"),
  );
  if (!created?.id) {
    skip("get_user_custom_security_attributes", "provision_user failed");
    skip("update_user_custom_security_attributes", "provision_user failed");
    return;
  }
  const id: string = created.id;
  const path = (attr: string): string => `${SCHEMA_ENTRA_CSA}:${csaSet}.${attr}`;
  const read = (): Promise<ToolOutput | null> =>
    call("get_user_custom_security_attributes", { id, attributeSets: [csaSet] });
  const valuesOf = (out: ToolOutput | null): Record<string, unknown> =>
    (out?.[SCHEMA_ENTRA_CSA]?.[csaSet] as Record<string, unknown>) ?? {};

  try {
    // Before: proves the projection is accepted even with nothing assigned.
    await read();

    // One PATCH carrying every declared type, which is what a real caller
    // would send. On failure each attribute is retried alone, so a single
    // offending data type is named rather than hidden behind one 400.
    let assigned = attrs;
    const batch = await call("update_user_custom_security_attributes", {
      id,
      operations: attrs.map((a) => ({ op: "add", path: path(a.name), value: a.value })),
    });
    if (!batch) {
      process.stdout.write(
        `      note: the combined PATCH failed — isolating which attribute the API rejects\n`,
      );
      assigned = [];
      for (const a of attrs) {
        const one = await call("update_user_custom_security_attributes", {
          id,
          operations: [{ op: "add", path: path(a.name), value: a.value }],
        });
        if (one) assigned.push(a);
        else process.stdout.write(`      note: rejected ${a.name} (${a.type})\n`);
      }
    }

    // The round trip. A PATCH the API accepts but stores nothing would look
    // like a pass without this.
    const after = valuesOf(await read());
    for (const a of assigned) {
      const got = after[a.name];
      if (got === undefined) {
        process.stdout.write(`      note: ${a.name} (${a.type}) did NOT come back\n`);
      } else {
        const same = JSON.stringify(got) === JSON.stringify(a.value);
        process.stdout.write(
          `      note: ${a.name} (${a.type}) ${same ? "round-trips" : "DIFFERS"}: ` +
            `sent ${JSON.stringify(a.value)}, got ${JSON.stringify(got)}\n`,
        );
      }
    }

    // Removal semantics: the SCIM-native `op: remove`, which the Entra docs
    // never spell out for CSAs. Deprovisioning workflows need this to work.
    const removable = assigned.find((a) => !Array.isArray(a.value));
    if (!removable) {
      process.stdout.write("      note: no single-valued attribute assigned, skipping remove\n");
    } else {
      const removed = await call("update_user_custom_security_attributes", {
        id,
        operations: [{ op: "remove", path: path(removable.name) }],
      });
      if (removed) {
        const post = valuesOf(await read());
        const gone = post[removable.name] === undefined;
        const survivors = assigned.filter(
          (a) => a.name !== removable.name && post[a.name] !== undefined,
        ).length;
        process.stdout.write(
          `      note: op:remove ${gone ? "cleared" : "did NOT clear"} ${removable.name}; ` +
            `${survivors} other assignment(s) intact\n`,
        );
      }
    }

    // Multi-valued clear: an empty array is the documented way to empty one.
    const multi = assigned.find((a) => Array.isArray(a.value));
    if (multi) {
      const cleared = await call("update_user_custom_security_attributes", {
        id,
        operations: [{ op: "replace", path: path(multi.name), value: [] }],
      });
      if (cleared) {
        const post = valuesOf(await read());
        const got = post[multi.name];
        process.stdout.write(
          `      note: empty-array replace on ${multi.name} left ${JSON.stringify(got)}\n`,
        );
      }
    }
  } finally {
    await call("deprovision_user", { id });
  }
}

/** Delete scim-smoke-* users stranded by an earlier crashed run. */
async function sweep(
  call: (
    tool: string,
    args: Record<string, unknown>,
    check?: (out: ToolOutput) => string | undefined,
  ) => Promise<ToolOutput | null>,
  confirmed: boolean,
): Promise<void> {
  const domain = process.env.ENTRA_SCIM_SMOKE_DOMAIN?.trim();
  if (!domain) fail("ENTRA_SCIM_SMOKE_DOMAIN is required for --sweep.");

  // 'ew' (ends-with) is the closest thing to a prefix match the API supports,
  // so the scim-smoke- prefix has to be applied client-side.
  const listed = await call("list_users", {
    filter: [{ attr: "userName", op: "ew", value: `@${domain}` }],
    count: 100,
  });
  if (!listed) return;

  const orphans = (listed.resources ?? []).filter((u: any) => {
    const name = String(u.userName ?? "").toLowerCase();
    if (PROTECTED_USERNAMES.has(name)) return false;
    return name.startsWith(SMOKE_PREFIX);
  });

  if (orphans.length === 0) {
    process.stdout.write(`\nsweep: no ${SMOKE_PREFIX}* users found on @${domain}\n`);
    return;
  }
  process.stdout.write(`\nsweep: found ${orphans.length} orphan(s):\n`);
  for (const u of orphans) process.stdout.write(`     ${u.userName} (${u.id})\n`);
  if (!confirmed) {
    process.stdout.write(`\nRe-run with --sweep --confirm to delete them.\n`);
    return;
  }
  for (const u of orphans) await call("deprovision_user", { id: u.id });
  process.stdout.write(
    `\nsweep: groups are not swept automatically — check for "${GROUP_PREFIX}*" groups in the portal.\n`,
  );
}

function summarize(opts: { sweepOnly: boolean }): void {
  const failed = steps.filter((s) => s.status === "FAIL");
  const skipped = steps.filter((s) => s.status === "SKIP");

  process.stdout.write(`\n${"=".repeat(72)}\n`);
  if (!opts.sweepOnly) {
    const untouched = ALL_TOOLS.filter((t) => !attempted.has(t));
    process.stdout.write(
      `tools:  ${passed.size}/${ALL_TOOLS.length} passed, ` +
        `${new Set(failed.map((s) => s.tool)).size} failed, ` +
        `${new Set(skipped.map((s) => s.tool)).size} skipped\n`,
    );
    if (untouched.length) {
      process.stdout.write(`WARNING: never attempted: ${untouched.join(", ")}\n`);
    }
  }
  process.stdout.write(`calls:  ${calls} SCIM request(s)\n`);

  if (failed.length) {
    process.stdout.write(`\nfailures:\n`);
    for (const s of failed) process.stdout.write(`  ${s.n}. ${s.tool}: ${s.note}\n`);
  }
  if (skipped.length) {
    process.stdout.write(`\nskipped:\n`);
    for (const s of skipped) process.stdout.write(`  ${s.n}. ${s.tool}: ${s.note}\n`);
  }
  process.stdout.write(`${"=".repeat(72)}\n`);
  if (failed.length) process.exitCode = 1;
}

function describe(tool: string, out: ToolOutput): string {
  if (out.id && (tool === "provision_user" || tool === "create_group")) return `id=${out.id}`;
  if (out.totalResults !== undefined) return `totalResults=${out.totalResults}`;
  if (out.memberIds) return `${out.memberIds.length} member(s), ${out.patchCalls} PATCH call(s)`;
  if (out.id) return `id=${out.id}`;
  if (out.ok) return "ok";
  return "";
}

function shortPath(url: unknown): string {
  const s = String(url ?? "");
  const i = s.indexOf("/rp/scim");
  return i === -1 ? s : s.slice(i + "/rp/scim".length) || "/";
}

/** Compact and sortable; no separators, so mailNickname stays short. */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Custom security attributes are typed (Boolean, Integer, String) and the API
 * rejects a value of the wrong type. Env vars are always strings, so coerce
 * `true`/`false` and bare integers to real JSON types; anything else stays a
 * string.
 */
function parseCsaValue(raw: string | undefined, runId: string): unknown {
  const v = raw?.trim();
  if (!v) return `smoke-${runId}`;
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

type CsaType = "bool" | "int" | "string" | "string[]";

/**
 * Parse ENTRA_SCIM_SMOKE_CSA_ATTRS — a compact declaration of the attribute
 * set's shape, e.g.
 *   isMCPManaged:bool,accountType:string,trustLevel:int,approvedLocations:string[]
 * A test value is derived per type so the run proves the API accepts each one.
 * Falls back to the single ENTRA_SCIM_SMOKE_CSA_ATTR / _VALUE pair.
 */
function parseCsaAttrs(
  raw: string | undefined,
  fallbackAttr: string | undefined,
  fallbackValue: unknown,
  runId: string,
): CsaAttr[] {
  const spec = raw?.trim();
  if (!spec) {
    return fallbackAttr
      ? [{ name: fallbackAttr, type: typeOf(fallbackValue), value: fallbackValue }]
      : [];
  }
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, rawType] = entry.split(":").map((s) => s.trim());
      if (!name) fail(`Malformed ENTRA_SCIM_SMOKE_CSA_ATTRS entry: "${entry}"`);
      const type = (rawType || "string").toLowerCase() as CsaType;
      switch (type) {
        case "bool":
          return { name, type, value: true };
        case "int":
          return { name, type, value: 42 };
        case "string":
          return { name, type, value: `smoke-${runId}` };
        case "string[]":
          return { name, type, value: [`smoke-${runId}`, "AU"] };
        default:
          return fail(
            `Unknown CSA type "${rawType}" for ${name}. Use bool, int, string or string[].`,
          );
      }
    });
}

function typeOf(value: unknown): CsaType {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "int";
  if (Array.isArray(value)) return "string[]";
  return "string";
}

/** Satisfies the Entra default password policy without being guessable. */
function newPassword(): string {
  return `Sm0ke!${randomBytes(12).toString("base64url")}`;
}

function fail(message: string): never {
  process.stderr.write(`\nlive-smoke: ${message}\n`);
  process.exit(2);
}

const HELP = `live-smoke — exercise all ${ALL_TOOLS.length} MCP tools against a real Entra SCIM tenant

Usage: npx tsx scripts/live-smoke.ts [options]
   or: npm run smoke:live            (no flags — npm swallows them on Windows)

Options:
  --confirm     Proceed without ENTRA_SCIM_LIVE=1 (~21 billed SCIM calls)
  --rehearse    Allow a dry-run or mock target; proves the script, not the API
  --csa-only    Only the two Custom Security Attribute tools (~5 calls), with a
                read-back to prove the value round-trips
  --sweep       List (and with --confirm, delete) stranded ${SMOKE_PREFIX}* users
  --help        Show this help

Reads node/.env. Required: ENTRA_TENANT_ID, ENTRA_CLIENT_ID, one of
ENTRA_CLIENT_SECRET / ENTRA_CLIENT_CERT_PATH, and ENTRA_SCIM_SMOKE_DOMAIN.
Optional: ENTRA_SCIM_SMOKE_CSA_SET, ENTRA_SCIM_SMOKE_CSA_ATTR and
ENTRA_SCIM_SMOKE_CSA_VALUE, to cover the two Custom Security Attribute tools.
`;

main().catch((err) => {
  process.stderr.write(
    `\nlive-smoke fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
