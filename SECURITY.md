# Security Policy

`@darrenjrobinson/entra-scim-mcp` provisions identity objects in real Microsoft
Entra tenants and handles Azure AD application credentials. Vulnerability
reports are welcome and will be taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting, on the
[Security tab](https://github.com/darrenjrobinson/entra-scim-mcp/security/advisories/new)
of this repository. That opens a private advisory visible only to the
maintainers, and is the preferred channel because it keeps the report,
the fix and the eventual disclosure in one place.

What helps:

- The package version (`npm ls @darrenjrobinson/entra-scim-mcp`) and Node version.
- Whether it reproduces against the bundled mock (`entra-scim-mock-server`) or
  only against a live tenant.
- A minimal reproduction. **Redact tenant ids, client ids, secrets, certificates
  and bearer tokens** — a description of the shape of the credential is enough.

You can expect an acknowledgement within a few days, and an assessment with a
rough timeline after that. If a fix ships, you will be credited in the advisory
unless you would rather not be.

## Supported versions

Fixes land on the latest published minor. Given the package's age and size,
patches are not backported — upgrade to the latest version.

| Version | Supported |
| --- | --- |
| latest `0.x` | yes |
| anything older | no |

## Scope

In scope:

- Credential handling: token acquisition, the static-token guardrails, anything
  that could send a credential somewhere it does not belong.
- Secrets reaching an MCP client or model context — for example a password
  echoed back in a tool result.
- Input validation in the SCIM layer that could cause the server to send a
  request the caller did not authorise.
- The mock server (`entra-scim-mock-server`) where a defect could compromise
  the machine running it.

Out of scope, and deliberately so:

- **The mock server is a development tool.** It authenticates with a single
  static bearer token, stores everything in memory, and is meant for loopback.
  Do not run it as a production service or expose it to an untrusted network.
  Reports that amount to "the mock is not a hardened server" will be closed as
  working-as-intended.
- Anything requiring an attacker who already controls the environment the
  server runs in — they already hold the credentials it reads from
  `process.env`.
- The Microsoft Entra SCIM API itself. Report those to Microsoft through
  [MSRC](https://msrc.microsoft.com/report).
- Advisories against development-only dependencies with no runtime path,
  unless you can show one.

## Notes for operators

- This server reads credentials from `process.env` and never from a file next
  to it — the `.env` support lives in `scripts/`, which is not published.
- Prefer a certificate over a client secret for anything long-lived.
- Every SCIM call is billed, so a credential leak has a direct cost as well as
  a security consequence.
- Grant only the Graph application permissions the tools you actually use
  require; the README lists them per tool group.
