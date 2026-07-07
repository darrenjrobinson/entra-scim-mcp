export const SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

/** Error carrying the HTTP status + scimType the mock should respond with. */
export class MockScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string,
  ) {
    super(message);
    this.name = "MockScimError";
  }
}

/**
 * SCIM error body as the real API shapes it — note `status` is a string
 * (matches the documented examples).
 */
export function scimErrorBody(
  status: number,
  detail: string,
  scimType?: string,
): Record<string, unknown> {
  return {
    schemas: [SCHEMA_ERROR],
    status: String(status),
    detail,
    ...(scimType ? { scimType } : {}),
  };
}
