#!/usr/bin/env tsx
/**
 * Convert a mock-server JSONL capture (produced with --capture, e.g. from a
 * Microsoft SCIM Validator session) into a replay fixture consumed by
 * test/replay.validator.test.ts.
 *
 * Usage: npm run fixtures:convert -- captures/validator-session.jsonl test/fixtures/validator/<name>.json
 *
 * - Builds an id-alias map from 201 responses (user1, group1, ...) and
 *   replaces those ids in later request paths/bodies with {{alias}}
 *   placeholders so replays against a fresh store work.
 * - Strips volatile fields (id, meta) from response expectations, keeping a
 *   bodySubset the replay asserts with deep-subset matching.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

interface CaptureEntry {
  request: { method: string; url: string; body?: unknown };
  response: { status: number; body?: unknown };
}

interface FixtureStep {
  request: { method: string; path: string; body?: unknown };
  expect: { status: number; bodySubset?: unknown };
  capture?: Record<string, string>;
}

async function main(): Promise<void> {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    process.stderr.write(
      "Usage: fixtures:convert -- <capture.jsonl> <fixture.json>\n",
    );
    process.exit(1);
  }

  const lines = (await readFile(input, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const entries = lines.map((line) => JSON.parse(line) as CaptureEntry);

  // Pass 1: assign aliases to ids minted by 201 responses.
  const aliasById = new Map<string, string>();
  let userCount = 0;
  let groupCount = 0;
  for (const entry of entries) {
    if (entry.response.status !== 201) continue;
    const body = entry.response.body as { id?: unknown } | undefined;
    if (!body || typeof body.id !== "string") continue;
    const isGroup = /\/groups/i.test(entry.request.url);
    const alias = isGroup ? `group${++groupCount}` : `user${++userCount}`;
    aliasById.set(body.id, alias);
  }

  // Pass 2: build steps with alias substitution + volatile-field stripping.
  const steps: FixtureStep[] = entries.map((entry) => {
    const step: FixtureStep = {
      request: {
        method: entry.request.method,
        path: aliasify(entry.request.url, aliasById) as string,
        ...(entry.request.body !== undefined
          ? { body: aliasify(entry.request.body, aliasById) }
          : {}),
      },
      expect: { status: entry.response.status },
    };
    if (entry.response.body !== undefined) {
      step.expect.bodySubset = stripVolatile(
        aliasify(entry.response.body, aliasById),
      );
    }
    const createdId = (entry.response.body as { id?: unknown } | undefined)?.id;
    if (
      entry.response.status === 201 &&
      typeof createdId === "string" &&
      aliasById.has(createdId)
    ) {
      step.capture = { [aliasById.get(createdId)!]: "id" };
      // The alias placeholder in a 201's own body is the capture source; drop
      // it from the assertion.
      if (step.expect.bodySubset && typeof step.expect.bodySubset === "object") {
        delete (step.expect.bodySubset as Record<string, unknown>).id;
      }
    }
    return step;
  });

  const fixture = {
    name: basename(output).replace(/\.json$/i, ""),
    source: basename(input),
    validatorCompat: true,
    steps,
  };

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Wrote ${steps.length} step(s), ${aliasById.size} alias(es) -> ${output}\n`,
  );
}

/** Replace every known id occurrence (in strings, keys stay) with {{alias}}. */
function aliasify(value: unknown, aliasById: Map<string, string>): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const [id, alias] of aliasById) {
      result = result.split(id).join(`{{${alias}}}`);
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => aliasify(item, aliasById));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, aliasify(v, aliasById)]),
    );
  }
  return value;
}

/** Drop fields that differ per run: meta everywhere, itemsPerPage/cursors. */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (["meta", "nextCursor", "itemsPerPage"].includes(key)) continue;
      result[key] = stripVolatile(v);
    }
    return result;
  }
  return value;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
