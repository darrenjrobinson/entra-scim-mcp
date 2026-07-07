import type { TokenCredential } from "@azure/identity";
import { DryRunRequest, ScimError } from "./errors.js";
import { GRAPH_SCOPE } from "./auth.js";
import { SCIM_BASE_URL } from "./types.js";
import { buildQueryString, type QueryParams } from "./query.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface ScimRequestOptions {
  method: HttpMethod;
  path: string;
  body?: unknown;
  query?: QueryParams;
}

export interface ScimClientOptions {
  credential: TokenCredential;
  baseUrl?: string;
  fetcher?: typeof fetch;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Per-attempt timeout; a stalled connection otherwise blocks the tool call indefinitely. */
  timeoutMs?: number;
  /** When true, throw DryRunRequest instead of sending — no token is acquired. */
  dryRun?: boolean;
}

export class ScimClient {
  private readonly credential: TokenCredential;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly dryRun: boolean;

  constructor(options: ScimClientOptions) {
    this.credential = options.credential;
    this.baseUrl = options.baseUrl ?? SCIM_BASE_URL;
    this.fetcher = options.fetcher ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.dryRun = options.dryRun ?? false;
  }

  async request<T = unknown>(opts: ScimRequestOptions): Promise<T | undefined> {
    const url = `${this.baseUrl}${opts.path}${buildQueryString(opts.query)}`;

    if (this.dryRun) {
      // Before token acquisition: dry-run must never contact Azure AD.
      const dryHeaders: Record<string, string> = { Accept: "application/json" };
      if (opts.body !== undefined) {
        dryHeaders["Content-Type"] = "application/scim+json";
      }
      throw new DryRunRequest({
        method: opts.method,
        url,
        headers: dryHeaders,
        body: opts.body,
      });
    }

    const token = await this.credential.getToken(GRAPH_SCOPE);
    if (!token) {
      throw new ScimError({ status: 401, detail: "Credential returned no token." });
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token.token}`,
      Accept: "application/json",
    };
    let serializedBody: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/scim+json";
      serializedBody = JSON.stringify(opts.body);
    }

    let attempt = 0;
    while (true) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: opts.method,
          headers,
          body: serializedBody,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "TimeoutError" || err.name === "AbortError")
        ) {
          throw new ScimError({
            status: 408,
            detail: `Request to ${url} timed out after ${this.timeoutMs} ms.`,
          });
        }
        throw err;
      }

      const retryable =
        response.status === 429 ||
        ((response.status === 503 || response.status === 504) &&
          isIdempotent(opts.method));
      if (retryable && attempt < this.maxRetries) {
        const wait = this.parseRetryAfter(response.headers.get("retry-after"), attempt);
        // Release the pooled socket; an abandoned body keeps it reserved.
        await response.body?.cancel().catch(() => {});
        await sleep(wait);
        attempt += 1;
        continue;
      }

      if (response.status === 204) {
        return undefined;
      }

      const text = await response.text();

      if (!response.ok) {
        throw mapScimError(response.status, safeParseJson(text), text);
      }

      if (!text) {
        return undefined;
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        // A 2xx with an unparseable body (proxy HTML page, truncated response)
        // must not be mistaken for a valid empty result.
        throw new ScimError(
          {
            status: response.status,
            detail: `Received HTTP ${response.status} but the response body is not valid JSON.`,
          },
          text.slice(0, 1000),
        );
      }
    }
  }

  private parseRetryAfter(header: string | null, attempt: number): number {
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 30_000);
      }
      // Retry-After also allows an HTTP-date (RFC 9110 §10.2.3).
      const dateMs = Date.parse(header);
      if (!Number.isNaN(dateMs)) {
        return Math.min(Math.max(dateMs - Date.now(), 0), 30_000);
      }
    }
    return this.retryBaseDelayMs * 2 ** attempt;
  }
}

function isIdempotent(method: HttpMethod): boolean {
  return method === "GET" || method === "DELETE";
}

function safeParseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function mapScimError(httpStatus: number, parsed: unknown, raw: string): ScimError {
  if (parsed && typeof parsed === "object") {
    const payload = parsed as Record<string, unknown>;
    const status = coerceStatus(payload.status, httpStatus);
    const detail = typeof payload.detail === "string" ? payload.detail : undefined;
    const scimType = typeof payload.scimType === "string" ? payload.scimType : undefined;
    return new ScimError({ status, detail, scimType }, parsed);
  }
  return new ScimError(
    { status: httpStatus, detail: raw || `HTTP ${httpStatus}` },
    raw || undefined,
  );
}

function coerceStatus(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
