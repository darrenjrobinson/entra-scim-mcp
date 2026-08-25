import { describe, it, expect, vi } from "vitest";
import type { TokenCredential, AccessToken } from "@azure/identity";
import { ScimClient } from "../src/scim/client.js";
import { ScimError } from "../src/scim/errors.js";

function fakeCredential(token = "test-token"): TokenCredential {
  return {
    getToken: async (): Promise<AccessToken> => ({
      token,
      expiresOnTimestamp: Date.now() + 3600_000,
    }),
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/scim+json", ...headers },
  });
}

/**
 * ScimClient always calls fetch with a string URL. fetch's own signature is
 * wider, so narrow here rather than String()-ing a Request into
 * "[object Object]" and asserting against that.
 */
function calledUrl(call: Parameters<typeof fetch> | undefined): string {
  const input = call?.[0];
  if (typeof input !== "string") {
    throw new Error(`expected fetch to be called with a string URL, got ${typeof input}`);
  }
  return input;
}

describe("ScimClient", () => {
  it("attaches a bearer token and SCIM accept header", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
    const client = new ScimClient({
      credential: fakeCredential("abc"),
      fetcher: fetcher,
    });

    await client.request({ method: "GET", path: "/serviceproviderconfig" });

    const [, init] = fetcher.mock.calls[0]!;
    // fetch types `init` as optional; ScimClient always sends one.
    if (!init) throw new Error("expected an init object");
    expect(calledUrl(fetcher.mock.calls[0])).toBe(
      "https://graph.microsoft.com/rp/scim/serviceproviderconfig",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer abc");
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  // The live API rejects any specific JSON media type on DELETE with
  // "400 Accept header application/json is invalid" (verified against a real
  // tenant 2026-08-24), which broke deprovision_user and delete_group.
  it("sends no Accept header on DELETE", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const client = new ScimClient({
      credential: fakeCredential("abc"),
      fetcher: fetcher,
    });

    await client.request({ method: "DELETE", path: "/users/u-1" });

    const headers = fetcher.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer abc");
    expect(headers.Accept).toBeUndefined();
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("sets application/scim+json on writes", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(201, { id: "u-1" }));
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher: fetcher,
    });

    await client.request({
      method: "POST",
      path: "/users",
      body: { userName: "x@y" },
    });

    const init = fetcher.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/scim+json",
    );
    expect(init.body).toBe(JSON.stringify({ userName: "x@y" }));
  });

  it("returns undefined for 204 No Content", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher: fetcher,
    });

    const result = await client.request({ method: "DELETE", path: "/users/u-1" });
    expect(result).toBeUndefined();
  });

  it("maps SCIM error payloads to ScimError", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse(400, {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "400",
        scimType: "invalidValue",
        detail: "mailNickname is required",
      }),
    );
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher: fetcher,
    });

    const err = await client
      .request({ method: "POST", path: "/users", body: {} })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ScimError);
    expect((err as ScimError).status).toBe(400);
    expect((err as ScimError).scimType).toBe("invalidValue");
    expect((err as ScimError).detail).toBe("mailNickname is required");
  });

  it("retries on 429 honoring Retry-After (seconds)", async () => {
    const responses = [
      new Response("rate", { status: 429, headers: { "retry-after": "0" } }),
      jsonResponse(200, { ok: true }),
    ];
    const fetcher = vi.fn<typeof fetch>(async () => responses.shift()!);
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher: fetcher,
      retryBaseDelayMs: 1,
    });

    const result = await client.request<{ ok: boolean }>({
      method: "GET",
      path: "/users",
    });
    expect(result?.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries 429s", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("rate", { status: 429, headers: { "retry-after": "0" } }),
    );
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher: fetcher,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    });

    const err = await client
      .request({ method: "GET", path: "/users" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScimError);
    expect((err as ScimError).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("retries when Retry-After is an HTTP-date", async () => {
    const past = new Date(Date.now() - 1000).toUTCString();
    const responses = [
      new Response("rate", { status: 429, headers: { "retry-after": past } }),
      jsonResponse(200, { ok: true }),
    ];
    const fetcher = vi.fn<typeof fetch>(async () => responses.shift()!);
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher: fetcher,
      retryBaseDelayMs: 1,
    });

    const result = await client.request<{ ok: boolean }>({
      method: "GET",
      path: "/users",
    });
    expect(result?.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cancels the throttled response body before retrying", async () => {
    const throttled = new Response("rate", {
      status: 429,
      headers: { "retry-after": "0" },
    });
    const cancelSpy = vi.spyOn(throttled.body!, "cancel");
    const responses = [throttled, jsonResponse(200, { ok: true })];
    const fetcher = vi.fn<typeof fetch>(async () => responses.shift()!);
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher: fetcher,
      retryBaseDelayMs: 1,
    });

    await client.request({ method: "GET", path: "/users" });
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("retries transient 503s for idempotent methods", async () => {
    const responses = [
      new Response("unavailable", { status: 503 }),
      jsonResponse(200, { ok: true }),
    ];
    const fetcher = vi.fn<typeof fetch>(async () => responses.shift()!);
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher: fetcher,
      retryBaseDelayMs: 1,
    });

    const result = await client.request<{ ok: boolean }>({
      method: "GET",
      path: "/users",
    });
    expect(result?.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 503 on POST", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 }));
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher: fetcher,
      retryBaseDelayMs: 1,
    });

    const err = await client
      .request({ method: "POST", path: "/users", body: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScimError);
    expect((err as ScimError).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("throws when a 2xx response body is not valid JSON", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("<html>gateway error</html>", { status: 200 }),
    );
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher: fetcher,
    });

    const err = await client
      .request({ method: "GET", path: "/users" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScimError);
    expect((err as ScimError).status).toBe(200);
    expect((err as ScimError).detail).toContain("not valid JSON");
    expect((err as ScimError).raw).toContain("gateway error");
  });

  it("returns undefined for a 2xx with an empty body", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("", { status: 200 }));
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher: fetcher,
    });

    const result = await client.request({ method: "GET", path: "/users/u-1" });
    expect(result).toBeUndefined();
  });

  it("aborts a stalled request after timeoutMs and maps it to ScimError 408", async () => {
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () =>
            reject(init!.signal!.reason),
          );
        }),
    );
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher,
      timeoutMs: 20,
    });

    const err = await client
      .request({ method: "GET", path: "/users" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScimError);
    expect((err as ScimError).status).toBe(408);
    expect((err as ScimError).detail).toContain("timed out after 20 ms");
  });

  it("passes an abort signal to every attempt", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher: fetcher,
    });

    await client.request({ method: "GET", path: "/users" });
    const init = fetcher.mock.calls[0]![1]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to HTTP status when error body is not SCIM JSON", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("Internal Server Error", { status: 500 }),
    );
    const client = new ScimClient({
      credential: fakeCredential(),
      fetcher: fetcher,
    });

    const err = await client
      .request({ method: "GET", path: "/users" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScimError);
    expect((err as ScimError).status).toBe(500);
  });
});
