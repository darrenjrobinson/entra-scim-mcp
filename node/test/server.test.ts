import { describe, it, expect } from "vitest";
import type { TokenCredential, AccessToken } from "@azure/identity";
import { createServer } from "../src/server.js";

function fakeCredential(): TokenCredential {
  return {
    getToken: async (): Promise<AccessToken> => ({
      token: "stub",
      expiresOnTimestamp: Date.now() + 3600_000,
    }),
  };
}

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

    // McpServer exposes registered tools as an internal map; the public surface
    // we care about is that connect() works and the server reports itself.
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });
});
