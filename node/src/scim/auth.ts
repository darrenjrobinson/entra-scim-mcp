import { ClientCertificateCredential, ClientSecretCredential } from "@azure/identity";
import type { AccessToken, TokenCredential } from "@azure/identity";
import { ConfigError } from "./errors.js";

export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

export interface ResolvedAuthConfig {
  tenantId: string;
  clientId: string;
  mode: "secret" | "certificate" | "static";
}

export interface AuthConfig extends ResolvedAuthConfig {
  credential: TokenCredential;
}

export interface LoadAuthOptions {
  /**
   * The SCIM base URL the client will target. Required when a static token is
   * configured, so the guardrail can refuse to send it to a real endpoint.
   */
  baseUrl?: string;
}

/**
 * Dev-only credential that hands back a fixed bearer token. Used to point the
 * MCP server at a local mock without touching Azure AD.
 */
export class StaticTokenCredential implements TokenCredential {
  constructor(private readonly token: string) {}

  async getToken(): Promise<AccessToken> {
    return { token: this.token, expiresOnTimestamp: Date.now() + 3600_000 };
  }
}

export function loadAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadAuthOptions = {},
): AuthConfig {
  const staticToken = env.ENTRA_SCIM_STATIC_TOKEN?.trim();
  if (staticToken) {
    return loadStaticAuth(env, staticToken, opts.baseUrl);
  }

  const tenantId = required(env.ENTRA_TENANT_ID, "ENTRA_TENANT_ID");
  const clientId = required(env.ENTRA_CLIENT_ID, "ENTRA_CLIENT_ID");

  const secret = env.ENTRA_CLIENT_SECRET?.trim();
  const certPath = env.ENTRA_CLIENT_CERT_PATH?.trim();
  const certPassword = env.ENTRA_CLIENT_CERT_PASSWORD;

  if (secret && certPath) {
    throw new ConfigError(
      "Both ENTRA_CLIENT_SECRET and ENTRA_CLIENT_CERT_PATH are set. Set exactly one.",
    );
  }

  if (secret) {
    return {
      tenantId,
      clientId,
      mode: "secret",
      credential: new ClientSecretCredential(tenantId, clientId, secret),
    };
  }

  if (certPath) {
    return {
      tenantId,
      clientId,
      mode: "certificate",
      credential: new ClientCertificateCredential(tenantId, clientId, {
        certificatePath: certPath,
        certificatePassword: certPassword,
      }),
    };
  }

  throw new ConfigError(
    "No credential configured. Set either ENTRA_CLIENT_SECRET or ENTRA_CLIENT_CERT_PATH.",
  );
}

function loadStaticAuth(
  env: NodeJS.ProcessEnv,
  token: string,
  baseUrl: string | undefined,
): AuthConfig {
  if (env.ENTRA_CLIENT_SECRET?.trim() || env.ENTRA_CLIENT_CERT_PATH?.trim()) {
    throw new ConfigError(
      "ENTRA_SCIM_STATIC_TOKEN cannot be combined with ENTRA_CLIENT_SECRET or ENTRA_CLIENT_CERT_PATH. A static token is for local mock endpoints only.",
    );
  }
  if (!baseUrl) {
    throw new ConfigError(
      "ENTRA_SCIM_STATIC_TOKEN requires ENTRA_SCIM_BASE_URL to point at a local mock endpoint. It never works against the real Entra SCIM API.",
    );
  }
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new ConfigError(`ENTRA_SCIM_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (
    host === "microsoft.com" ||
    host.endsWith(".microsoft.com") ||
    host === "microsoft.us" ||
    host.endsWith(".microsoft.us")
  ) {
    throw new ConfigError(
      `ENTRA_SCIM_STATIC_TOKEN must not be used against ${host}. Use a client secret or certificate for real endpoints.`,
    );
  }
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
    process.stderr.write(
      `entra-scim-mcp: WARNING - static token auth against non-loopback host "${host}". This mode is for local development only.\n`,
    );
  }
  return {
    tenantId: "local",
    clientId: "local",
    mode: "static",
    credential: new StaticTokenCredential(token),
  };
}

function required(value: string | undefined, name: string): string {
  const v = value?.trim();
  if (!v) throw new ConfigError(`Missing required env var: ${name}`);
  return v;
}
