import { describe, it, expect, vi } from "vitest";
import type { TokenCredential } from "@azure/identity";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ScimClient } from "../src/scim/client.js";
import { DryRunRequest } from "../src/scim/errors.js";
import { loadAuthFromEnv } from "../src/scim/auth.js";
import { createServer } from "../src/server.js";

function untouchableCredential(): TokenCredential {
  return {
    getToken: vi.fn(async () => {
      throw new Error("dry-run must never acquire a token");
    }),
  };
}

async function dryRunClient(): Promise<{ mcp: Client; fetcher: ReturnType<typeof vi.fn> }> {
  const fetcher = vi.fn();
  const credential = untouchableCredential();
  const scimClient = new ScimClient({
    credential,
    fetcher: fetcher as unknown as typeof fetch,
    dryRun: true,
  });
  const { server } = createServer({
    auth: { tenantId: "t", clientId: "c", mode: "static", credential },
    client: scimClient,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    mcp.connect(clientTransport),
  ]);
  return { mcp, fetcher };
}

describe("ScimClient dry-run", () => {
  it("throws DryRunRequest without fetching or acquiring a token", async () => {
    const fetcher = vi.fn();
    const credential = untouchableCredential();
    const client = new ScimClient({
      credential,
      fetcher: fetcher as unknown as typeof fetch,
      dryRun: true,
    });

    const err = await client
      .request({ method: "POST", path: "/users", body: { userName: "x@y" } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DryRunRequest);
    const { request } = err as DryRunRequest;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://graph.microsoft.com/rp/scim/users");
    expect(request.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/scim+json",
    });
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.body).toEqual({ userName: "x@y" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(credential.getToken).not.toHaveBeenCalled();
  });
});

describe("tools in dry-run", () => {
  it("returns a successful { dryRun, request } payload", async () => {
    const { mcp, fetcher } = await dryRunClient();

    const result = await mcp.callTool({
      name: "deprovision_user",
      arguments: { id: "u-1" },
    });

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as Record<string, unknown>;
    expect(payload.dryRun).toBe(true);
    const request = payload.request as Record<string, unknown>;
    expect(request.method).toBe("DELETE");
    expect(request.url).toBe("https://graph.microsoft.com/rp/scim/users/u-1");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports the first chunked request for multi-request tools", async () => {
    const { mcp } = await dryRunClient();
    const memberIds = Array.from({ length: 25 }, (_, i) => `u-${i}`);

    const result = await mcp.callTool({
      name: "add_group_members",
      arguments: { id: "g-1", memberIds },
    });

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as Record<string, unknown>;
    expect(payload.dryRun).toBe(true);
    const request = payload.request as { body: { Operations: { value: unknown[] }[] } };
    expect(request.body.Operations[0]!.value).toHaveLength(20);
  });

  it("still rejects invalid input before producing a dry-run payload", async () => {
    const { mcp } = await dryRunClient();

    const result = await mcp.callTool({
      name: "update_user",
      arguments: {
        id: "u-1",
        operations: [{ op: "remove", path: "mailNickname" }],
      },
    });

    expect(result.isError).toBe(true);
    const payload = result.structuredContent as Record<string, unknown>;
    expect(payload.error).toBe("PatchValidationError");
  });
});

describe("loadAuthFromEnv dry-run fallback", () => {
  it("returns a placeholder credential with zero config when dryRun is set", () => {
    const auth = loadAuthFromEnv({} as NodeJS.ProcessEnv, { dryRun: true });
    expect(auth.mode).toBe("static");
    expect(auth.tenantId).toBe("dry-run");
  });

  it("still uses the real credential when one is configured", () => {
    const auth = loadAuthFromEnv(
      {
        ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000000",
        ENTRA_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
        ENTRA_CLIENT_SECRET: "s3cret",
      } as NodeJS.ProcessEnv,
      { dryRun: true },
    );
    expect(auth.mode).toBe("secret");
  });
});
