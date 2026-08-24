# Testing with the Microsoft SCIM Validator

The [Microsoft SCIM Validator](https://scimvalidator.microsoft.com) contract-tests a SCIM endpoint the way Entra's *outbound* provisioning client would use it: schema discovery, user/group CRUD, PATCH semantics, filtering. Pointing it at `entra-scim-mock-server` validates the SCIM plumbing this project relies on — without touching the billed Entra SCIM Provisioning API.

## What this proves (and what it can't)

The validator + mock + MCP-test-suite triangle:

```
Microsoft SCIM Validator
        ↓
entra-scim-mock-server
        ↑
entra-scim-mcp test suite (test/integration/tools-e2e.test.ts)
```

If both the validator and the MCP test suite agree with the mock, the boring SCIM plumbing risk is gone. It does **not** prove: that the real inbound API at `graph.microsoft.com/rp/scim` accepts your payloads, that your app registration/consent is correct, that the SCIM Provisioning API feature + billing link is enabled, or anything about quota/cost. Those needed a live-tenant pass, which happened on 2026-08-24 via `npm run smoke:live` — it found two real defects (see the live-tenant pass section of [REVIEW.md](../../REVIEW.md)). Re-run it after any change to the client or tool layer.

Note the validator expects RFC-standard SCIM, while Entra's inbound API has stricter rules (restricted filters, membership PATCH constraints, members never returned on group reads). That's what `--validator-compat` is for: it relaxes the mock to accept-superset behavior. CI never depends on the validator — the replay fixtures below keep its findings in the repo.

## Workflow

1. **Start the mock in compat mode with capture on:**

   ```bash
   cd node
   npm run mock:capture
   # = tsx src/mock/cli.ts --validator-compat --capture captures/validator-session.jsonl
   ```

2. **Expose it with a dev tunnel** (pick one):

   ```bash
   ngrok http 8990
   # or
   cloudflared tunnel --url http://127.0.0.1:8990
   # or VS Code: Ports panel → Forward a Port → 8990 → Public
   ```

3. **Point the validator at the tunnel URL** at https://scimvalidator.microsoft.com — choose *Discover schema*, set the bearer token to the mock's token (`dev-token` unless you passed `--token`), and run the User (and optionally Group) test suites.

4. **Convert the captured session into a replay fixture:**

   ```bash
   npm run fixtures:convert -- captures/validator-session.jsonl test/fixtures/validator/<name>.json
   ```

   The converter aliases created ids (`{{user1}}` …) so the fixture replays against a fresh store, and strips volatile fields (`meta`, cursors) from expectations.

5. **Re-run the suite** — `npm test` picks the fixture up in `test/replay.validator.test.ts` and replays every request against a freshly booted mock, asserting status codes and body subsets.

6. Commit the fixture. Raw captures under `captures/` are gitignored working data.

## Committed fixtures

- `user-crud.json` — small hand-checked walkthrough.
- `validator-user-group.json` — a real 112-request Microsoft SCIM Validator session (User + Group suites, 2026-08-24) replayed against a freshly booted mock. This is the regression net for everything the validator run taught us: RFC address path filters, boolean/string `primary` coercion, `manager` normalisation, duplicate-group 409, and the password-free compat schema. If a change to the mock breaks any of it, this fixture fails without needing a tunnel or a browser.

A capture may contain more than one validator run (each starts with `GET /Schemas`). Trim it to a single run before converting — two concatenated runs double the fixture size for no extra coverage.

## Fixture format

```json
{
  "name": "user-crud",
  "validatorCompat": true,
  "steps": [
    {
      "request": { "method": "POST", "path": "/users", "body": { "...": "..." } },
      "expect": { "status": 201, "bodySubset": { "userName": "..." } },
      "capture": { "user1": "id" }
    },
    {
      "request": { "method": "GET", "path": "/users/{{user1}}" },
      "expect": { "status": 200, "bodySubset": { "userName": "..." } }
    }
  ]
}
```

- `capture` stores a response field under an alias; `{{alias}}` placeholders are resolved in later request paths/bodies **and** in `bodySubset` expectations.
- `bodySubset` is a deep-subset assertion: extra fields in the actual response are fine, arrays are compared index-wise.
- `validatorCompat` controls which mode the replay boots the mock in (defaults to `true`).

## Strict mode vs validator-compat

| Behavior | strict (default) | `--validator-compat` |
| --- | --- | --- |
| Filters | Entra allow-list only (`eq`/`ew`, `and`-only) | any parseable `attr op "value"` filter |
| Pagination | cursor only | cursor + `startIndex`/`count` |
| Group reads | `members` never returned | `members` included |
| Group membership PATCH | single-op, 20-add cap, single remove | RFC-standard (mixed ops, `replace`, multi-remove) |
| PATCH response | `204 No Content` | `200` + updated resource |
| Accept header | must allow JSON (like the real API) | not enforced |
