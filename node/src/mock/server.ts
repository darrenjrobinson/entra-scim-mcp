import { createServer as createHttpServer, type Server } from "node:http";
import { createRequestListener, type CaptureEntry } from "./router.js";
import { MockStore, type SeedData } from "./store.js";

export const DEFAULT_MOCK_TOKEN = "dev-token";
export const DEFAULT_MOCK_PORT = 8990;

export interface CreateMockServerOptions {
  /** Bearer token the mock requires. Defaults to "dev-token". */
  token?: string;
  seed?: SeedData;
  /** Accept-superset behavior for the Microsoft SCIM Validator. */
  validatorCompat?: boolean;
  /** Receives every request/response pair (used for JSONL capture). */
  onTransaction?: (entry: CaptureEntry) => void;
}

export interface MockServer {
  httpServer: Server;
  store: MockStore;
  token: string;
  listen(port?: number, host?: string): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

export function createMockServer(options: CreateMockServerOptions = {}): MockServer {
  const token = options.token ?? DEFAULT_MOCK_TOKEN;
  const store = new MockStore();
  if (options.seed) store.seed(options.seed);

  const httpServer = createHttpServer(
    createRequestListener({
      token,
      store,
      validatorCompat: options.validatorCompat ?? false,
      onTransaction: options.onTransaction,
    }),
  );

  return {
    httpServer,
    store,
    token,
    listen(port = DEFAULT_MOCK_PORT, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          const address = httpServer.address();
          const actualPort = typeof address === "object" && address ? address.port : port;
          resolve({ port: actualPort, url: `http://${host}:${actualPort}` });
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
