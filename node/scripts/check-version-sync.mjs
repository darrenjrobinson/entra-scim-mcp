#!/usr/bin/env node
// The version lives in four places that must agree, and three of them are
// nowhere near each other:
//
//   node/package.json  version      the published npm package
//   node/package.json  mcpName      the identity the MCP Registry verifies
//   server.json        version      the registry's record of the release
//   server.json        packages[]   the npm package that record points at
//
// A release that disagrees with itself either fails deep inside `mcp-publisher`
// with a message about ownership, or succeeds and publishes a registry entry
// pointing at a version of the package that does not exist. Both are worse to
// diagnose than a failed check here.
//
// Run bare to check the files agree. Pass a tag (or set GITHUB_REF_NAME in a
// tag-triggered workflow) to also require the tag to match.
//
//   node scripts/check-version-sync.mjs
//   node scripts/check-version-sync.mjs v0.2.0

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "..");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`cannot read ${path}: ${err.message}`);
  }
}

const problems = [];
function check(condition, message) {
  if (!condition) problems.push(message);
}
function fail(message) {
  process.stderr.write(`check-version-sync: ${message}\n`);
  process.exit(1);
}

const pkg = readJson(resolve(packageDir, "package.json"));
const lock = readJson(resolve(packageDir, "package-lock.json"));
const server = readJson(resolve(repoRoot, "server.json"));

const version = pkg.version;
check(
  typeof version === "string" && /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version),
  `package.json version "${version}" is not a semver string`,
);

// npm writes the version into the lockfile twice; a hand-edited package.json
// leaves both stale, and `npm ci` then reinstalls the old one.
check(
  lock.version === version,
  `package-lock.json version "${lock.version}" does not match package.json "${version}"`,
);
check(
  lock.packages?.[""]?.version === version,
  `package-lock.json packages[""].version "${lock.packages?.[""]?.version}" does not match package.json "${version}"`,
);

check(
  server.version === version,
  `server.json version "${server.version}" does not match package.json "${version}"`,
);

check(
  pkg.mcpName === server.name,
  `package.json mcpName "${pkg.mcpName}" does not match server.json name "${server.name}" — ` +
    `the MCP Registry verifies npm ownership by comparing exactly these two`,
);

const packages = Array.isArray(server.packages) ? server.packages : [];
check(packages.length > 0, "server.json declares no packages");

for (const [i, entry] of packages.entries()) {
  check(
    entry.version === version,
    `server.json packages[${i}].version "${entry.version}" does not match package.json "${version}"`,
  );
  if (entry.registryType === "npm") {
    check(
      entry.identifier === pkg.name,
      `server.json packages[${i}].identifier "${entry.identifier}" does not match package.json name "${pkg.name}"`,
    );
    check(
      entry.registryBaseUrl === "https://registry.npmjs.org",
      `server.json packages[${i}].registryBaseUrl must be https://registry.npmjs.org ` +
        `(the official registry accepts no other npm source), got "${entry.registryBaseUrl}"`,
    );
  }
}

// A tag is only checked when one is supplied — most runs of this are local.
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (tag && tag.startsWith("v")) {
  check(
    tag === `v${version}`,
    `tag "${tag}" does not match package.json version "${version}" (expected "v${version}")`,
  );
}

if (problems.length > 0) {
  process.stderr.write(`check-version-sync: ${problems.length} problem(s)\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.stderr.write(
    `\nUpdate every place at once with:  npm run version:set -- <new-version>\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `check-version-sync: ${version} consistent across package.json and server.json` +
    (tag ? ` and tag ${tag}` : "") +
    `\n`,
);
