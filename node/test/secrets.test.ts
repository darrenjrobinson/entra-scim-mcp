import { describe, it, expect, vi } from "vitest";
import type { TokenCredential } from "@azure/identity";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ScimClient } from "../src/scim/client.js";
import { createServer } from "../src/server.js";
import { stripSecrets } from "../src/tools/util.js";

const PASSWORD = "SuperSecret123!";

function credential(): TokenCredential {
  return {
    getToken: async () => ({ token: "stub", expiresOnTimestamp: Date.now() + 3600_000 }),
  };
}

/** An MCP client wired to a ScimClient that answers with `body`, or dry-runs. */
async function mcpWith(
  options: { dryRun?: boolean; body?: unknown } = {},
): Promise<Client> {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify(options.body ?? {}), {
        status: 201,
        headers: { "Content-Type": "application/scim+json" },
      }),
  );
  const scimClient = new ScimClient({
    credential: credential(),
    fetcher: fetcher as unknown as typeof fetch,
    dryRun: options.dryRun ?? false,
  });
  const { server } = createServer({
    auth: { tenantId: "t", clientId: "c", mode: "static", credential: credential() },
    client: scimClient,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

const provisionArgs = {
  userName: "leak@example.com",
  password: PASSWORD,
  displayName: "Leak Test",
  givenName: "Leak",
  familyName: "Test",
  mailNickname: "leak",
};

function resultText(result: unknown): string {
  const content = (result as { content: { text?: string }[] }).content;
  return content.map((c) => c.text ?? "").join("");
}

describe("secrets never reach the model", () => {
  it("does not echo the password in a dry-run request", async () => {
    // Dry-run reflects the outbound request back as the tool result, and the
    // outbound body is the one place a plaintext password exists.
    const mcp = await mcpWith({ dryRun: true });
    const result = await mcp.callTool({
      name: "provision_user",
      arguments: provisionArgs,
    });

    const text = resultText(result);
    expect(text).not.toContain(PASSWORD);
    // The rest of the request must survive — this is the tool's whole output.
    expect(text).toContain("leak@example.com");
    expect(JSON.parse(text)).toMatchObject({ dryRun: true, request: { method: "POST" } });
  });

  it("strips a password an API echoed back on create", async () => {
    const mcp = await mcpWith({
      body: { schemas: [], id: "u-1", userName: "leak@example.com", password: PASSWORD },
    });
    const result = await mcp.callTool({
      name: "provision_user",
      arguments: provisionArgs,
    });

    expect(resultText(result)).not.toContain(PASSWORD);
    expect(resultText(result)).toContain("u-1");
  });

  it("strips a password nested inside a list response", async () => {
    const mcp = await mcpWith({
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        Resources: [{ id: "u-1", userName: "a@x", password: PASSWORD }],
      },
    });
    const result = await mcp.callTool({ name: "list_users", arguments: {} });

    expect(resultText(result)).not.toContain(PASSWORD);
    expect(resultText(result)).toContain("u-1");
  });
});

describe("stripSecrets", () => {
  it("removes password at any depth, in objects and arrays", () => {
    expect(
      stripSecrets({
        id: "u-1",
        password: PASSWORD,
        nested: { password: PASSWORD, keep: 1 },
        list: [{ password: PASSWORD, keep: 2 }],
      }),
    ).toEqual({ id: "u-1", nested: { keep: 1 }, list: [{ keep: 2 }] });
  });

  it("matches the key regardless of case", () => {
    expect(stripSecrets({ Password: PASSWORD, PASSWORD: PASSWORD, keep: 1 })).toEqual({
      keep: 1,
    });
  });

  it("passes primitives, null and undefined through untouched", () => {
    expect(stripSecrets("text")).toBe("text");
    expect(stripSecrets(7)).toBe(7);
    expect(stripSecrets(null)).toBe(null);
    expect(stripSecrets(undefined)).toBe(undefined);
  });

  it("leaves a payload with no secrets structurally equal", () => {
    const value = { a: 1, b: [{ c: "x" }], d: { e: null } };
    expect(stripSecrets(value)).toEqual(value);
  });
});
