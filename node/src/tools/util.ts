import {
  ConfigError,
  DryRunRequest,
  FilterValidationError,
  PatchValidationError,
  QueryValidationError,
  ScimError,
} from "../scim/errors.js";

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: ToolTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type ToolHandler<Args> = (args: Args) => Promise<ToolResult>;

/**
 * Thrown by tool handlers that need to fail with a structured payload richer
 * than a single underlying error — e.g. a multi-request tool reporting which
 * parts of a partially-applied change succeeded.
 */
export class ToolError extends Error {
  readonly payload: Record<string, unknown>;

  constructor(payload: Record<string, unknown>) {
    super(typeof payload.detail === "string" ? payload.detail : "Tool failed");
    this.name = "ToolError";
    this.payload = payload;
  }
}

/**
 * Join attribute names for a projection query param. An empty array must
 * become undefined — `attributes=` with no value trips the API's strict
 * query-string parser.
 */
export function joinAttributes(names: string[] | undefined): string | undefined {
  return names?.length ? names.join(",") : undefined;
}

/** Keys whose value must never appear in a tool result. Matched case-insensitively. */
const SECRET_KEYS = new Set(["password"]);

/**
 * Remove secret-bearing keys from anything a tool is about to hand back.
 *
 * Applied at the boundary rather than at the one call site that sends a
 * password, because the boundary is the thing that cannot be forgotten: a tool
 * added later, an API that starts echoing a field it currently declares
 * `writeOnly`/`returned: never`, or this client pointed at a different SCIM
 * backend are all covered without anyone remembering to.
 *
 * It is not decoration. Dry-run reflects the outbound request back as the tool
 * result, so `provision_user --dry-run` handed the model the plaintext
 * password it had just been given — the one payload in the system that
 * genuinely holds a secret.
 *
 * Walks arrays and nested objects; primitives, null and undefined pass through
 * unchanged. Responses are parsed JSON, so there are no cycles to guard.
 */
export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key.toLowerCase())) continue;
    out[key] = stripSecrets(nested);
  }
  return out;
}

export function wrapTool<Args>(
  handler: (args: Args) => Promise<unknown>,
): ToolHandler<Args> {
  return async (args) => {
    try {
      const result = await handler(args);
      return successResult(result);
    } catch (err) {
      return errorResult(err);
    }
  };
}

function successResult(raw: unknown): ToolResult {
  const value = stripSecrets(raw);
  if (value === undefined) {
    return {
      content: [{ type: "text", text: "OK" }],
      structuredContent: { ok: true },
    };
  }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: asRecord(value),
  };
}

function errorResult(err: unknown): ToolResult {
  if (err instanceof DryRunRequest) {
    // Not an error: the tool ran all validation and reports the request it
    // would have sent.
    const payload: Record<string, unknown> = {
      dryRun: true,
      request: stripSecrets(err.request) as Record<string, unknown>,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  }
  if (err instanceof ToolError) {
    return {
      content: [{ type: "text", text: JSON.stringify(err.payload, null, 2) }],
      structuredContent: err.payload,
      isError: true,
    };
  }
  if (err instanceof ScimError) {
    const payload: Record<string, unknown> = {
      error: "ScimError",
      status: err.status,
      scimType: err.scimType,
      detail: err.detail,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: true,
    };
  }
  if (
    err instanceof FilterValidationError ||
    err instanceof PatchValidationError ||
    err instanceof QueryValidationError ||
    err instanceof ConfigError
  ) {
    const payload: Record<string, unknown> = {
      error: err.name,
      detail: err.message,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: true,
    };
  }
  // Unknown — surface the message but mark as error rather than throwing,
  // so MCP clients always receive a structured response.
  const message = err instanceof Error ? err.message : String(err);
  const payload: Record<string, unknown> = {
    error: "UnexpectedError",
    detail: message,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return { value };
  return value as Record<string, unknown>;
}
