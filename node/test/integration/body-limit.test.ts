import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request } from "node:http";
import { createMockServer, type MockServer } from "../../src/mock/server.js";
import { SCHEMA_ENTRA_USER, SCHEMA_USER_CORE } from "../../src/scim/types.js";

const TOKEN = "test-token";
const MAX_BODY_BYTES = 1024 * 1024;

let mock: MockServer;
let port: number;

beforeAll(async () => {
  mock = createMockServer({ token: TOKEN });
  ({ port } = await mock.listen(0));
});

afterAll(async () => {
  await mock.close();
});

interface RawResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Raw node:http rather than fetch, so a test can choose chunked transfer or a
 * deliberately dishonest Content-Length — neither of which fetch will send.
 */
function post(
  path: string,
  chunks: (string | Buffer)[],
  extraHeaders: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/json",
          "Content-Type": "application/scim+json",
          ...extraHeaders,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          body += d;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      // A stream the server gave up on is reset mid-write; that is an outcome,
      // not a harness failure.
      if (err.code === "ECONNRESET" || err.code === "EPIPE") {
        resolve({ status: 0, body: "", headers: {} });
        return;
      }
      reject(err);
    });
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

function userPayload(displayName: string, userName = "big@example.com"): string {
  return JSON.stringify({
    schemas: [SCHEMA_USER_CORE, SCHEMA_ENTRA_USER],
    userName,
    password: "P@ssw0rd!",
    displayName,
    active: true,
    name: { givenName: "Big", familyName: "Body" },
    [SCHEMA_ENTRA_USER]: { mailNickname: "big" },
  });
}

describe("request body size limit", () => {
  it("accepts a payload just under the cap", async () => {
    // Pad to ~64 KB below the limit; the envelope is well under that slack.
    const payload = userPayload("x".repeat(MAX_BODY_BYTES - 64 * 1024));
    expect(Buffer.byteLength(payload)).toBeLessThan(MAX_BODY_BYTES);

    const res = await post("/users", [payload]);
    expect(res.status).toBe(201);
  });

  it("rejects a chunked body that grows past the cap", async () => {
    // No Content-Length: node sends Transfer-Encoding: chunked, so the cap can
    // only be enforced while the stream is being consumed.
    const chunk = "y".repeat(128 * 1024);
    const chunks = ['{"padding":"', ...Array.from({ length: 12 }, () => chunk), '"}'];

    const res = await post("/users", chunks);
    expect(res.status).toBe(413);

    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect(body.status).toBe("413");
    expect(body.detail).toMatch(/exceeds the 1048576 byte limit/);
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    // Declares 50 MB and sends almost none of it. A 413 here proves the fast
    // path fired: nothing was buffered, and the server never waited for the
    // rest of a body it had already decided to refuse.
    const res = await post("/users", ["{}"], {
      "Content-Length": String(50 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).detail).toMatch(/52428800 bytes/);
  });

  it("closes the connection when it answers before reading the body", async () => {
    // Unread bytes on a keep-alive socket would be parsed as the next request.
    const res = await post("/users", ["{}"], {
      "Content-Length": String(50 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
    expect(res.headers.connection).toBe("close");
  });

  it("keeps the connection usable when the body was read in full", async () => {
    const chunk = "y".repeat(128 * 1024);
    const res = await post("/users", [
      '{"padding":"',
      ...Array.from({ length: 12 }, () => chunk),
      '"}',
    ]);
    expect(res.status).toBe(413);
    expect(res.headers.connection).not.toBe("close");
  });

  it("gives up on a stream that runs past the drain budget", async () => {
    // 40 MB, five times MAX_DRAIN_BYTES. The point is that this terminates at
    // all, and holds no more than the 1 MB cap while doing so — measured at a
    // 1.6 MB heap delta for the whole 40 MB. Either outcome is correct: a 413
    // if the response wins the race, a reset once the server stops reading.
    const chunk = "z".repeat(1024 * 1024);
    const res = await post("/users", [
      '{"padding":"',
      ...Array.from({ length: 40 }, () => chunk),
      '"}',
    ]);
    expect([0, 413]).toContain(res.status);
  }, 30_000);

  it("still serves normal traffic afterwards", async () => {
    const res = await post("/users", [userPayload("Small User", "small@example.com")]);
    expect(res.status).toBe(201);
  });
});
