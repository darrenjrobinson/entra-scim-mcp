import { describe, it, expect } from "vitest";
import type { TokenCredential, AccessToken } from "@azure/identity";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ScimClient } from "../src/scim/client.js";
import { createServer } from "../src/server.js";

/**
 * The descriptions and annotations are the only documentation a model ever
 * sees — the README is not in its context. So they are tested like any other
 * contract: a tool that regresses to a bare one-liner, or a new write tool that
 * inherits the read-only default and reads as safe to auto-approve, fails here.
 */

function fakeCredential(): TokenCredential {
  return {
    getToken: async (): Promise<AccessToken> => ({
      token: "stub",
      expiresOnTimestamp: Date.now() + 3600_000,
    }),
  };
}

const auth = {
  tenantId: "00000000-0000-0000-0000-000000000000",
  clientId: "11111111-1111-1111-1111-111111111111",
  mode: "secret" as const,
  credential: fakeCredential(),
};

async function connect(options: { dryRun?: boolean } = {}) {
  const { server } = createServer({
    auth,
    client: new ScimClient({ credential: auth.credential, dryRun: options.dryRun }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
  return mcpClient;
}

async function listTools(): Promise<Tool[]> {
  const mcpClient = await connect();
  const { tools } = await mcpClient.listTools();
  return tools;
}

/** Tools that only read. Anything not named here must declare write hints. */
const READ_ONLY_TOOLS = [
  "get_service_provider_config",
  "list_resource_types",
  "list_schemas",
  "list_users",
  "get_user",
  "get_user_custom_security_attributes",
  "list_groups",
  "get_group",
];

/** Writes that discard or overwrite state, with no undo through this API. */
const DESTRUCTIVE_TOOLS = [
  "update_user",
  "deprovision_user",
  "update_user_lifecycle",
  "update_user_custom_security_attributes",
  "update_group",
  "delete_group",
  "remove_group_member",
];

/** Writes that only add. */
const ADDITIVE_TOOLS = ["provision_user", "create_group", "add_group_members"];

describe("tool annotations", () => {
  it("every tool declares them", async () => {
    for (const tool of await listTools()) {
      expect(tool.annotations, `${tool.name} has no annotations`).toBeDefined();
      // Every tool talks to a tenant, so none of them is a closed-world call.
      expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(true);
    }
  });

  it("splits read-only from write exactly as intended", async () => {
    const tools = await listTools();
    const readOnly = tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name)
      .sort();
    expect(readOnly).toEqual([...READ_ONLY_TOOLS].sort());
  });

  it("gives every write tool both write hints", async () => {
    const tools = await listTools();
    for (const tool of tools.filter((t) => t.annotations?.readOnlyHint !== true)) {
      // Left undefined, a client has to fall back to the spec's defaults
      // (destructive) or guess — on a server that can delete directory
      // objects, neither is good enough.
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations?.idempotentHint, tool.name).toBe("boolean");
    }
  });

  it("marks the destructive writes and only those", async () => {
    const tools = await listTools();
    const destructive = tools
      .filter((t) => t.annotations?.destructiveHint === true)
      .map((t) => t.name)
      .sort();
    expect(destructive).toEqual([...DESTRUCTIVE_TOOLS].sort());

    const additive = tools
      .filter(
        (t) =>
          t.annotations?.readOnlyHint !== true &&
          t.annotations?.destructiveHint === false,
      )
      .map((t) => t.name)
      .sort();
    expect(additive).toEqual([...ADDITIVE_TOOLS].sort());
  });

  it("marks add_group_members idempotent, since the API treats a re-add as success", async () => {
    const tools = await listTools();
    const add = tools.find((t) => t.name === "add_group_members");
    expect(add?.annotations?.idempotentHint).toBe(true);
  });
});

describe("tool descriptions", () => {
  it("say more than a restatement of the name", async () => {
    for (const tool of await listTools()) {
      // The bar is deliberately low but non-zero: "DELETE a user by id." was
      // 20 characters and told a caller nothing about the recycle bin, the
      // stripped memberships, or the 404 on a repeat call.
      expect(tool.description?.length ?? 0, `${tool.name} description`).toBeGreaterThan(
        120,
      );
    }
  });

  it("describe every top-level input", async () => {
    for (const tool of await listTools()) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      for (const [name, schema] of Object.entries(properties)) {
        expect(
          schema.description?.trim() ?? "",
          `${tool.name}.${name} has no description`,
        ).not.toBe("");
      }
    }
  });

  it("give the patch tools a path example, which is the hard part to guess", async () => {
    const tools = await listTools();
    for (const name of [
      "update_user",
      "update_group",
      "update_user_custom_security_attributes",
    ]) {
      const tool = tools.find((t) => t.name === name);
      // Serialised rather than walked: the emitted JSON Schema nests the path
      // description under items.properties, and asserting on the shape of that
      // nesting would break on a zod-to-JSON-Schema change that leaves the
      // description perfectly intact.
      const operations = JSON.stringify(tool?.inputSchema.properties?.operations ?? {});
      expect(operations, `${name} operations schema`).toContain("urn:");
    }
  });
});

describe("server instructions", () => {
  it("carry the cross-cutting facts no single tool schema shows", async () => {
    const mcpClient = await connect();
    const instructions = mcpClient.getInstructions() ?? "";
    // Membership being readable in one direction only is the trap that costs
    // the most calls to discover by trial and error.
    expect(instructions).toContain("members.value");
    expect(instructions).toContain("object id");
  });

  it("warn that nothing is written when dry-run is active", async () => {
    const mcpClient = await connect({ dryRun: true });
    const instructions = mcpClient.getInstructions() ?? "";
    expect(instructions).toContain("DRY RUN IS ACTIVE");
    expect(instructions).toContain("do not report any change as applied");
  });

  it("say nothing about dry-run when it is off", async () => {
    const mcpClient = await connect();
    expect(mcpClient.getInstructions() ?? "").not.toContain("DRY RUN IS ACTIVE");
  });
});
