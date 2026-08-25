import { describe, it, expect, vi } from "vitest";
import type { TokenCredential, AccessToken } from "@azure/identity";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ScimClient } from "../src/scim/client.js";
import { createServer } from "../src/server.js";

function fakeCredential(token = "test-token"): TokenCredential {
  return {
    getToken: async (): Promise<AccessToken> => ({
      token,
      expiresOnTimestamp: Date.now() + 3600_000,
    }),
  };
}

async function connectedClient(fetcher: typeof fetch): Promise<Client> {
  const credential = fakeCredential();
  const scimClient = new ScimClient({ credential, fetcher });
  const { server } = createServer({
    auth: { tenantId: "t", clientId: "c", mode: "secret", credential },
    client: scimClient,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
  return mcpClient;
}

describe("add_group_members", () => {
  const memberIds = Array.from({ length: 25 }, (_, i) => `u-${i}`);

  it("reports success with the deduped ids and PATCH count", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const mcp = await connectedClient(fetcher);

    const result = await mcp.callTool({
      name: "add_group_members",
      arguments: { id: "g-1", memberIds },
    });

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.patchCalls).toBe(2);
    expect(payload.memberIds).toEqual(memberIds);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports partial failure with added / failed / not-attempted ids", async () => {
    let call = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      call += 1;
      if (call === 1) return new Response(null, { status: 204 });
      return new Response(
        JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          status: "400",
          detail: "Resource 'u-23' does not exist",
        }),
        { status: 400, headers: { "content-type": "application/scim+json" } },
      );
    });
    const mcp = await connectedClient(fetcher);

    const result = await mcp.callTool({
      name: "add_group_members",
      arguments: { id: "g-1", memberIds },
    });

    expect(result.isError).toBe(true);
    const payload = result.structuredContent as Record<string, unknown>;
    expect(payload.error).toBe("AddGroupMembersPartialFailure");
    expect(payload.addedMemberIds).toEqual(memberIds.slice(0, 20));
    expect(payload.failedMemberIds).toEqual(memberIds.slice(20));
    expect(payload.notAttemptedMemberIds).toEqual([]);
    expect((payload.cause as Record<string, unknown>).status).toBe(400);
  });

  it("marks later chunks as not attempted when an early chunk fails", async () => {
    const manyIds = Array.from({ length: 45 }, (_, i) => `u-${i}`);
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ status: "404", detail: "group not found" }),
          { status: 404, headers: { "content-type": "application/scim+json" } },
        ),
    );
    const mcp = await connectedClient(fetcher);

    const result = await mcp.callTool({
      name: "add_group_members",
      arguments: { id: "g-missing", memberIds: manyIds },
    });

    expect(result.isError).toBe(true);
    const payload = result.structuredContent as Record<string, unknown>;
    expect(payload.addedMemberIds).toEqual([]);
    expect(payload.failedMemberIds).toEqual(manyIds.slice(0, 20));
    expect(payload.notAttemptedMemberIds).toEqual(manyIds.slice(20));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
