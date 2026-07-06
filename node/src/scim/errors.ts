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

export class PatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchValidationError";
  }
}
