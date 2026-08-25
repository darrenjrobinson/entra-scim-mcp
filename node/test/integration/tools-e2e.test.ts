import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StaticTokenCredential } from "../../src/scim/auth.js";
import { ScimClient } from "../../src/scim/client.js";
import { createServer } from "../../src/server.js";
import { createMockServer, type MockServer } from "../../src/mock/server.js";
import {
  SCHEMA_ENTRA_CSA,
  SCHEMA_ENTRA_USER,
  SCHEMA_USER_CORE,
} from "../../src/scim/types.js";

const TOKEN = "triangle-token";

let mock: MockServer;
let mcp: Client;

beforeAll(async () => {
  mock = createMockServer({ token: TOKEN });
  const { url } = await mock.listen(0);

  const credential = new StaticTokenCredential(TOKEN);
  const scimClient = new ScimClient({ credential, baseUrl: url });
  const { server } = createServer({
    auth: { tenantId: "local", clientId: "local", mode: "static", credential },
    client: scimClient,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: "e2e", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
});

afterAll(async () => {
  await mock.close();
});

async function callOk(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const result = await mcp.callTool({ name, arguments: args });
  expect(
    result.isError,
    `${name} unexpectedly failed: ${JSON.stringify(result.structuredContent ?? result.content)}`,
  ).toBeFalsy();
  return (result.structuredContent ?? {}) as Record<string, any>;
}

async function callErr(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const result = await mcp.callTool({ name, arguments: args });
  expect(result.isError, `${name} unexpectedly succeeded`).toBe(true);
  return (result.structuredContent ?? {}) as Record<string, any>;
}

describe("triangle e2e: every tool against the in-process mock", () => {
  let userId: string;
  let groupId: string;
  let memberIds: string[];

  it("discovery tools return the documented shapes", async () => {
    const spc = await callOk("get_service_provider_config", {});
    expect(spc.pagination.cursor).toBe(true);

    const resourceTypes = await callOk("list_resource_types", {});
    expect(resourceTypes.totalResults).toBe(2);

    const schemas = await callOk("list_schemas", {});
    expect(schemas.totalResults).toBe(6);
  });

  it("provision_user creates a user and never echoes the password", async () => {
    const created = await callOk("provision_user", {
      userName: "e2e.user@contoso.local",
      password: "S3cret!Pass",
      displayName: "E2E User",
      givenName: "E2E",
      familyName: "User",
      mailNickname: "e2euser",
      department: "Engineering",
      addresses: [{ type: "work", locality: "Sydney" }],
    });
    expect(created.id).toBeDefined();
    expect(created.password).toBeUndefined();
    expect(created[SCHEMA_ENTRA_USER].mailNickname).toBe("e2euser");
    userId = created.id as string;
  });

  it("get_user and list_users (filtered) find the user", async () => {
    const fetched = await callOk("get_user", { id: userId });
    expect(fetched.userName).toBe("e2e.user@contoso.local");

    const list = await callOk("list_users", {
      filter: [{ attr: "userName", op: "eq", value: "e2e.user@contoso.local" }],
    });
    expect(list.resources).toHaveLength(1);
    expect(list.resources[0].id).toBe(userId);

    const byNick = await callOk("list_users", {
      filter: [{ attr: "mailNickname", op: "ew", value: "user" }],
    });
    expect(byNick.resources.some((r: { id: string }) => r.id === userId)).toBe(true);
  });

  it("update_user applies simple and filtered-path patches", async () => {
    await callOk("update_user", {
      id: userId,
      operations: [
        { op: "replace", path: "displayName", value: "E2E Updated" },
        {
          op: "replace",
          path: 'addresses[type eq "work"]',
          value: { locality: "Melbourne" },
        },
      ],
    });
    const fetched = await callOk("get_user", { id: userId });
    expect(fetched.displayName).toBe("E2E Updated");
    expect(fetched.addresses[0].locality).toBe("Melbourne");
  });

  it("update_user_lifecycle sets employeeLeaveDateTime", async () => {
    await callOk("update_user_lifecycle", {
      id: userId,
      employeeLeaveDateTime: "2026-12-31T17:00:00Z",
    });
    const fetched = await callOk("get_user", { id: userId });
    expect(fetched[SCHEMA_ENTRA_USER].employeeLeaveDateTime).toBe("2026-12-31T17:00:00Z");
  });

  it("CSA update and set-qualified read round-trip", async () => {
    await callOk("update_user_custom_security_attributes", {
      id: userId,
      operations: [
        {
          op: "add",
          path: `${SCHEMA_ENTRA_CSA}:Project.ProjectName`,
          value: "IdentityHub",
        },
      ],
    });
    const fetched = await callOk("get_user_custom_security_attributes", {
      id: userId,
      attributeSets: ["Project"],
    });
    expect(fetched[SCHEMA_ENTRA_CSA]).toEqual({
      Project: { ProjectName: "IdentityHub" },
    });
    expect(fetched.userName).toBeUndefined(); // projection returned CSA only
  });

  it("create_group creates with the Entra extension", async () => {
    const created = await callOk("create_group", {
      displayName: "E2E Group",
      description: "triangle test group",
      mailNickname: "e2e-group",
      securityEnabled: true,
      mailEnabled: false,
    });
    expect(created.id).toBeDefined();
    groupId = created.id as string;
  });

  it("add_group_members chunks 25 ids into 2 PATCH calls", async () => {
    memberIds = Array.from(
      { length: 24 },
      (_, i) =>
        mock.store.createUser({
          schemas: [SCHEMA_USER_CORE],
          userName: `member${i}@contoso.local`,
        }).id,
    );
    memberIds.push(userId);

    const result = await callOk("add_group_members", {
      id: groupId,
      memberIds,
    });
    expect(result.patchCalls).toBe(2);
    expect(mock.store.getGroup(groupId)?.members).toHaveLength(25);
  });

  it("list_groups finds the group via members.value; get_group omits members", async () => {
    const byMember = await callOk("list_groups", {
      filter: [{ attr: "members.value", op: "eq", value: userId }],
    });
    expect(byMember.resources).toHaveLength(1);
    expect(byMember.resources[0].id).toBe(groupId);

    const fetched = await callOk("get_group", { id: groupId });
    expect(fetched.members).toBeUndefined();
  });

  it("remove_group_member removes exactly one member", async () => {
    await callOk("remove_group_member", { id: groupId, memberId: userId });
    expect(mock.store.getGroup(groupId)?.members).toHaveLength(24);
  });

  it("update_group patches attributes but rejects membership ops", async () => {
    await callOk("update_group", {
      id: groupId,
      operations: [{ op: "replace", path: "displayName", value: "E2E Renamed" }],
    });
    const fetched = await callOk("get_group", { id: groupId });
    expect(fetched.displayName).toBe("E2E Renamed");

    const err = await callErr("update_group", {
      id: groupId,
      operations: [{ op: "add", path: "members", value: [{ value: userId }] }],
    });
    expect(err.error).toBe("PatchValidationError");
  });

  it("negative paths propagate as structured errors", async () => {
    const badFilter = await callErr("list_users", {
      filter: [{ attr: "displayName", op: "eq", value: "x" }],
    });
    expect(badFilter.error).toBe("FilterValidationError");

    const dupe = await callErr("provision_user", {
      userName: "e2e.user@contoso.local",
      password: "S3cret!Pass",
      displayName: "Dupe",
      givenName: "D",
      familyName: "U",
      mailNickname: "dupe",
    });
    expect(dupe.error).toBe("ScimError");
    expect(dupe.status).toBe(409);
    expect(dupe.scimType).toBe("uniqueness");

    const missing = await callErr("get_user", { id: "no-such-id" });
    expect(missing.status).toBe(404);

    const badPatch = await callErr("update_user", {
      id: userId,
      operations: [{ op: "remove", path: "mailNickname" }],
    });
    expect(badPatch.error).toBe("PatchValidationError");

    const partial = await callErr("add_group_members", {
      id: groupId,
      memberIds: ["not-a-real-user"],
    });
    expect(partial.error).toBe("AddGroupMembersPartialFailure");
    expect(partial.cause.status).toBe(400);
  });

  it("delete_group and deprovision_user clean up", async () => {
    await callOk("delete_group", { id: groupId });
    const goneGroup = await callErr("get_group", { id: groupId });
    expect(goneGroup.status).toBe(404);

    await callOk("deprovision_user", { id: userId });
    const goneUser = await callErr("get_user", { id: userId });
    expect(goneUser.status).toBe(404);
  });
});
