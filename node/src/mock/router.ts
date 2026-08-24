import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  FilterValidationError,
  PatchValidationError,
  QueryValidationError,
} from "../scim/errors.js";
import { assertRawQueryHasNoWhitespaceAroundEquals } from "../scim/query.js";
import { MockScimError, scimErrorBody } from "./errors.js";
import { resourceTypeById, resourceTypesList, serviceProviderConfig } from "./data/discovery.js";
import { schemaById, schemasList } from "./data/schemas.js";
import * as users from "./handlers/users.js";
import * as groups from "./handlers/groups.js";
import type { HandlerContext, HandlerResponse } from "./handlers/users.js";
import type { MockStore } from "./store.js";

export interface CaptureEntry {
  ts: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body?: unknown;
  };
  response: {
    status: number;
    body?: unknown;
  };
  durationMs: number;
}

export interface RouterConfig {
  token: string;
  store: MockStore;
  validatorCompat: boolean;
  onTransaction?: (entry: CaptureEntry) => void;
}

export function createRequestListener(config: RouterConfig): RequestListener {
  const ctx: HandlerContext = {
    store: config.store,
    validatorCompat: config.validatorCompat,
  };

  return (req, res) => {
    const started = Date.now();
    void handle(req, ctx, config).then((result) => {
      sendResponse(req, res, result);
      config.onTransaction?.({
        ts: new Date(started).toISOString(),
        request: {
          method: req.method ?? "?",
          url: req.url ?? "?",
          headers: redactHeaders(req.headers),
          body: result.requestBody,
        },
        response: { status: result.response.status, body: result.response.body },
        durationMs: Date.now() - started,
      });
    });
  };
}

interface HandledRequest {
  response: HandlerResponse;
  requestBody?: unknown;
}

