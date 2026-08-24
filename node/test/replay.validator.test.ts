import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { createMockServer } from "../src/mock/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface FixtureStep {
  request: { method: string; path: string; body?: unknown };
  expect: { status: number; bodySubset?: unknown };
  capture?: Record<string, string>;
}

interface Fixture {
  name: string;
  validatorCompat?: boolean;
  steps: FixtureStep[];
}

const FIXTURES_DIR = join(__dirname, "fixtures", "validator");
const TOKEN = "replay-token";

function loadFixtures(): Fixture[] {
  let files: string[];
  try {
    files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map(
    (file) => JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")) as Fixture,
  );
}

const fixtures = loadFixtures();

describe("validator fixture replay", () => {
  if (fixtures.length === 0) {
    it.skip("no fixtures found in test/fixtures/validator — run a validator session with `npm run mock:capture` and convert it with `npm run fixtures:convert`", () => {});
    return;
  }

  for (const fixture of fixtures) {
    it(`replays ${fixture.name} (${fixture.steps.length} steps)`, async () => {
      const mock = createMockServer({
        token: TOKEN,
        validatorCompat: fixture.validatorCompat ?? true,
      });
      const { url } = await mock.listen(0);
      const aliases = new Map<string, string>();
      try {
        for (const [index, step] of fixture.steps.entries()) {
          const path = substitute(step.request.path, aliases);
          const body =
            step.request.body !== undefined
              ? JSON.parse(
                  substitute(JSON.stringify(step.request.body), aliases),
                )
              : undefined;

          const res = await fetch(`${url}${path}`, {
            method: step.request.method,
            headers: {
              Authorization: `Bearer ${TOKEN}`,
              // Mirrors ScimClient: DELETE must not carry an Accept header.
              ...(step.request.method.toUpperCase() === "DELETE"
                ? {}
                : { Accept: "application/json" }),
              ...(body !== undefined
                ? { "Content-Type": "application/scim+json" }
                : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });

          const text = await res.text();
          const responseBody = text ? (JSON.parse(text) as unknown) : undefined;

          expect(
            res.status,
            `step ${index + 1} ${step.request.method} ${path}: ${text.slice(0, 300)}`,
          ).toBe(step.expect.status);

          if (step.capture) {
            for (const [alias, field] of Object.entries(step.capture)) {
              const value = (responseBody as Record<string, unknown>)?.[field];
              expect(
                typeof value,
                `step ${index + 1}: capture field '${field}' missing`,
              ).toBe("string");
              aliases.set(alias, value as string);
            }
          }

          if (step.expect.bodySubset !== undefined) {
            // Resolve {{alias}} placeholders inside the expectation too —
            // converted fixtures alias ids in response bodies. Capture runs
            // first so a 201's own body can reference its new alias.
            const expected = JSON.parse(
              substitute(JSON.stringify(step.expect.bodySubset), aliases),
            ) as unknown;
            expectSubset(responseBody, expected, `step ${index + 1}`);
          }
        }
      } finally {
        await mock.close();
      }
    });
  }
});

function substitute(text: string, aliases: Map<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const value = aliases.get(name);
    if (value === undefined) {
      throw new Error(`Unresolved alias {{${name}}}`);
    }
    return value;
  });
}

/** Deep-subset assertion: every expected key/element must match in actual. */
function expectSubset(actual: unknown, expected: unknown, path: string): void {
  if (expected === null || typeof expected !== "object") {
    expect(actual, path).toEqual(expected);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path}: expected an array`).toBe(true);
    const actualArray = actual as unknown[];
    expect(
      actualArray.length,
      `${path}: array shorter than expected subset`,
    ).toBeGreaterThanOrEqual(expected.length);
    expected.forEach((element, i) =>
      expectSubset(actualArray[i], element, `${path}[${i}]`),
    );
    return;
  }
  expect(
    actual !== null && typeof actual === "object",
    `${path}: expected an object, got ${JSON.stringify(actual)?.slice(0, 120)}`,
  ).toBe(true);
  for (const [key, value] of Object.entries(expected)) {
    expectSubset(
      (actual as Record<string, unknown>)[key],
      value,
      `${path}.${key}`,
    );
  }
}
