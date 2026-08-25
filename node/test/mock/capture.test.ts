import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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

/** Occurrences of a plain substring in a file — no regex, no escaping. */
function countMatches(path: string, needle: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split(needle).length - 1;
}

/**
 * The sink is fire-and-forget, so there is nothing to await. Poll for the
 * outcome instead of sleeping a fixed span — a filesystem rejection under a
 * loaded test run does not land on any schedule worth guessing at.
 */
async function settleUntil(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("createJsonlCapture", () => {
  it("writes one JSON line per entry, creating the directory", async () => {
    const path = join(dir, "nested", "deeper", "session.jsonl");
    const capture = createJsonlCapture(path);
    capture(entry(200));
    capture(entry(404));
    // Two entries written means the whole chain — mkdir then both appends —
    // has drained.
    await settleUntil(() => existsSync(path) && countMatches(path, "durationMs") === 2);

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
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const capture = createJsonlCapture(join(blocker, "session.jsonl"));
      capture(entry(200));
      await settleUntil(() => stderr.mock.calls.length > 0);

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
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const capture = createJsonlCapture(join(blocker, "session.jsonl"));
      for (let i = 0; i < 5; i++) capture(entry(200));
      await settleUntil(() => stderr.mock.calls.length > 0);
      // Give any second message a chance to arrive before asserting there is none.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const disabledLines = stderr.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("capture disabled"));
      expect(disabledLines).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });

  // A directory sitting where the capture FILE goes makes every appendFile
  // fail with EISDIR, while mkdir of the parent still succeeds — so the sink
  // starts up healthy and only the writes fail. Removing it makes them work
  // again, which is the transient case the sink must survive.
  it("reports a persistent write failure once, not once per request", async () => {
    const path = join(dir, "write-blocked.jsonl");
    await mkdir(path, { recursive: true });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const capture = createJsonlCapture(path);
      for (let i = 0; i < 8; i++) capture(entry(200));
      await settleUntil(() => stderr.mock.calls.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const failures = stderr.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("capture write failed"));
      expect(failures).toHaveLength(1);
      // And it is not the directory-level message: the sink is still alive.
      expect(stderr.mock.calls.map((c) => String(c[0])).join("")).not.toContain(
        "capture disabled",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("keeps writing once the failure clears, and says so", async () => {
    const path = join(dir, "write-recovers.jsonl");
    await mkdir(path, { recursive: true });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const capture = createJsonlCapture(path);
      capture(entry(500));
      await settleUntil(() => stderr.mock.calls.length > 0);

      // Clear the blockage; the sink was never disabled, so it should resume.
      await rm(path, { recursive: true, force: true });
      capture(entry(200));
      await settleUntil(() => countMatches(path, "durationMs") === 1);

      const written = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toContain("capture writes recovered");
      expect(countMatches(path, "durationMs")).toBe(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it("never throws into the request path", async () => {
    const blocker = join(dir, "blocker3");
    await writeFile(blocker, "not a directory", "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const capture = createJsonlCapture(join(blocker, "session.jsonl"));
      expect(() => capture(entry(200))).not.toThrow();
      await settleUntil(() => stderr.mock.calls.length > 0);
    } finally {
      stderr.mockRestore();
    }
  });
});
