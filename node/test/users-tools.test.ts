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

describe("projection params", () => {
  it("omits attributes/excludedAttributes entirely for empty arrays", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => okUser());
    const mcp = await connectedClient(fetcher);

    await mcp.callTool({
      name: "get_user",
      arguments: { id: "u-1", attributes: [], excludedAttributes: [] },
    });

    const url = calledUrl(fetcher.mock.calls[0]);
    expect(url).toBe("https://graph.microsoft.com/rp/scim/users/u-1");
  });
});

describe("get_user_custom_security_attributes", () => {
  it("projects set-qualified CSA attributes when attributeSets is given", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => okUser());
    const mcp = await connectedClient(fetcher);

    await mcp.callTool({
      name: "get_user_custom_security_attributes",
      arguments: { id: "u-1", attributeSets: ["Engineering", "HR"] },
    });

    const url = calledUrl(fetcher.mock.calls[0]);
    const expected = encodeURIComponent(
      `${SCHEMA_ENTRA_CSA}:Engineering,${SCHEMA_ENTRA_CSA}:HR`,
    );
    expect(url).toBe(
      `https://graph.microsoft.com/rp/scim/users/u-1?attributes=${expected}`,
    );
  });

  // The bare extension URN is rejected by the live API with
  // "400 The specified attribute urn:...:CustomSecurityAttributes is not
  // supported in the attributes query parameter" (verified 2026-08-24), so
  // attributeSets is required rather than falling back to it.
  it("refuses to call the API when attributeSets is omitted", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => okUser());
    const mcp = await connectedClient(fetcher);

    const result = await mcp.callTool({
      name: "get_user_custom_security_attributes",
      arguments: { id: "u-1" },
    });

    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("query validation surfaces as a named error", () => {
  it("reports QueryValidationError, not UnexpectedError", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => okUser());
    const mcp = await connectedClient(fetcher);

    const result = await mcp.callTool({
      name: "list_users",
      arguments: { cursor: " leading-space" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "QueryValidationError",
    });
    const structured = result.structuredContent as { detail?: unknown } | undefined;
    expect(String(structured?.detail)).toMatch(/whitespace/i);
    // Rejected client-side: nothing was sent.
    expect(fetcher).not.toHaveBeenCalled();
  });
});