async function handle(
  req: IncomingMessage,
  ctx: HandlerContext,
  config: RouterConfig,
): Promise<HandledRequest> {
  let requestBody: unknown;
  try {
    const url = req.url ?? "/";
    const queryStart = url.indexOf("?");
    const rawPath = queryStart === -1 ? url : url.slice(0, queryStart);
    const rawQuery = queryStart === -1 ? "" : url.slice(queryStart + 1);

    // The real API rejects whitespace around "=" before anything else.
    try {
      assertRawQueryHasNoWhitespaceAroundEquals(rawQuery);
    } catch (err) {
      // Only the whitespace rule belongs to this call; anything else is a bug
      // here, not a bad request, and must not be relabelled as a 400.
      if (!(err instanceof QueryValidationError)) throw err;
      throw new MockScimError(400, err.message, "invalidValue");
    }

    // Bearer check.
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${config.token}`) {
      throw new MockScimError(401, "Access token is empty or invalid.");
    }

    const method = (req.method ?? "GET").toUpperCase();

    // The real API 400s when Accept doesn't allow JSON — except on DELETE,
    // which rejects any *specific* JSON media type and only tolerates a
    // wildcard or no header at all (verified against a live tenant
    // 2026-08-24). Reproducing that asymmetry is what makes the mock able to
    // catch a client sending Accept on DELETE.
    const accept = req.headers.accept;
    if (!ctx.validatorCompat && accept !== undefined) {
      if (method === "DELETE") {
        if (!/^\s*\*\/\*\s*$/.test(accept)) {
          throw new MockScimError(400, `Accept header ${accept} is invalid.`);
        }
      } else if (!/application\/(scim\+)?json|\*\/\*/i.test(accept)) {
        throw new MockScimError(400, "HTTP Accept header for application/json is missing.");
      }
    }

    if (method === "POST" || method === "PATCH") {
      requestBody = await readJsonBody(req);
    }

    const query = new URLSearchParams(rawQuery);
    const response = route(ctx, method, normalizePath(rawPath), query, requestBody);
    return { response, requestBody };
  } catch (err) {
    return { response: errorResponse(err), requestBody };
  }
}

function route(
  ctx: HandlerContext,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): HandlerResponse {
  const segments = path.split("/").filter(Boolean);
  const head = segments[0]?.toLowerCase();
  const id = segments.length > 1 ? decodeURIComponent(segments.slice(1).join("/")) : undefined;

  if (head === "serviceproviderconfig" && method === "GET" && !id) {
    return { status: 200, body: serviceProviderConfig(ctx.validatorCompat) };
  }
  if ((head === "resourcetypes" || head === "resourcetype") && method === "GET") {
    if (!id) return { status: 200, body: resourceTypesList() };
    const resourceType = resourceTypeById(id);
    if (!resourceType) throw new MockScimError(404, `Resource type '${id}' not found.`);
    return { status: 200, body: resourceType };
  }
  if (head === "schemas" && method === "GET") {
    if (!id) return { status: 200, body: schemasList(ctx.validatorCompat) };
    const schema = schemaById(id, ctx.validatorCompat);
    if (!schema) throw new MockScimError(404, `Schema '${id}' not found.`);
    return { status: 200, body: schema };
  }

  if (head === "users") {
    if (method === "GET") {
      return id ? users.getUser(ctx, id, query) : users.listUsers(ctx, query);
    }
    if (method === "POST" && !id) return users.createUser(ctx, body);
    if (method === "PATCH" && id) return users.patchUser(ctx, id, body);
    if (method === "DELETE" && id) return users.deleteUser(ctx, id);
    throw new MockScimError(405, `${method} is not supported on ${path}.`);
  }

  if (head === "groups") {
    if (method === "GET") {
      return id ? groups.getGroup(ctx, id, query) : groups.listGroups(ctx, query);
    }
    if (method === "POST" && !id) return groups.createGroup(ctx, body);
    if (method === "PATCH" && id) return groups.patchGroup(ctx, id, body);
    if (method === "DELETE" && id) return groups.deleteGroup(ctx, id);
    throw new MockScimError(405, `${method} is not supported on ${path}.`);
  }

  throw new MockScimError(404, `Invalid URN or unknown endpoint: ${path}`);
}

/** Accept an optional /rp/scim (or /scim) prefix for tunnel convenience. */
function normalizePath(rawPath: string): string {
  return rawPath.replace(/^\/(rp\/)?scim(?=\/|$)/i, "") || "/";
}

/**
 * SCIM payloads are JSON attribute bags, never uploads, so a megabyte is
 * already far more than any real request needs — the largest thing the tools
 * send is a 20-member group PATCH.
 */
const MAX_BODY_BYTES = 1024 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  // An honest Content-Length lets us refuse before reading a single byte.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new MockScimError(413, tooLargeDetail(declared));
  }

  const text = await readCappedBody(req);
  if (text.length === 0) {
    throw new MockScimError(400, "Request body is required.", "invalidSyntax");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MockScimError(400, "Request body is not valid JSON.", "invalidSyntax");
  }
}

/**
 * Bytes we will read past the cap before giving up on answering cleanly.
 *
 * An ordinary oversized request finishes well inside this, so the client gets
 * a real 413 on a connection that stays reusable. A stream that keeps coming
 * gets the same 413, but sendResponse closes the connection under it, since
 * the body was never read to the end. Nothing past MAX_BODY_BYTES is retained
 * either way — the drain exists to be polite, not to buffer.
 */
const MAX_DRAIN_BYTES = 8 * MAX_BODY_BYTES;

/**
 * Buffer the body, refusing anything past MAX_BODY_BYTES.
 *
 * On the event API rather than `for await` because leaving a `for await` early
 * destroys the request stream, and with it the socket — the client would get a
 * connection reset in place of its 413.
 */
function readCappedBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let total = 0;
    let oversize = false;

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // Release everything held; from here we only count.
        if (!oversize) {
          oversize = true;
          chunks = [];
        }
        if (total > MAX_DRAIN_BYTES) {
          cleanup();
          req.pause();
          reject(new MockScimError(413, tooLargeDetail(total)));
        }
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      if (oversize) {
        reject(new MockScimError(413, tooLargeDetail(total)));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** RFC 7644 defines scimType only for 400s, so a 413 carries detail alone. */
function tooLargeDetail(bytes: number): string {
  return `Request body exceeds the ${MAX_BODY_BYTES} byte limit (${bytes} bytes).`;
}

function errorResponse(err: unknown): HandlerResponse {
  if (err instanceof MockScimError) {
    return {
      status: err.status,
      body: scimErrorBody(err.status, err.message, err.scimType),
    };
  }
  if (err instanceof FilterValidationError) {
    return { status: 400, body: scimErrorBody(400, err.message, "invalidFilter") };
  }
  if (err instanceof PatchValidationError) {
    return { status: 400, body: scimErrorBody(400, err.message, "invalidValue") };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: scimErrorBody(500, message) };
}

function sendResponse(
  req: IncomingMessage,
  res: ServerResponse,
  result: HandledRequest,
): void {
  const { status, body, headers } = result.response;
  const outHeaders: Record<string, string> = { ...headers };
  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body, null, 2);
    outHeaders["Content-Type"] = "application/scim+json";
  }
  // Answering while the request body is still in flight — an oversized
  // Content-Length refused up front, or any POST/PATCH rejected before
  // readJsonBody runs, such as a bad bearer — leaves unread bytes in the pipe.
  // On a keep-alive connection those would be parsed as the head of the next
  // request; HTTP's answer is to close, and node then discards the remainder
  // instead of buffering it.
  if (!req.readableEnded) outHeaders["Connection"] = "close";
  res.writeHead(status, outHeaders);
  res.end(payload);
}

function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const copy = { ...headers };
  if (copy.authorization) copy.authorization = "Bearer <redacted>";
  return copy;
}
