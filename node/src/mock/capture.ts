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

  // Write failures are reported on the transition into failure, not once per
  // request: a jammed disk during a long --capture session would otherwise
  // emit a line for every request served.
  //
  // They do not disable the sink the way a missing directory does, and the
  // asymmetry is deliberate. A directory that cannot be created will never
  // become creatable, so every later write is certain to fail too. A write can
  // fail and then succeed — a full disk gets freed, a lock gets released — and
  // dropping the rest of a session over a transient error is the silent loss
  // that this sink was fixed to stop. So it keeps trying, and says so when
  // writes come back.
  let writeFailing = false;

  return (entry) => {
    if (disabled) return;
    chain = chain
      .then(async () => {
        if (disabled) return;
        await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
        if (writeFailing) {
          writeFailing = false;
          process.stderr.write(`entra-scim-mock: capture writes recovered\n`);
        }
      })
      .catch((err: unknown) => {
        if (writeFailing) return;
        writeFailing = true;
        process.stderr.write(
          `entra-scim-mock: capture write failed, retrying quietly until it recovers: ${describe(err)}\n`,
        );
      });
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
