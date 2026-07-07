#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAuthFromEnv } from "./scim/auth.js";
import { ScimClient } from "./scim/client.js";
import { SCIM_BASE_URL } from "./scim/types.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const baseUrl = process.env.ENTRA_SCIM_BASE_URL?.trim() || SCIM_BASE_URL;
  const auth = loadAuthFromEnv(process.env, { baseUrl });
  const client = new ScimClient({ credential: auth.credential, baseUrl });
  const { server } = createServer({ auth, client });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`entra-scim-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
