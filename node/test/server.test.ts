import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import type { TokenCredential, AccessToken } from "@azure/identity";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PACKAGE_VERSION, createServer } from "../src/server.js";

const packageJson = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

function fakeCredential(): TokenCredential {
  return {
    getToken: async (): Promise<AccessToken> => ({
      token: "stub",
      expiresOnTimestamp: Date.now() + 3600_000,
    }),
  };
}

const EXPECTED_TOOLS = [
  // discovery
  "get_service_provider_config",
  "list_resource_types",
  "list_schemas",
  // users
  "list_users",
  "get_user",
  "provision_user",
  "update_user",
  "deprovision_user",
  "update_user_lifecycle",
  "get_user_custom_security_attributes",
  "update_user_custom_security_attributes",
  // groups
  "list_groups",
  "get_group",
  "create_group",
  "update_group",
  "delete_group",
  "add_group_members",
  "remove_group_member",
];

describe("createServer", () => {
  it("registers the full tool set", async () => {
    const { server } = createServer({
      auth: {
        tenantId: "00000000-0000-0000-0000-000000000000",
        clientId: "11111111-1111-1111-1111-111111111111",
        mode: "secret",
        credential: fakeCredential(),
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      mcpClient.connect(clientTransport),
    ]);

    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });
});

describe("server version", () => {
  it("reports package.json's version, not a literal", () => {
    expect(PACKAGE_VERSION).toBe(packageJson.version);
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("sends that version in the MCP handshake", async () => {
    const { server } = createServer({
      auth: {
        tenantId: "00000000-0000-0000-0000-000000000000",
        clientId: "11111111-1111-1111-1111-111111111111",
        mode: "secret",
        credential: fakeCredential(),
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      mcpClient.connect(clientTransport),
    ]);

    expect(mcpClient.getServerVersion()).toMatchObject({
      name: "entra-scim-mcp",
      version: packageJson.version,
    });
  });

  it("still honours an explicit override", async () => {
    const { server } = createServer({
      auth: {
        tenantId: "00000000-0000-0000-0000-000000000000",
        clientId: "11111111-1111-1111-1111-111111111111",
        mode: "secret",
        credential: fakeCredential(),
      },
      name: "custom",
      version: "9.9.9",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      mcpClient.connect(clientTransport),
    ]);

    expect(mcpClient.getServerVersion()).toMatchObject({
      name: "custom",
      version: "9.9.9",
    });
  });
});
