#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAuthFromEnv } from "./scim/auth.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const auth = loadAuthFromEnv();
  const { server } = createServer({ auth });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`entra-scim-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
