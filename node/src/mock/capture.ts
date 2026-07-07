import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CaptureEntry } from "./router.js";

/**
 * JSONL capture sink: one line per request/response pair (Authorization
 * already redacted by the router). Writes are serialized so lines never
 * interleave.
 */
export function createJsonlCapture(path: string): (entry: CaptureEntry) => void {
  let chain: Promise<void> = mkdir(dirname(path), { recursive: true }).then(
    () => undefined,
    () => undefined,
  );
  return (entry) => {
    chain = chain
      .then(() => appendFile(path, `${JSON.stringify(entry)}\n`, "utf8"))
      .catch((err: unknown) => {
        process.stderr.write(
          `entra-scim-mock: capture write failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
  };
}
