// Registers as the operator would: the first `POST /v1/auth/users` carries the setup token the
// control plane prints at boot. Suites about anything after the bootstrap wrap their handler in
// this, so the bootstrap rule itself is tested once, in bootstrap_test.ts, rather than in each.

import type { AuthService } from "../src/core/service.ts";

export function asOperator(
  handler: (req: Request) => Promise<Response>,
  service: Pick<AuthService, "setupToken">,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/auth/users") {
      return await handler(req);
    }
    const token = await service.setupToken();
    const body = await req.json().catch(() => null);
    if (token === null || body === null || typeof body !== "object" || "setupToken" in body) {
      return await handler(
        new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body) }),
      );
    }
    return await handler(
      new Request(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify({ ...body, setupToken: token }),
      }),
    );
  };
}
