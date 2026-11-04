// The permission check across the REAL wire, both halves of it: the orchestrator's `httpForge`
// → an actual HTTP request → this package's service route and its request schema → the real
// provider adapter → the provider's own API.
//
// It exists because of a bug that every in-process test missed. Radicle's `write` tier is
// permissionless on a public repository, so the orchestrator asks it for a user who has no
// linked Radicle identity at all — there is no subject to name. The orchestrator's own suites
// install a fake at the `Forge` PORT, above the wire, so they answered that case happily while
// production could not: the subject failed `PermissionRequestSchema`, the service replied 400,
// `httpForge` mapped any non-2xx to "unknown", and every gate reads "unknown" as denied. The
// whole tier was dead in the only deployment shape that matters.
//
// So the seam under test is not any one layer, it is the agreement BETWEEN layers about how
// "there is no identity" is spelled — null, end to end. Re-tightening the schema against that
// spelling has to break a test, and this is the test.
//
// Cross-package by design: `httpForge` lives in @ryph/orchestrator and the service route lives
// here, and a test of the wire between them cannot honestly live on one side of it. Same shape
// as radicle_bridge_e2e_test.ts, which reaches into @ryph/radicle for the node it dials.

import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals } from "@std/assert";
import { serve } from "@ryph/service";
import { makeHandler } from "../src/http/app.ts";
import type { AppDeps } from "../src/http/app.ts";
import { type ForgeApi, providerRegistry } from "../src/ports/forge_api.ts";
import { radicleForgeApi } from "../src/adapters/forge_api/radicle.ts";
import { githubForgeApi } from "../src/adapters/forge_api/github.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { githubChangeTransport } from "../src/adapters/change_transport/github.ts";
import { httpForge } from "../../orchestrator/src/adapters/forge/http.ts";
import { silentDiagnostics } from "./util.ts";

const RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
const THEM = "did:key:z6MktaNvN1tMt1Nkm5gNomgQsjqR3nrPtAVSt58BJgmv5J3z";
const SERVICE_TOKEN = "service-secret";
const BRIDGE_TOKEN = "bridge-secret";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** The identity document the fake bridge serves — `visibility` is the whole question here. */
const identityDoc = (visibility: "public" | "private") => ({
  rid: RID,
  name: "payments",
  description: "the payments service",
  defaultBranch: "main",
  delegates: [THEM],
  threshold: 1,
  visibility,
  allow: [],
  self: { did: THEM, nid: "z6Mkire", alias: "ryph" },
  isDelegate: false,
  isAllowed: true,
});

async function testKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/**
 * The whole stack, on two loopback sockets: a fake Radicle bridge and a fake GitHub behind the
 * real adapters, and the real service handler in front of them. `visibility` is what the
 * bridge's identity document says.
 *
 * The fake GitHub answers EVERY collaborator lookup "admin". That is deliberate: if a null
 * subject ever reached the GitHub adapter's URL it would ask about a user literally named
 * "null" and be told yes, so a wrong answer here is loud rather than incidental.
 */
