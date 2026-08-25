import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CaptureEntry } from "./router.js";

/**
 * JSONL capture sink: one line per request/response pair (Authorization
 * already redacted by the router). Writes are serialized so lines never
 * interleave.
 */
export function createJsonlCapture(path: string): (entry: CaptureEntry) => void {
  const dir = dirname(path);
  let disabled = false;

  // `mkdir` with recursive:true already resolves when the directory exists, so
  // there is no benign rejection left to ignore here — a failure means no
  // permission, a file sitting on the path, or a read-only volume, and every
  // appendFile after it would fail the same way. Swallowing it cost the whole
  // capture in silence, which for a session you are running precisely to
  // record is the worst available outcome.
  let chain: Promise<void> = mkdir(dir, { recursive: true }).then(
    () => undefined,
    (err: unknown) => {
      disabled = true;
      process.stderr.write(
        `entra-scim-mock: capture disabled — cannot create ${dir}: ${describe(err)}\n`,
      );
    },
  );

  return (entry) => {
    if (disabled) return;
    chain = chain
      .then(() =>
        disabled ? undefined : appendFile(path, `${JSON.stringify(entry)}\n`, "utf8"),
      )
      .catch((err: unknown) => {
        process.stderr.write(`entra-scim-mock: capture write failed: ${describe(err)}\n`);
      });
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
