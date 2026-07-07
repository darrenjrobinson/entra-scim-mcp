import { describe, it, expect, vi } from "vitest";
import type { TokenCredential, AccessToken } from "@azure/identity";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ScimClient } from "../src/scim/client.js";
import { createServer } from "../src/server.js";
import { SCHEMA_ENTRA_CSA } from "../src/scim/types.js";

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

function okUser(): Response {
  return new Response(JSON.stringify({ id: "u-1" }), {
    status: 200,
    headers: { "content-type": "application/scim+json" },
  });
}

describe("projection params", () => {
  it("omits attributes/excludedAttributes entirely for empty arrays", async () => {
    const fetcher = vi.fn(async () => okUser());
    const mcp = await connectedClient(fetcher as unknown as typeof fetch);

    await mcp.callTool({
      name: "get_user",
      arguments: { id: "u-1", attributes: [], excludedAttributes: [] },
    });

    const url = String(fetcher.mock.calls[0]![0]);
    expect(url).toBe("https://graph.microsoft.com/rp/scim/users/u-1");
  });
});

describe("get_user_custom_security_attributes", () => {
  it("projects set-qualified CSA attributes when attributeSets is given", async () => {
    const fetcher = vi.fn(async () => okUser());
    const mcp = await connectedClient(fetcher as unknown as typeof fetch);

    await mcp.callTool({
      name: "get_user_custom_security_attributes",
      arguments: { id: "u-1", attributeSets: ["Engineering", "HR"] },
    });

    const url = String(fetcher.mock.calls[0]![0]);
    const expected = encodeURIComponent(
      `${SCHEMA_ENTRA_CSA}:Engineering,${SCHEMA_ENTRA_CSA}:HR`,
    );
    expect(url).toBe(
      `https://graph.microsoft.com/rp/scim/users/u-1?attributes=${expected}`,
    );
  });

  it("falls back to the whole extension URN when attributeSets is omitted", async () => {
    const fetcher = vi.fn(async () => okUser());
    const mcp = await connectedClient(fetcher as unknown as typeof fetch);

    await mcp.callTool({
      name: "get_user_custom_security_attributes",
      arguments: { id: "u-1" },
    });

    const url = String(fetcher.mock.calls[0]![0]);
    expect(url).toBe(
      `https://graph.microsoft.com/rp/scim/users/u-1?attributes=${encodeURIComponent(SCHEMA_ENTRA_CSA)}`,
    );
  });
});
