import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlCapture } from "../../src/mock/capture.js";
import type { CaptureEntry } from "../../src/mock/router.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "entra-scim-capture-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(status: number): CaptureEntry {
  return {
    ts: "2026-08-25T00:00:00.000Z",
    request: { method: "GET", url: "/users", headers: {} },
    response: { status },
    durationMs: 1,
  };
}

/** The sink is fire-and-forget; let its serialized chain drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("createJsonlCapture", () => {
  it("writes one JSON line per entry, creating the directory", async () => {
    const path = join(dir, "nested", "deeper", "session.jsonl");
    const capture = createJsonlCapture(path);
    capture(entry(200));
    capture(entry(404));
    await settle();

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]!) as CaptureEntry).response.status).toBe(200);
    expect((JSON.parse(lines[1]!) as CaptureEntry).response.status).toBe(404);
  });

  it("reports a directory it cannot create instead of swallowing it", async () => {
    // A plain file where the capture directory must go: mkdir cannot recover,
    // and neither can any appendFile after it.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const capture = createJsonlCapture(join(blocker, "session.jsonl"));
      capture(entry(200));
      await settle();

      const written = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toMatch(/capture disabled/);
      expect(written).toMatch(/cannot create/);
    } finally {
      stderr.mockRestore();
    }
  });

  it("says so once, not once per request", async () => {
    const blocker = join(dir, "blocker2");
    await writeFile(blocker, "not a directory", "utf8");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const capture = createJsonlCapture(join(blocker, "session.jsonl"));
      for (let i = 0; i < 5; i++) capture(entry(200));
      await settle();

      const disabledLines = stderr.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("capture disabled"));
      expect(disabledLines).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it("never throws into the request path", async () => {
    const blocker = join(dir, "blocker3");
    await writeFile(blocker, "not a directory", "utf8");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const capture = createJsonlCapture(join(blocker, "session.jsonl"));
      expect(() => capture(entry(200))).not.toThrow();
      await settle();
    } finally {
      stderr.mockRestore();
    }
  });
});
