// The management surface over a memory store, for the route tests: two gates (a user and an
// admin bearer), the real upstream rule over a fake resolver, a recording prober, and hosting
// either switched off or handed in by the test — usually the real service over a fake host.
// Archiving lives on the internal surface (the control plane fronts it); it is mounted here behind
// the admin gate, standing in for the service gate, so the route tests can archive.

import type { CatalogueEntry } from "../src/core/catalogue.ts";
import { type HostingService, unavailableHosting } from "../src/core/hosting.ts";
import type { McpServer } from "../src/core/types.ts";
import { checkUpstreamUrl, type UpstreamPolicy } from "../src/core/upstream_guard.ts";
import { forbidden } from "@ryph/auth";
import type { ProbeResult } from "../src/http/probe.ts";
import { archiveMcpServer, mcpServerRoutes } from "../src/http/routes.ts";
import { internalMcpRoutes } from "../src/http/internal.ts";
import type { McpSealer } from "../src/core/sealing.ts";
import type { Catalogue } from "../src/ports/catalogue.ts";
import type { GatewayStore } from "../src/ports/gateway_store.ts";
import { fakeDecrypt, fakeEncrypt, router, T0 } from "./fixtures.ts";
import { memoryGatewayStore } from "./memory_store.ts";

/**
 * The two bearers every route test speaks as: `ADMIN` is what managing a server takes, `PLAIN` is
 * a verified user who is not an admin — the one `call` defaults to is the admin, because most of
 * this surface is an admin's.
 */
export const ADMIN = "user-secret";
export const PLAIN = "plain-user";

/** A catalogue over fixed entries — the directory adapter has its own test. */
export function fixedCatalogue(entries: CatalogueEntry[]): Catalogue {
  return {
    list: () => Promise.resolve(structuredClone(entries)),
    get: (id) => Promise.resolve(structuredClone(entries.find((e) => e.id === id) ?? null)),
  };
}

const unauthorized = () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

export function makeApi(opts: {
  probe?: (s: McpServer) => Promise<ProbeResult>;
  store?: GatewayStore;
  catalogue?: Catalogue;
  hosting?: HostingService;
  /** The real sealer, for the tests that need the crypto; the `sealed:` fixture format else. */
  sealer?: McpSealer;
} = {}) {
  const store = opts.store ?? memoryGatewayStore();
  const sealed: string[] = [];
  const probed: McpServer[] = [];
  const policy: UpstreamPolicy = {
    allowInsecure: false,
    allowPrivate: false,
    // `*.example` and `*.example.com` are the tests' public internet; everything else — a
    // literal, a name a test invents — does not resolve, which the rule reads as not public.
    resolve: (host) => Promise.resolve(/\.example(\.com)?$/.test(host) ? ["93.184.215.14"] : []),
  };
  const manageGate = (req: Request) => {
    const auth = req.headers.get("authorization");
    if (auth === `Bearer ${ADMIN}`) return Promise.resolve(null);
    return Promise.resolve(
      auth === `Bearer ${PLAIN}`
        ? new Response(JSON.stringify(forbidden("tools:manage")), { status: 403 })
        : unauthorized(),
    );
  };
  const hosting = opts.hosting ?? unavailableHosting("no container backend in this test");
  const routes = mcpServerRoutes({
    store,
    encrypt: (plaintext, binding) => {
      sealed.push(plaintext);
      return opts.sealer ? opts.sealer.seal(plaintext, binding) : fakeEncrypt(plaintext);
    },
    decrypt: opts.sealer?.open ?? fakeDecrypt,
    authenticate: (req) => {
      const auth = req.headers.get("authorization");
      return Promise.resolve(
        auth === `Bearer ${ADMIN}` || auth === `Bearer ${PLAIN}` ? null : unauthorized(),
      );
    },
    authenticateRunRead: (req) => manageGate(req),
    authenticateManage: (req) => manageGate(req),
    checkUpstream: (target) => checkUpstreamUrl(target, policy),
    probe: opts.probe ?? ((s) => {
      probed.push(s);
      return Promise.resolve({
        ok: true,
        protocolVersion: "2025-06-18",
        serverInfo: { name: "fake", version: "1" },
        tools: [],
      });
    }),
    catalogue: opts.catalogue ?? fixedCatalogue([]),
    hosting,
    now: () => new Date(T0),
  });
  const internal = internalMcpRoutes({
    store,
    issuer: null,
    archive: archiveMcpServer({ store, hosting, now: () => new Date(T0) }),
    authenticate: manageGate,
    now: () => new Date(T0),
    diag: { warn: () => {} },
  });
  return { handler: router([...routes, ...internal]), store, sealed, probed };
}
