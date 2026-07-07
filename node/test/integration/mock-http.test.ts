import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createMockServer, type MockServer } from "../../src/mock/server.js";
import {
  SCHEMA_ENTRA_USER,
  SCHEMA_LIST_RESPONSE,
  SCHEMA_PATCH_OP,
  SCHEMA_USER_CORE,
} from "../../src/scim/types.js";

const TOKEN = "test-token";

let mock: MockServer;
let base: string;

beforeAll(async () => {
  mock = createMockServer({ token: TOKEN });
  const { url } = await mock.listen(0);
  base = url;
});

afterAll(async () => {
  await mock.close();
});

function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/scim+json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function newUser(userName: string): Record<string, unknown> {
  return {
    schemas: [SCHEMA_USER_CORE, SCHEMA_ENTRA_USER],
    userName,
    password: "P@ssw0rd!",
    displayName: `User ${userName}`,
    active: true,
    name: { givenName: "Test", familyName: "User" },
    [SCHEMA_ENTRA_USER]: { mailNickname: userName.split("@")[0] },
  };
}

describe("auth and query hygiene", () => {
  it("401s without a valid bearer", async () => {
    const res = await fetch(`${base}/users`, {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect(body.status).toBe("401");
  });

  it("400s on whitespace around = in the query string", async () => {
    const res = await call("GET", "/users?count =10");
    expect(res.status).toBe(400);
  });

  it("400s on percent-encoded whitespace around =", async () => {
    const res = await call("GET", "/users?count=%2010");
    expect(res.status).toBe(400);
  });

  it("400s when Accept does not allow JSON", async () => {
    const res = await call("GET", "/users", undefined, { Accept: "text/html" });
    expect(res.status).toBe(400);
  });

  it("404s unknown endpoints", async () => {
    const res = await call("GET", "/widgets");
    expect(res.status).toBe(404);
  });
});

describe("discovery", () => {
  it("serves ServiceProviderConfig with cursor-only pagination", async () => {
    const res = await call("GET", "/ServiceProviderConfig");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.pagination.cursor).toBe(true);
    expect(body.pagination.index).toBe(false);
    expect(body.bulk.supported).toBe(false);
  });

  it("serves resource types with schema extensions", async () => {
    const res = await call("GET", "/resourcetypes");
    const body = (await res.json()) as Record<string, any>;
    expect(body.totalResults).toBe(2);
    expect(body.Resources[0].schemaExtensions).toHaveLength(2);
  });

  it("serves all six schemas and individual lookups", async () => {
    const list = (await (await call("GET", "/schemas")).json()) as Record<string, any>;
    expect(list.totalResults).toBe(6);
    const single = await call("GET", `/schemas/${SCHEMA_USER_CORE}`);
    expect(single.status).toBe(200);
    expect(((await single.json()) as Record<string, unknown>).id).toBe(SCHEMA_USER_CORE);
  });

  it("accepts the /rp/scim path prefix", async () => {
    const res = await call("GET", "/rp/scim/serviceproviderconfig");
    expect(res.status).toBe(200);
  });
});

describe("user lifecycle over HTTP", () => {
  it("creates, reads, filters, patches, and deletes a user", async () => {
    const createRes = await call("POST", "/users", newUser("crud@x.com"));
    expect(createRes.status).toBe(201);
    expect(createRes.headers.get("location")).toMatch(/^\/users\//);
    const created = (await createRes.json()) as Record<string, any>;
    expect(created.password).toBeUndefined();
    const id = created.id as string;

    const getRes = await call("GET", `/users/${id}`);
    expect(getRes.status).toBe(200);

    const filterRes = await call(
      "GET",
      `/users?filter=${encodeURIComponent('userName eq "crud@x.com"')}`,
    );
    const filtered = (await filterRes.json()) as Record<string, any>;
    expect(filtered.schemas).toEqual([SCHEMA_LIST_RESPONSE]);
    expect(filtered.resources).toHaveLength(1);
    expect(filtered.totalResults).toBe(1);

    const patchRes = await call("PATCH", `/users/${id}`, {
      schemas: [SCHEMA_PATCH_OP],
      Operations: [{ op: "replace", path: "displayName", value: "Patched" }],
    });
    expect(patchRes.status).toBe(204);
    const after = (await (await call("GET", `/users/${id}`)).json()) as Record<string, any>;
    expect(after.displayName).toBe("Patched");

    const delRes = await call("DELETE", `/users/${id}`);
    expect(delRes.status).toBe(204);
    expect((await call("GET", `/users/${id}`)).status).toBe(404);
  });

  it("409s on duplicate userName", async () => {
    await call("POST", "/users", newUser("dupe@x.com"));
    const res = await call("POST", "/users", newUser("dupe@x.com"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.scimType).toBe("uniqueness");
  });

  it("400s when required attributes are missing", async () => {
    const res = await call("POST", "/users", { schemas: [SCHEMA_USER_CORE], userName: "x@y" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.detail).toContain("password");
  });

  it("rejects or-filters and non-allow-listed attributes with invalidFilter", async () => {
    const orRes = await call(
      "GET",
      `/users?filter=${encodeURIComponent('userName eq "a" or userName eq "b"')}`,
    );
    expect(orRes.status).toBe(400);
    expect(((await orRes.json()) as Record<string, unknown>).scimType).toBe("invalidFilter");

    const badAttr = await call(
      "GET",
      `/users?filter=${encodeURIComponent('displayName eq "a"')}`,
    );
    expect(badAttr.status).toBe(400);
  });

  it("supports attribute projection", async () => {
    const createRes = await call("POST", "/users", newUser("proj@x.com"));
    const id = ((await createRes.json()) as Record<string, any>).id as string;
    const res = await call("GET", `/users/${id}?attributes=displayName`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.displayName).toBeDefined();
    expect(body.userName).toBeUndefined();
    expect(body.id).toBe(id);
  });
});

describe("group lifecycle over HTTP", () => {
  async function createUserId(userName: string): Promise<string> {
    const res = await call("POST", "/users", newUser(userName));
    return ((await res.json()) as Record<string, any>).id as string;
  }

  it("creates a group and never returns members on reads", async () => {
    const u1 = await createUserId("m1@x.com");
    const createRes = await call("POST", "/groups", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "Team A",
    });
    expect(createRes.status).toBe(201);
    const gid = ((await createRes.json()) as Record<string, any>).id as string;

    const addRes = await call("PATCH", `/groups/${gid}`, {
      schemas: [SCHEMA_PATCH_OP],
      Operations: [{ op: "add", path: "members", value: [{ value: u1 }] }],
    });
    expect(addRes.status).toBe(204);

    const got = (await (await call("GET", `/groups/${gid}`)).json()) as Record<string, any>;
    expect(got.members).toBeUndefined();

    // membership is discoverable through the members.value filter
    const byMember = (await (
      await call("GET", `/groups?filter=${encodeURIComponent(`members.value eq "${u1}"`)}`)
    ).json()) as Record<string, any>;
    expect(byMember.resources).toHaveLength(1);
    expect(byMember.resources[0].id).toBe(gid);
  });

  it("enforces the 20-member add cap and sole-op rule", async () => {
    const gid = (
      (await (
        await call("POST", "/groups", {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "Caps",
        })
      ).json()) as Record<string, any>
    ).id as string;

    const ids = await Promise.all(
      Array.from({ length: 21 }, (_, i) => createUserId(`cap${i}@x.com`)),
    );
    const tooMany = await call("PATCH", `/groups/${gid}`, {
      schemas: [SCHEMA_PATCH_OP],
      Operations: [
        { op: "add", path: "members", value: ids.map((id) => ({ value: id })) },
      ],
    });
    expect(tooMany.status).toBe(400);

    const mixed = await call("PATCH", `/groups/${gid}`, {
      schemas: [SCHEMA_PATCH_OP],
      Operations: [
        { op: "add", path: "members", value: [{ value: ids[0] }] },
        { op: "replace", path: "displayName", value: "Nope" },
      ],
    });
    expect(mixed.status).toBe(400);
  });

  it("fails a member add when any id is invalid", async () => {
    const gid = (
      (await (
        await call("POST", "/groups", {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "Invalid member",
        })
      ).json()) as Record<string, any>
    ).id as string;
    const res = await call("PATCH", `/groups/${gid}`, {
      schemas: [SCHEMA_PATCH_OP],
      Operations: [{ op: "add", path: "members", value: [{ value: "nope" }] }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).detail).toContain(
      "does not exist",
    );
  });
});

describe("cursor pagination", () => {
  it("walks pages to exhaustion", async () => {
    const pagedMock = createMockServer({ token: TOKEN });
    const { url } = await pagedMock.listen(0);
    try {
      for (let i = 0; i < 5; i++) {
        pagedMock.store.createUser({
          schemas: [SCHEMA_USER_CORE],
          userName: `page${i}@x.com`,
        });
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const q = cursor ? `count=2&cursor=${cursor}` : "count=2";
        const res = await fetch(`${url}/users?${q}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        const body = (await res.json()) as Record<string, any>;
        seen.push(...body.resources.map((r: { userName: string }) => r.userName));
        cursor = body.nextCursor;
        expect(body.itemsPerPage).toBeLessThanOrEqual(2);
      } while (cursor);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    } finally {
      await pagedMock.close();
    }
  });
});

describe("validator-compat mode", () => {
  it("returns members, supports startIndex, and 200s on PATCH", async () => {
    const compat = createMockServer({ token: TOKEN, validatorCompat: true });
    const { url } = await compat.listen(0);
    try {
      const u = compat.store.createUser({
        schemas: [SCHEMA_USER_CORE],
        userName: "compat@x.com",
        displayName: "Compat",
      });
      const g = compat.store.createGroup({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: "CompatGroup",
      });
      compat.store.addGroupMembers(g.id, [u.id]);

      const got = (await (
        await fetch(`${url}/groups/${g.id}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).json()) as Record<string, any>;
      expect(got.members).toHaveLength(1);

      const indexed = (await (
        await fetch(`${url}/users?startIndex=1&count=10`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).json()) as Record<string, any>;
      expect(indexed.startIndex).toBe(1);

      const patchRes = await fetch(`${url}/users/${u.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/scim+json",
        },
        body: JSON.stringify({
          schemas: [SCHEMA_PATCH_OP],
          Operations: [{ op: "replace", path: "displayName", value: "Via compat" }],
        }),
      });
      expect(patchRes.status).toBe(200);
      expect(((await patchRes.json()) as Record<string, any>).displayName).toBe(
        "Via compat",
      );

      // non-allow-listed filter is accepted in compat mode
      const res = await fetch(
        `${url}/users?filter=${encodeURIComponent('displayName eq "Via compat"')}`,
        { headers: { Authorization: `Bearer ${TOKEN}` } },
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as Record<string, any>).resources).toHaveLength(1);
    } finally {
      await compat.close();
    }
  });
});
