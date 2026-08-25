export interface ScimErrorPayload {
  status: number;
  scimType?: string;
  detail?: string;
  schemas?: string[];
}

export class ScimError extends Error {
  readonly status: number;
  readonly scimType?: string;
  readonly detail?: string;
  readonly raw?: unknown;

  constructor(payload: ScimErrorPayload, raw?: unknown) {
    super(payload.detail ?? `SCIM request failed with status ${payload.status}`);
    this.name = "ScimError";
    this.status = payload.status;
    this.scimType = payload.scimType;
    this.detail = payload.detail;
    this.raw = raw;
  }

  toJSON(): ScimErrorPayload & { raw?: unknown } {
    return {
      status: this.status,
      scimType: this.scimType,
      detail: this.detail,
      raw: this.raw,
    };
  }
}

export interface DryRunRequestInfo {
  method: string;
  url: string;
  /** Outbound headers minus Authorization — the token is never acquired. */
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * Thrown by ScimClient in dry-run mode instead of sending the request. Not an
 * error in the usual sense: wrapTool converts it into a successful tool result
 * describing the request that would have been sent.
 */
export class DryRunRequest extends Error {
  readonly request: DryRunRequestInfo;

  constructor(request: DryRunRequestInfo) {
    super(`Dry run: ${request.method} ${request.url}`);
    this.name = "DryRunRequest";
    this.request = request;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class FilterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterValidationError";
  }
}

/**
 * A query string the Entra SCIM API would reject before any handler sees it —
 * today, whitespace around "=". Distinct from FilterValidationError because
 * the offending parameter need not be a filter: `count`, `cursor` and
 * `attributes` reach the same rule.
 */
export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryValidationError";
  }
}

export class PatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchValidationError";
  }
}
