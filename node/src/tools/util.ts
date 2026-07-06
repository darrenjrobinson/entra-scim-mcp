import {
  ConfigError,
  FilterValidationError,
  PatchValidationError,
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

function successResult(value: unknown): ToolResult {
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
