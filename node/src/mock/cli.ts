#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createJsonlCapture } from "./capture.js";
import { createMockServer, DEFAULT_MOCK_PORT, DEFAULT_MOCK_TOKEN } from "./server.js";
import { demoSeed, loadSeedFile } from "./seed.js";

const HELP = `entra-scim-mock-server — local mock of the Entra SCIM 2.0 Provisioning API

Usage: entra-scim-mock-server [options]

Options:
  --port <n>          Port to listen on (default ${DEFAULT_MOCK_PORT})
  --token <token>     Required bearer token (default "${DEFAULT_MOCK_TOKEN}",
                      env ENTRA_SCIM_MOCK_TOKEN)
  --seed <file.json>  Seed users/groups from a JSON file ({users, groups});
                      omit for a small demo tenant, use --no-seed for empty
  --no-seed           Start with an empty tenant
  --capture <file>    Append every request/response pair as JSONL
  --validator-compat  RFC-standard behavior for the Microsoft SCIM Validator
                      (index pagination, members on group reads, any-attribute
                      filters, 200 + resource on PATCH)
  --help              Show this help
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      token: { type: "string" },
      seed: { type: "string" },
      "no-seed": { type: "boolean" },
      capture: { type: "string" },
      "validator-compat": { type: "boolean" },
      help: { type: "boolean" },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const port = values.port ? Number(values.port) : DEFAULT_MOCK_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port: ${values.port}`);
  }
  const token =
    values.token ?? process.env.ENTRA_SCIM_MOCK_TOKEN ?? DEFAULT_MOCK_TOKEN;

  const seed = values["no-seed"]
    ? undefined
    : values.seed
      ? await loadSeedFile(values.seed)
      : demoSeed();

  const mock = createMockServer({
    token,
    seed,
    validatorCompat: values["validator-compat"] ?? false,
    onTransaction: values.capture ? createJsonlCapture(values.capture) : undefined,
  });

  const { url } = await mock.listen(port);
  const seededUsers = mock.store.listUsers().length;
  const seededGroups = mock.store.listGroups().length;

  process.stdout.write(
    `entra-scim-mock-server listening on ${url}\n` +
      `  mode:    ${values["validator-compat"] ? "validator-compat (RFC-standard)" : "strict Entra"}\n` +
      `  seeded:  ${seededUsers} user(s), ${seededGroups} group(s)\n` +
      (values.capture ? `  capture: ${values.capture}\n` : "") +
      `\nPoint the MCP server at it with:\n\n` +
      `  ENTRA_SCIM_BASE_URL=${url}\n` +
      `  ENTRA_SCIM_STATIC_TOKEN=${token}\n\n` +
      `Press Ctrl+C to stop.\n`,
  );

  const shutdown = (): void => {
    void mock.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `entra-scim-mock-server fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
