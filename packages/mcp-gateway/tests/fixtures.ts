// Shared test fixtures: a server row, an open upstream policy, and a router over a Route list.

import type { McpServer } from "../src/core/types.ts";
import type { UpstreamPolicy } from "../src/core/upstream_guard.ts";

export const T0 = "2026-01-01T00:00:00.000Z";

export function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "ms-1",
    slug: "linear",
    name: "Linear",
    description: null,
    transport: "http",
    kind: "remote",
    url: "https://mcp.linear.example/mcp",
    auth: "bearer",
    encryptedAuth: 'sealed:{"Authorization":"Bearer real-linear-token"}',
    authLast4: "oken",
    catalogueId: null,
    custom: null,
    settings: null,
    host: null,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** Everything is public and resolves: the guard is out of the way unless a test wants it. */
export const openPolicy: UpstreamPolicy = {
  allowInsecure: true,
  allowPrivate: true,
  resolve: () => Promise.resolve(["8.8.8.8"]),
};

/** The "sealed" fixture format keeps the crypto out of every test but the store's. */
export const fakeDecrypt = (sealed: string) => Promise.resolve(sealed.replace(/^sealed:/, ""));
export const fakeEncrypt = (plain: string) => Promise.resolve(`sealed:${plain}`);

export { makeRouter as router } from "@ryph/shared/http";

export function call(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = "user-secret",
): Promise<Response> {
  return handler(
    new Request(`http://control.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
