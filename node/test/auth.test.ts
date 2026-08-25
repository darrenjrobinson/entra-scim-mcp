import { describe, it, expect, vi, afterEach } from "vitest";
import { loadAuthFromEnv, StaticTokenCredential } from "../src/scim/auth.js";
import { ConfigError } from "../src/scim/errors.js";

const TENANT = "00000000-0000-0000-0000-000000000000";
const CLIENT = "11111111-1111-1111-1111-111111111111";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadAuthFromEnv (secret / certificate)", () => {
  it("builds a secret credential from env", () => {
    const auth = loadAuthFromEnv({
      ENTRA_TENANT_ID: TENANT,
      ENTRA_CLIENT_ID: CLIENT,
      ENTRA_CLIENT_SECRET: "s3cret",
    });
    expect(auth.mode).toBe("secret");
    expect(auth.tenantId).toBe(TENANT);
  });

  it("rejects secret and certificate together", () => {
    expect(() =>
      loadAuthFromEnv({
        ENTRA_TENANT_ID: TENANT,
        ENTRA_CLIENT_ID: CLIENT,
        ENTRA_CLIENT_SECRET: "s3cret",
        ENTRA_CLIENT_CERT_PATH: "/tmp/cert.pem",
      }),
    ).toThrow(ConfigError);
  });

  it("requires tenant and client ids", () => {
    expect(() =>
      loadAuthFromEnv({ ENTRA_CLIENT_SECRET: "x" }),
    ).toThrow(ConfigError);
  });
});

describe("loadAuthFromEnv (static token)", () => {
  const staticEnv = { ENTRA_SCIM_STATIC_TOKEN: "dev-token" } as NodeJS.ProcessEnv;

  it("returns a static credential without requiring tenant/client ids", async () => {
    const auth = loadAuthFromEnv(staticEnv, { baseUrl: "http://127.0.0.1:8990" });
    expect(auth.mode).toBe("static");
    expect(auth.credential).toBeInstanceOf(StaticTokenCredential);
    const token = await auth.credential.getToken("scope");
    expect(token?.token).toBe("dev-token");
  });

  it("requires a base URL", () => {
    expect(() => loadAuthFromEnv(staticEnv)).toThrow(ConfigError);
  });

  it("refuses microsoft.com hosts", () => {
    expect(() =>
      loadAuthFromEnv(staticEnv, { baseUrl: "https://graph.microsoft.com/rp/scim" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadAuthFromEnv(staticEnv, { baseUrl: "https://graph.microsoft.us/rp/scim" }),
    ).toThrow(ConfigError);
  });

  it("rejects combination with a real credential", () => {
    expect(() =>
      loadAuthFromEnv(
        {
          ...staticEnv,
          ENTRA_CLIENT_SECRET: "s3cret",
        },
        { baseUrl: "http://127.0.0.1:8990" },
      ),
    ).toThrow(ConfigError);
  });

  it("warns on non-loopback hosts but proceeds", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const auth = loadAuthFromEnv(staticEnv, {
      baseUrl: "https://my-tunnel.example.dev",
    });
    expect(auth.mode).toBe("static");
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("non-loopback"),
    );
  });

  it("does not warn for loopback hosts", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    loadAuthFromEnv(staticEnv, { baseUrl: "http://localhost:8990" });
    expect(write).not.toHaveBeenCalled();
  });
});
