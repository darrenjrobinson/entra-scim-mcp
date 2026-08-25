#!/usr/bin/env node
// Write one version into every file that carries it, so they cannot drift.
//
//   node scripts/set-version.mjs 0.2.0   set an explicit version everywhere
//   node scripts/set-version.mjs         take package.json's version and
//                                        propagate it (the npm `version` hook)
//
// The second form is what `npm version patch|minor|major` uses: npm bumps
// package.json and the lockfile itself, then runs the `version` lifecycle
// script, and this copies the result into server.json before npm makes the
// commit and tag.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "..");

const paths = {
  pkg: resolve(packageDir, "package.json"),
  lock: resolve(packageDir, "package-lock.json"),
  server: resolve(repoRoot, "server.json"),
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Rewrite JSON in place, preserving npm's 2-space + trailing-newline style. */
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const requested = process.argv[2];
if (requested && !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(requested)) {
  process.stderr.write(`set-version: "${requested}" is not a semver version\n`);
  process.exit(1);
}

const pkg = readJson(paths.pkg);
const version = requested ?? pkg.version;
const changed = [];

if (pkg.version !== version) {
  pkg.version = version;
  writeJson(paths.pkg, pkg);
  changed.push("node/package.json");
}

// The lockfile names the version twice: once at the top, once in the entry for
// the root package itself.
const lock = readJson(paths.lock);
if (lock.version !== version || lock.packages?.[""]?.version !== version) {
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  writeJson(paths.lock, lock);
  changed.push("node/package-lock.json");
}

const server = readJson(paths.server);
let serverChanged = server.version !== version;
server.version = version;
for (const entry of server.packages ?? []) {
  if (entry.version !== version) {
    entry.version = version;
    serverChanged = true;
  }
}
if (serverChanged) {
  writeJson(paths.server, server);
  changed.push("server.json");
}

process.stdout.write(
  changed.length > 0
    ? `set-version: ${version} written to ${changed.join(", ")}\n`
    : `set-version: already at ${version} everywhere\n`,
);
