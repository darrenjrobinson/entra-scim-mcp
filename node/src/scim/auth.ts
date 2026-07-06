import { ClientCertificateCredential, ClientSecretCredential } from "@azure/identity";
import type { TokenCredential } from "@azure/identity";
import { ConfigError } from "./errors.js";

export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

export interface ResolvedAuthConfig {
  tenantId: string;
  clientId: string;
  mode: "secret" | "certificate";
}

export interface AuthConfig extends ResolvedAuthConfig {
  credential: TokenCredential;
}

export function loadAuthFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
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

export async function getAccessToken(credential: TokenCredential): Promise<string> {
  const token = await credential.getToken(GRAPH_SCOPE);
  if (!token) {
    throw new ConfigError("Failed to acquire Graph access token (credential returned null).");
  }
  return token.token;
}

function required(value: string | undefined, name: string): string {
  const v = value?.trim();
  if (!v) throw new ConfigError(`Missing required env var: ${name}`);
  return v;
}
