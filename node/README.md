# @darrenjrobinson/entra-scim-mcp

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
npx -y --package @darrenjrobinson/entra-scim-mcp entra-scim-mock-server
```

Then point the MCP server at it:

```json
{
  "mcpServers": {
    "entra-scim-mock": {
      "command": "npx",
      "args": ["-y", "@darrenjrobinson/entra-scim-mcp"],
      "env": {
        "ENTRA_SCIM_BASE_URL": "http://127.0.0.1:8990",
        "ENTRA_SCIM_STATIC_TOKEN": "dev-token"
      }
    }
  }
}
```

Mock flags: `--port`, `--token`, `--seed <file.json>`, `--no-seed`, `--capture <file.jsonl>` (log every request/response), `--validator-compat` (RFC-standard behavior for the [Microsoft SCIM Validator](https://scimvalidator.microsoft.com) — see [docs/scim-validator.md](docs/scim-validator.md)).

## Install / run

The server is a stdio MCP server, designed to be launched by your MCP client (Claude Desktop, Claude Code, etc.).

```bash
npx -y @darrenjrobinson/entra-scim-mcp
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
    "headers": { "Accept": "application/json" }
  }
}
```

Multi-request tools (e.g. `add_group_members` beyond 20 ids) surface only their first chunked request in dry-run.

### Claude Desktop config

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "entra-scim": {
      "command": "npx",
      "args": ["-y", "@darrenjrobinson/entra-scim-mcp"],
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
| `get_user_custom_security_attributes` | Read a user's CSA extension only. Pass `attributeSets` for the documented set-qualified projection. |
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

## Development

```bash
cd node
npm install
npm test
npm run build
npm run mock            # run the local mock server (tsx, no build needed)
npm run mock:capture    # mock in validator-compat mode, capturing traffic to captures/
```

The server has no test dependency on a real tenant. Unit tests cover the filter, patch, query, and client layers; integration tests boot the in-process mock server and drive **every MCP tool end-to-end** over real HTTP (`test/integration/`). Captured [SCIM Validator](docs/scim-validator.md) sessions convert into replay fixtures with `npm run fixtures:convert`.

## License

MIT
