#!/usr/bin/env node
// Launches the built stdio MCP server with credentials from node/.env, so an
// MCP client config never has to hold a secret. Used by the repo-root
// .mcp.json; for the real npm package, put env in the client config instead.
//
// Everything this file prints goes to stderr: stdout is the MCP framing channel.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDotEnv } from "./lib/dotenv.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const envFile = resolve(packageDir, ".env");
const entry = resolve(packageDir, "dist/index.js");

const applied = loadDotEnv(envFile);
process.stderr.write(
  applied.length
    ? `dev-server: loaded ${applied.length} var(s) from ${envFile} (${applied.join(", ")})\n`
    : `dev-server: no vars loaded from ${envFile} (missing, or all already set in the environment)\n`,
);

if (!existsSync(entry)) {
  process.stderr.write(
    `dev-server: ${entry} not found.\n` +
      `This launcher runs the *built* server. From a fresh clone:\n` +
      `  cd node && npm install\n` +
      `which builds it through the "prepare" script. To rebuild by hand:\n` +
      `  cd node && npm run build\n` +
      `Then restart your MCP client so it relaunches this command.\n`,
  );
  process.exit(1);
}

// dist/index.js self-starts on import and installs its own fatal handler.
await import(pathToFileURL(entry).href);
