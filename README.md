# entra-scim-mcp

Model Context Protocol server for the Microsoft Entra SCIM 2.0 Provisioning API (GA April 2026). Exposes user and group lifecycle operations against `https://graph.microsoft.com/rp/scim` as MCP tools for agents like Claude.

## What you can do with it

- Discover the tenant's SCIM capabilities (`get_service_provider_config`, `list_resource_types`, `list_schemas`)
- Provision, read, update, and deprovision users — including Custom Security Attributes and lifecycle attrs
- Create, update, and delete groups, and manage membership with the API's strict PATCH rules respected automatically

## Prerequisites

Before this server can talk to your tenant, complete the one-time setup in the [Microsoft docs](https://learn.microsoft.com/entra/identity/app-provisioning/enable-scim-api):

1. Entra ID P1 (or any SKU containing P1) and an Azure subscription to link for billing.
2. Enable the **SCIM Provisioning API** in **ID Governance → Dashboard** and link a billing resource group.
3. Register an application with the Microsoft Graph **application** permissions you need:
    - `User.ReadWrite.All`, `Group.ReadWrite.All` (core lifecycle)
    - `CustomSecAttributeAssignment.ReadWrite.All`, `CustomSecAttributeDefinition.Read.All` (CSA tools)
    - `User-LifeCycleInfo.ReadWrite.All` (lifecycle tools)
    - `User-Mail.ReadWrite.All`, `User-Phone.ReadWrite.All`, `User.EnableDisableAccount.All` (least-privilege alternatives)
   Grant admin consent.
4. Create **either** a client secret **or** upload a PEM client certificate.

Every SCIM API call is billed — this server does not batch beyond what the API requires.

## Try it without an Entra tenant

The package ships a local mock of the Entra SCIM API (`entra-scim-mock-server`) so you can drive every tool with zero Azure setup and zero API billing:

```bash
# shell 1 — start the mock (seeds a small demo tenant)
npx -y --package entra-scim-mcp entra-scim-mock-server
```

Then point the MCP server at it:

```json
{
  "mcpServers": {
    "entra-scim-mock": {
      "command": "npx",
      "args": ["-y", "entra-scim-mcp"],
      "env": {
        "ENTRA_SCIM_BASE_URL": "http://127.0.0.1:8990",
        "ENTRA_SCIM_STATIC_TOKEN": "dev-token"
      }
    }
  }
}
```

Mock flags: `--port`, `--token`, `--seed <file.json>`, `--no-seed`, `--capture <file.jsonl>` (log every request/response), `--validator-compat` (RFC-standard behavior for the [Microsoft SCIM Validator](https://scimvalidator.microsoft.com) — see [docs/scim-validator.md](node/docs/scim-validator.md)).

## Install / run

The server is a stdio MCP server, designed to be launched by your MCP client (Claude Desktop, Claude Code, etc.).

```bash
npx -y entra-scim-mcp
```

Required environment:

| Var | Required | Description |
| --- | --- | --- |
| `ENTRA_TENANT_ID` | yes | Directory (tenant) GUID |
| `ENTRA_CLIENT_ID` | yes | App registration (client) GUID |
| `ENTRA_CLIENT_SECRET` | one of | Client secret value (dev) |
| `ENTRA_CLIENT_CERT_PATH` | one of | Path to a PEM containing the certificate **and** private key |
| `ENTRA_CLIENT_CERT_PASSWORD` | optional | Password if the PEM is encrypted |

Set exactly one of `ENTRA_CLIENT_SECRET` or `ENTRA_CLIENT_CERT_PATH`.

### Development / testing environment variables

| Var | Description |
| --- | --- |
| `ENTRA_SCIM_BASE_URL` | Override the SCIM base URL (default `https://graph.microsoft.com/rp/scim`). Point it at the local mock. |
| `ENTRA_SCIM_STATIC_TOKEN` | Use a fixed bearer token instead of Azure AD. **Guardrails:** requires `ENTRA_SCIM_BASE_URL`, refuses any `*.microsoft.com` / `*.microsoft.us` host, warns on non-loopback hosts, and cannot be combined with a real credential. Tenant/client IDs are not required in this mode. |
| `ENTRA_SCIM_DRY_RUN` | Set to `1`: tools run all client-side validation, then return the exact request that would have been sent instead of sending it. No token is acquired — works with zero credential config. |

Dry-run results come back as a successful payload:

```json
{
  "dryRun": true,
  "request": {
    "method": "DELETE",
    "url": "https://graph.microsoft.com/rp/scim/users/u-1",
    "headers": {}
  }
}
```

(DELETE carries no `Accept` header — the API rejects a specific JSON media type there. Every other method sends `Accept: application/json`.)

Multi-request tools (e.g. `add_group_members` beyond 20 ids) surface only their first chunked request in dry-run.

### Claude Desktop config

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "entra-scim": {
      "command": "npx",
      "args": ["-y", "entra-scim-mcp"],
      "env": {
        "ENTRA_TENANT_ID": "00000000-0000-0000-0000-000000000000",
        "ENTRA_CLIENT_ID": "11111111-1111-1111-1111-111111111111",
        "ENTRA_CLIENT_SECRET": "..."
      }
    }
  }
}
```

For production, swap the secret for a certificate:

```json
{
  "env": {
    "ENTRA_TENANT_ID": "...",
    "ENTRA_CLIENT_ID": "...",
    "ENTRA_CLIENT_CERT_PATH": "/secure/path/entra-scim-mcp.pem"
  }
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `get_service_provider_config` | One-shot capability discovery. |
| `list_resource_types` | Enumerate SCIM resource types (User, Group). |
| `list_schemas` | Enumerate SCIM schemas and Entra extensions. |
| `list_users` | List users; supports the API's restricted filter (eq/ew, and-only) and cursor pagination. |
| `get_user` | Read a single user by id with optional attribute projection. |
| `provision_user` | Create a user with the required attribute set enforced (userName, password, displayName, name.givenName, name.familyName, mailNickname). |
| `update_user` | PATCH a user; blocks `remove` of mailNickname and enforces `[type eq "work"]` on address paths. |
| `deprovision_user` | DELETE a user. |
| `update_user_lifecycle` | Set lifecycle attrs (e.g. `employeeLeaveDateTime`). Requires `User-LifeCycleInfo.ReadWrite.All`. |
| `get_user_custom_security_attributes` | Read a user's CSAs, projected by attribute set. `attributeSets` is **required** — the API rejects the bare extension URN, and CSAs never come back from a plain `get_user`. |
| `update_user_custom_security_attributes` | PATCH CSAs on a user. |
| `list_groups` | List groups with the API's restricted filter set. |
| `get_group` | Read a single group (members are NOT returned — use `list_groups` with a `members.value` filter). |
| `create_group` | POST a group. Sets `mailEnabled`, `securityEnabled`, `mailNickname`, `description` via the Entra extension. |
| `update_group` | PATCH group attributes only (membership ops are rejected here). |
| `add_group_members` | Add ≥1 users to a group — auto-chunks at 20 ids per PATCH (API cap), one Operation per PATCH. On a mid-sequence failure it reports `addedMemberIds` / `failedMemberIds` / `notAttemptedMemberIds` so partial writes are never silent. |
| `remove_group_member` | Remove a single user from a group (the API allows only one removal per PATCH, with no other ops). |
| `delete_group` | DELETE a group. |

## What this server enforces for you

The Entra SCIM API has constraints that are easy to miss. The tool layer rejects bad input before a request is sent:

- **Filter allow-list**: only the documented attributes and operators per resource; `or` is rejected; `externalId` cannot be combined with another clause.
- **Query strings**: no whitespace around `=` (the API returns 400 for any).
- **User PATCH**: `remove` of `mailNickname` is blocked; addresses path filter must be exactly `[type eq "work"]`.
- **Group PATCH**: membership ops go through dedicated tools so the 20-member add cap and the single-remove rule are guaranteed.
- **Idempotent member add**: the API treats re-adds as success; `add_group_members` dedupes input.

Errors come back to the agent as a structured payload with `status`, `scimType`, and `detail`.

## API behaviours worth knowing

Things the live API does that the docs either state ambiguously or not at all. Each was found by running against a real tenant or the Microsoft SCIM Validator, and each is handled for you — they are listed because they change how you read a response.

**DELETE must not carry an `Accept` header.** The API answers `400 Accept header application/json is invalid`. All four variants were probed live: no header → 204, `*/*` → 204, `application/json` → 400, `application/scim+json` → 400. Only DELETE inverts the rule — every other method *requires* a JSON `Accept`, and omitting it is a documented 400. This one silently broke `deprovision_user` and `delete_group` until the first live run.

**Custom Security Attributes never come back from a plain read.** In `/Schemas` the attribute-set-level attribute is `returned: "request"`, so `get_user` will not include CSAs no matter what you ask for. They only appear when named explicitly, and projection is **set-granular**: `urn:...:CustomSecurityAttributes:<Set>`. The bare extension URN is rejected outright (`400 ... not supported in the "attributes" or "excludedAttributes" query parameter`), which is why `attributeSets` is a required input rather than an optional one.

**CSA values are typed, and the type is enforced.** Boolean, Integer, String and multi-valued String all round-trip intact when sent as the matching JSON type, and one PATCH may carry several attributes at once. Two removal behaviours, neither documented by Microsoft:

- `op: "remove"` on a CSA path clears that one assignment and leaves the others intact.
- `replace` with `[]` on a multi-valued attribute **removes** the assignment — a later read omits the attribute entirely rather than returning an empty array.

**`password` is required on create but never readable.** It is `writeOnly` / `returned: never`, and no response ever echoes it. The full required create set is `userName`, `password`, `displayName`, `name.givenName`, `name.familyName` and `mailNickname` — considerably stricter than RFC 7643, which requires only `userName`.

**Group `displayName` is not unique.** Entra accepts a duplicate group name and returns 201. RFC-oriented tooling often assumes 409 here, so do not rely on create failing to detect an existing group — filter first.

**Removing a group member is about membership, not the user.** A `remove` on `members[value eq "<id>"]` that matches nothing is a **404**, whoever the id belongs to — a live user who was simply never in the group is refused exactly like a GUID that was never a user. Probed against a real tenant with a ballast member present throughout, so none of it is an artefact of emptying the group:

| Case | Result |
| --- | --- |
| A real member | 204 |
| A live user who was never a member | 404 |
| A well-formed GUID that was never a user | 404 |
| A member whose user was deleted first | 404 |

Two consequences worth knowing. Deleting a user strips their memberships, so the delete-then-remove-membership ordering lands in the same place as any other non-member — confirmed by querying `list_groups` with a `members.value` filter either side of the delete. And the error message names the **group**, not the member (`Resource '<groupId>' does not exist or one of its queried reference-property objects are not present`), which reads oddly since the group plainly exists; a probe with a deliberately bogus group id returned the same sentence naming that id, so the text simply echoes the PATCH target. The mock reproduces all of this rather than improving on it. Re-run it with `npx tsx scripts/probe-member-removal.ts --confirm` (~17 billed calls).

**Group reads never include members.** `get_group` returns no `members` array at any page size. To find a user's groups, filter the other way: `list_groups` with `members.value eq "<userId>"`.

**Errors are structured, and worth surfacing verbatim.** Failures carry `status`, `scimType` and `detail`, and the `detail` text is unusually specific (it will name the offending operation index and constraint). The tools pass it through unchanged rather than flattening it to a message.

**Every call is billed.** There is no batching beyond what the API itself requires, so a chatty agent costs real money. `add_group_members` chunks at the API's 20-member cap, which is the one place batching happens.

## Testing against a real tenant

The test suite never touches a real tenant. To verify the tools against live Entra, put credentials in a gitignored `.env` and run the smoke script.

```bash
cd node
cp .env.example .env      # then fill in tenant id, client id, and the secret VALUE
```

`.env` is read **only** by the scripts in `scripts/`. The published server always reads `process.env`, so it can never pick up a stray `.env` from whatever directory an MCP client launches it in. A variable already set in the environment always wins over the file.

| Var | Purpose |
| --- | --- |
| `ENTRA_SCIM_SMOKE_DOMAIN` | Verified domain the throwaway `scim-smoke-*` identities are created in |
| `ENTRA_SCIM_SMOKE_CSA_SET` | Attribute set name; set it to cover the two Custom Security Attribute tools |
| `ENTRA_SCIM_SMOKE_CSA_ATTR` | Attribute name within that set |
| `ENTRA_SCIM_SMOKE_CSA_VALUE` | Value to assign. CSAs are typed and the API rejects a mismatch: `true`/`false` are sent as a JSON boolean, a bare integer as a number, anything else as a string. Defaults to a string, so set this for Boolean or Integer attributes |

### The smoke script

```bash
ENTRA_SCIM_LIVE=1 npm run smoke:live              # bash
$env:ENTRA_SCIM_LIVE=1; npm run smoke:live        # PowerShell
```

To pass flags, call the script directly - `npm run x -- --flag` does not forward reliably on Windows:

```bash
npx tsx scripts/live-smoke.ts --confirm
```

One ordered pass over all 18 tools in roughly 21 billed calls. It creates two users and a group, exercises every read, PATCH and delete against them, then deletes them again. Highlights:

- **It refuses to run by accident.** Without `ENTRA_SCIM_LIVE=1` or `--confirm` it prints the tenant, endpoint and cost, then exits. With `ENTRA_SCIM_DRY_RUN` or `ENTRA_SCIM_STATIC_TOKEN` set it refuses outright unless you pass `--rehearse`, because such a run proves nothing about the live API.
- **It does not stop at the first failure.** A failed step marks its dependents `skip` and everything independent still runs, so one run tells you which tools the live API accepts. Exit code is non-zero if anything failed.
- **Test identities are obvious.** `scim-smoke-<runId>-1@<domain>` and a `SCIM Smoke <runId>` group.
- **Cleanup is guaranteed.** Everything created is deleted in a `finally` block, and any leftovers are printed with their ids. Recover from a crashed run with `npx tsx scripts/live-smoke.ts --sweep` to list stranded `scim-smoke-*` users, then add `--confirm` to delete them. The sweep will never touch an account that lacks the `scim-smoke-` prefix.

The two Custom Security Attribute tools report `skip` until an attribute set exists in the tenant (**Entra portal -> Protection -> Custom security attributes**) and `ENTRA_SCIM_SMOKE_CSA_SET` / `ENTRA_SCIM_SMOKE_CSA_ATTR` name it. Everything else runs unattended.

Once a set exists, validate just those two tools for about 9 calls instead of 21 — this reads every value back (a PATCH the API accepts but stores nothing would otherwise look like a pass), covers each declared data type, and exercises removal:

```bash
npx tsx scripts/live-smoke.ts --csa-only --confirm
```

Declare the set's shape once and the run derives a test value per type:

```
ENTRA_SCIM_SMOKE_CSA_ATTRS=isManaged:bool,accountType:string,trustLevel:int,locations:string[]
```

Confirmed live against all four types: values round-trip intact, `op: "remove"` clears one assignment and leaves the rest, and replacing a multi-valued attribute with `[]` removes it — a later read omits the attribute entirely rather than returning an empty array.

Rehearse at zero cost before spending anything - this validates the script, not the API:

```bash
# no network at all
ENTRA_SCIM_DRY_RUN=1 npx tsx scripts/live-smoke.ts --rehearse

# or against the local mock: start it in one shell...
npm run mock
# ...and in another, aim the script at it
export ENTRA_SCIM_BASE_URL=http://127.0.0.1:8990
export ENTRA_SCIM_STATIC_TOKEN=dev-token
npx tsx scripts/live-smoke.ts --rehearse
```

The mock rehearsal is the one worth doing: it exercises real HTTP, real ids and the full create/patch/delete ordering, so it catches sequencing and cleanup bugs before you spend anything. It is not a substitute for the live run — the first live pass found two bugs no mock run had caught (see [What the test legs actually caught](#what-the-test-legs-actually-caught)).

### What the test legs actually caught

Three independent legs, each of which found things the others could not — the reason all three exist:

| Leg | Cost | Found |
| --- | --- | --- |
| Mock + unit suite | free | Sequencing, validation and cleanup bugs. Fast, but shares its own assumptions, so it cannot catch a wrong assumption. |
| Live tenant (`smoke:live`) | ~21 billed calls | The DELETE `Accept` bug (two tools that had never worked), the invalid bare CSA URN, and CSA type/removal semantics. |
| [SCIM Validator](node/docs/scim-validator.md) | free | Seven mock-fidelity gaps — places the mock was more lenient than a real SCIM client expects, each of which had been hiding a real behaviour. |

The pattern worth taking away: **mock leniency hides real API behaviour.** Every defect the live run found had passed a full mock suite first, because the mock had been written from the same reading of the docs as the client. A third-party client (the validator) and a real tenant were the only things that could break that circularity.

### Driving the live tenant conversationally

The repo-root `.mcp.json` registers the server with Claude Code using `scripts/dev-server.mjs`, which loads `node/.env` and starts the built server — so no secret goes into a committed config file.

It runs the **built** server, so `node/dist` has to exist before your MCP client can launch it. A fresh clone gets there with:

```bash
cd node && npm install     # the "prepare" script builds as part of install
```

After any source change, rebuild and restart your client so it relaunches the command:

```bash
cd node && npm run build
```

## Development

```bash
cd node
npm install             # installs, then builds via "prepare"
npm test
npm run lint            # ESLint, type-aware
npm run format:check    # Prettier
npm run typecheck       # strict tsc over src, test and scripts
npm run test:coverage   # vitest with the coverage gate
npm run build           # rebuild after a source change
npm run mock            # run the local mock server (tsx, no build needed)
npm run mock:capture    # mock in validator-compat mode, capturing traffic to captures/
```

`npm run lint`, `format:check`, `typecheck` and `test` are the four gates CI
runs on every push and pull request, alongside `npm audit --audit-level=high`.

The server has no test dependency on a real tenant. Unit tests cover the filter, patch, query, and client layers; integration tests boot the in-process mock server and drive **every MCP tool end-to-end** over real HTTP (`node/test/integration/`). Captured [SCIM Validator](node/docs/scim-validator.md) sessions convert into replay fixtures with `npm run fixtures:convert`. For the one thing none of that can prove — that the live API accepts these payloads — see [Testing against a real tenant](#testing-against-a-real-tenant).

## Releasing

The version lives in four places — `node/package.json`, `node/package-lock.json`
(twice), and `server.json` (twice, once for the registry record and once for the
npm package it points at). One command writes all of them:

```bash
cd node
npm version minor          # or patch / major
git push --follow-tags
```

`npm version` bumps package.json and the lockfile, then the `version` lifecycle
script propagates it to `server.json` and stages the result, so the commit and
tag it creates are already consistent. `npm run check:version` verifies that,
and CI runs it on every push; the release workflow runs it again against the tag
itself. The version the server reports in its MCP handshake is read from
package.json at runtime, so it follows automatically.

Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml):

1. **verify** — lint, format, typecheck, tests with coverage, the version/tag
   check, and `mcp-publisher validate` against the live registry. Nothing is
   published until all of it passes.
2. **publish** — `npm publish --access public --provenance`, then waits for the
   new version to become visible on npm, then publishes `server.json` to the
   [MCP Registry](https://registry.modelcontextprotocol.io).

Required repository setup:

| What | Where | Needed for |
| --- | --- | --- |
| `NPM_TOKEN` secret | Settings → Secrets → Actions | Publishing to npm. An automation token with publish rights. |
| Nothing | — | The MCP Registry. It authenticates by GitHub OIDC, which is why the workflow requests `id-token: write`. |

The MCP Registry proves you own the npm package by fetching `package.json` and
comparing its `mcpName` to the `name` in `server.json` — both are
`io.github.darrenjrobinson/entra-scim-mcp`, and `check:version` asserts they
still match.

The first npm publish has to be done by hand, because the token has to exist
before a workflow can use it:

```bash
cd node
npm publish --access public
```

## License

MIT — see [LICENSE](LICENSE).