async function withStack(
  visibility: "public" | "private",
  body: (
    forge: ReturnType<typeof httpForge>,
    asked: { bridge: string[]; github: string[] },
  ) => Promise<void>,
) {
  const diag = silentDiagnostics();
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const asked = { bridge: [] as string[], github: [] as string[] };

  const bridge = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    asked.bridge.push(path);
    return /^\/v1\/repos\/[^/]+$/.test(path)
      ? json(identityDoc(visibility))
      : json({ error: "not found" }, 404);
  });
  const github = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const path = new URL(req.url).pathname;
    if (/\/access_tokens$/.test(path)) {
      return json(
        { token: "ghs_test", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        201,
      );
    }
    asked.github.push(path);
    return json({ permission: "admin" });
  });

  const githubApi = await githubForgeApi({
    appId: "999",
    privateKeyPem: await testKeyPem(),
    oauth: { clientId: "Iv1.client", clientSecret: "shhh" },
    apiBase: `http://127.0.0.1:${github.addr.port}`,
    oauthBase: `http://127.0.0.1:${github.addr.port}`,
    diag,
  });
  const radicleApi = radicleForgeApi({
    baseUrl: `http://127.0.0.1:${bridge.addr.port}`,
    token: BRIDGE_TOKEN,
    explorerUrl: null,
    diag,
  });

  const cache = localFsRepoCache({ root: `${root}/cache`, diag });
  const deps: AppDeps = {
    keys: { resolve: () => Promise.resolve(null) },
    cache,
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: providerRegistry<ForgeApi>(
      { github: githubApi, radicle: radicleApi },
      "forge API",
    ),
    // Required alongside `forges` for the service routes to mount at all; no patch is submitted
    // here, so GitHub's is enough to satisfy the wiring.
    transports: providerRegistry(
      { github: githubChangeTransport({ api: githubApi, cache, diag }) },
      "change transport",
    ),
    serviceToken: SERVICE_TOKEN,
    config: { maxUploadPackBytes: 1024, maxBundleBytes: 1024, stagingDir: `${root}/staging` },
  };
  const service = await serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    makeHandler(deps),
  );

  try {
    await body(
      httpForge({
        baseUrl: `http://127.0.0.1:${service.addr.port}`,
        forgeToken: SERVICE_TOKEN,
        diag,
        // Off, so each question in a test is its own round trip rather than a cache hit.
        permissionTtlMs: 0,
      }),
      asked,
    );
  } finally {
    await service.shutdown();
    await bridge.shutdown();
    await github.shutdown();
    await rm(root, { recursive: true });
  }
}

const radicleRepo = { provider: "radicle", repoRef: RID, tenantId: null } as const;
const githubRepo = { provider: "github", repoRef: "acme/app", tenantId: "42" } as const;

test("a subjectless write check reaches Radicle's permissionless tier across the real wire", async () => {
  await withStack("public", async (forge, asked) => {
    // THE regression. No linked Radicle identity, a public repo, `write`: allowed, because
    // contribution on Radicle needs nobody's permission. Every layer between here and the
    // identity document has to carry "there is no identity" — as null — for this to be
    // "allowed" rather than the 400 → "unknown" → 403 the bug produced.
    assertEquals(
      await forge.checkPermission(radicleRepo, { provider: "radicle", subject: null }, "write"),
      "allowed",
    );
    // Not an accident of the request being rejected early: the bridge really was asked.
    assertEquals(asked.bridge.length, 1);

    // Naming an identity changes nothing on this tier — the adapter does not consult it.
    assertEquals(
      await forge.checkPermission(radicleRepo, { provider: "radicle", subject: THEM }, "write"),
      "allowed",
    );

    // `admin` is delegacy, and nobody holds that anonymously. Same wire, opposite answer, so
    // the null is being HANDLED rather than waved through wherever it lands.
    assertEquals(
      await forge.checkPermission(radicleRepo, { provider: "radicle", subject: null }, "admin"),
      "denied",
    );
  });
});

test("a private Radicle repo still refuses the subjectless caller across the real wire", async () => {
  await withStack("private", async (forge) => {
    // The allow list IS the answer here, and there is no DID to weigh against it.
    assertEquals(
      await forge.checkPermission(radicleRepo, { provider: "radicle", subject: null }, "write"),
      "denied",
    );
    // A delegate is in by construction, listed in `allow` or not — so "denied" above is the
    // rule and not the whole branch being broken.
    assertEquals(
      await forge.checkPermission(radicleRepo, { provider: "radicle", subject: THEM }, "write"),
      "allowed",
    );
  });
});

test("GitHub answers a subjectless check 'denied', and asks GitHub nothing", async () => {
  await withStack("public", async (forge, asked) => {
    // GitHub has no permissionless rung: both tiers are a grant somebody made to a named
    // account. A null subject is therefore answerable without asking GitHub, and the answer is
    // no — which is also what keeps a null out of `/collaborators/<login>/permission`, where
    // this fake would cheerfully report "admin" for a user named "null".
    for (const atLeast of ["write", "admin"] as const) {
      assertEquals(
        await forge.checkPermission(githubRepo, { provider: "github", subject: null }, atLeast),
        "denied",
      );
    }
    assertEquals(asked.github, [], "a subjectless check never reaches GitHub");

    // A named one does reach it, so the "denied" above is the null rule and not a dark route.
    assertEquals(
      await forge.checkPermission(githubRepo, { provider: "github", subject: "ada" }, "write"),
      "allowed",
    );
    assertEquals(asked.github.length, 1);
  });
});
