// The fetch credential on door ①: WHICH credential a base repo is fetched with, and — where it
// matters more — which host it is offered to.
//
// The claim under test is the one that makes a private connected repo cloneable at all: the
// gateway mints a live token for the tenant that granted us the repo, scopes it to that repo's
// own origin, and spends it only on the requests that actually talk upstream.

import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import {
  anonymous,
  type CachedRepo,
  type FetchAuth,
  type RepoCache,
  type ServedBase,
  UpstreamRefused,
} from "../src/ports/repo_cache.ts";
import { TokenMintError } from "../src/helpers/app_token.ts";
import { type ForgeApi, ForgeApiError, providerRegistry } from "../src/ports/forge_api.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import type { PatchStore } from "../src/ports/patch_store.ts";
import type { RunGrant, RunGrantRepo } from "../src/core/types.ts";
import { recordingDiagnostics } from "./util.ts";

const TOKEN = "virtual-key-run-1";
const UPSTREAM = "https://github.com/acme/payments.git";

const REPO = "cr-payments";

function grantFor(over: Partial<RunGrantRepo> = {}): RunGrant {
  return {
    runId: "r-1",
    repos: [{
      connectedRepoId: REPO,
      provider: "github" as const,
      repoRef: "acme/app",
      url: UPSTREAM,
      ref: "main",
      branchNamespace: "ryph/ada/r-1",
      tenantId: "161110166",
      ...over,
    }],
  };
}

/** A cache that fetches nothing and remembers what it was handed. `cached` seeds `find`, which
 * is what separates "this request served from disk" from "this request went upstream". The
 * credential is resolved the way the real adapter resolves it: as the fetch's first step, so a
 * credential that rejects is a fetch that never happened; and `serveBase` keeps the port's
 * contract, serving a `cached` entry stale around any failure but a refusal. */
function recordingCache(opts: { cached?: boolean } = {}) {
  const fetches: Array<{ url: string; ref: string; auth: FetchAuth | null }> = [];
  const held: ServedBase = {
    dir: "/nowhere",
    localBranch: "main",
    commit: "0".repeat(40),
    freshness: { kind: "fresh" },
  };
  const cache: RepoCache = {
    async refreshBase(coords, ref, credential): Promise<CachedRepo> {
      const auth = await credential();
      fetches.push({ url: coords.url, ref, auth });
      return { dir: "/nowhere", localBranch: "main" };
    },
    async serveBase(coords, ref, credential): Promise<ServedBase> {
      try {
        await cache.refreshBase(coords, ref, credential);
        return held;
      } catch (err) {
        if (!opts.cached || err instanceof UpstreamRefused) throw err;
        return { ...held, freshness: { kind: "stale", since: "2026-09-30T08:00:00.000Z" } };
      }
    },
    find: () => Promise.resolve(opts.cached ? held : null),
    ensureCommit: () => Promise.reject(new Error("not part of this surface")),
    withHeld: () => Promise.reject(new Error("not part of this surface")),
    remoteDefaultBranch: () => Promise.reject(new Error("not part of this surface")),
    remoteBranchHead: () => Promise.reject(new Error("not part of this surface")),
  };
  return { cache, fetches };
}

/** Only `installationToken` is reachable from door ①; the rest of the port would be a lie. */
function fakeForgeApi(token: string | Error) {
  const minted: string[] = [];
  const api = {
    upstreamUrl: (_repo: unknown, url: string) => url,
    fetchAuth(repo: { tenantId: string | null }, url: string) {
      if (repo.tenantId === null) return Promise.resolve(null);
      minted.push(repo.tenantId);
      return token instanceof Error
        ? Promise.reject(token)
        : Promise.resolve({ origin: new URL(url).origin, token });
    },
  } as unknown as ForgeApi;
  return { api, minted };
}

function build(
  opts: {
    grant?: RunGrant;
    token?: string | Error;
    forgeApi?: boolean;
    cached?: boolean;
  } = {},
) {
  const { diag, events } = recordingDiagnostics();
  const { cache, fetches } = recordingCache({ cached: opts.cached });
  const { api, minted } = fakeForgeApi(opts.token ?? "ghs_live_token");
  const grant = opts.grant ?? grantFor();
  const keys: KeyStore = {
    resolve: (t) => Promise.resolve(t === TOKEN ? structuredClone(grant) : null),
  };
  const deps: AppDeps = {
    keys,
    cache,
    patches: {} as PatchStore, // door ② is not in this story
    diag,
    forges: opts.forgeApi === false ? null : providerRegistry({ github: api }, "forge API"),
    serviceToken: "service-secret",
    config: { maxUploadPackBytes: 1024, maxBundleBytes: 1024, stagingDir: "/nowhere" },
  };
  return { handler: makeHandler(deps), fetches, minted, events };
}

const authHeader = { authorization: `Basic ${btoa(`x-access-token:${TOKEN}`)}` };

/** The advertisement — the request that fetches from upstream, once per clone. */
function advertise(handler: (req: Request) => Promise<Response>, runId = "r-1", repo = REPO) {
  return handler(
    new Request(
      `http://gw.test/v1/git/${runId}/${repo}/repo.git/info/refs?service=git-upload-pack`,
      { headers: authHeader },
    ),
  );
}

test("a connected repo is fetched with a token minted for the tenant that granted it", async () => {
  const { handler, fetches, minted } = build();
  await (await advertise(handler)).body?.cancel();

  assertEquals(minted, ["161110166"]);
  assertEquals(fetches.length, 1);
  assertEquals(fetches[0].auth, {
    // The repo's OWN origin — not a configured one, and not anything a task's author picked.
    origin: "https://github.com",
    token: "ghs_live_token",
  });
});

test("a repo with no tenant to mint for fetches as nobody", async () => {
  const { handler, fetches, minted } = build({ grant: grantFor({ tenantId: null }) });
  await (await advertise(handler)).body?.cancel();

  assertEquals(minted, [], "nothing was minted for a repo with no tenant");
  assertEquals(fetches[0].auth, null);
});

test("a path upstream gets no credential, tenant or not", async () => {
  // Dev and tests clone from a directory. There is no origin to scope a header to, so there is
  // no safe way to attach one — and no need.
  const { handler, fetches, minted } = build({
    grant: grantFor({ url: "/srv/repos/payments" }),
  });
  await (await advertise(handler)).body?.cancel();

  assertEquals(minted, []);
  assertEquals(fetches[0].auth, null);
});

test("a credential that cannot be minted is a 502 on a cold cache, and nothing is fetched", async () => {
  // Not a fall-through to an anonymous fetch: on a private repo that would surface as git's
  // `could not read Username`, which names neither the cause nor the fix. The mint fails inside
  // the cache's refresh, so the answer is the one every failed refresh gets.
  const { handler, fetches, events } = build({ token: new Error("GitHub said 500") });
  const res = await advertise(handler);

  assertEquals(res.status, 502);
  assertEquals(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assertEquals(
    await res.text(),
    "main of acme/app could not be fetched from upstream, and ryph holds no copy of it; " +
      "retry once the upstream is back\n",
  );
  assertEquals(fetches, [], "no upstream contact was attempted without the credential");
  assert(events.some((e) => e.level === "warn" && e.event === "git.token_unavailable"));
});

test("a mint that could not be asked is an outage, and a warm cache serves through it", async () => {
  // The token is minted inside the seam. GitHub unreachable at mint time is the same outage as
  // GitHub unreachable at fetch time, and a run whose base the cache holds still clones.
  const { handler, fetches, events } = build({
    cached: true,
    token: new TypeError("error sending request for url (https://api.github.com/...)"),
  });
  await (await advertise(handler)).body?.cancel();

  // The door went on to advertise: the mint failure was logged and did not refuse. The fake's
  // dir is not a repo, so the spawn that follows the decision fails, and that is the whole log.
  assertEquals(fetches, []);
  assertEquals(events.map((e) => e.event).filter((e) => e.startsWith("git.")), [
    "git.token_unavailable",
    "git.advertise_failed",
  ]);
});

test("a mint the forge refused is never served around, warm cache or not", async () => {
  // 403 is the installation's owner saying no (suspended, removed, a permission withdrawn),
  // and a copy the cache holds is one they no longer grant.
  const { handler, fetches, events } = build({
    cached: true,
    token: new TokenMintError("minting an installation token failed (403): suspended", 403),
  });
  const res = await advertise(handler);

  assertEquals(res.status, 502);
  assertEquals(
    await res.text(),
    "the upstream refused main of acme/app, and ryph will not serve a copy it holds: " +
      "minting an installation token failed (403): suspended\n",
  );
  assertEquals(fetches, []);
  assert(events.some((e) => e.event === "git.base_unavailable"));
});

test("a rate-limited mint is a budget, not a refusal: the warm cache still serves", async () => {
  const { handler, events } = build({
    cached: true,
    token: new TokenMintError("minting an installation token failed (429): slow down", 429),
  });
  await (await advertise(handler)).body?.cancel();
  assertEquals(events.map((e) => e.event).filter((e) => e.startsWith("git.")), [
    "git.token_unavailable",
    "git.advertise_failed",
  ]);
});

test("a terminal forge refusal of the credential is never served around either", async () => {
  // A user-mode GitHub asked about a repo that names an installation: a wiring fault no retry
  // fixes, so the warm copy is not an answer to it. A retryable ForgeApiError stays an outage.
  const terminal = build({
    cached: true,
    token: new ForgeApiError("acme/app names a GitHub App installation", true),
  });
  const res = await advertise(terminal.handler);
  assertEquals(res.status, 502);
  assertStringIncludes(await res.text(), "names a GitHub App installation");
  assert(terminal.events.some((e) => e.event === "git.base_unavailable"));

  const retryable = build({ cached: true, token: new ForgeApiError("GitHub blinked", false) });
  await (await advertise(retryable.handler)).body?.cancel();
  assert(!retryable.events.some((e) => e.event === "git.base_unavailable"));
});

test("a request that refreshes a target and then its base mints once", async () => {
  const { handler, fetches, minted } = build({ grant: grantFor({ targetRef: "develop" }) });
  await (await advertise(handler)).body?.cancel();

  assertEquals(fetches.map((f) => f.ref), ["develop", "main"]);
  assertEquals(minted, ["161110166"]);
});

test("a tenant with no App configured degrades to anonymous, and says so", async () => {
  // A wiring mismatch — the control plane says this repo came in through a forge, this gateway
  // has no App. Worth a line in the log; not worth failing a public clone over.
  const { handler, fetches, events } = build({ forgeApi: false });
  await (await advertise(handler)).body?.cancel();

  assertEquals(fetches[0].auth, null);
  assert(events.some((e) => e.level === "warn" && e.event === "git.no_forge_api"));
});

test("a Radicle repo is fetched from the bridge's git door, with a bearer", async () => {
  // A RID is not a git address. The gateway asks the repo's OWN adapter where its base comes
  // from (`ForgeApi.upstreamUrl`) and what to present there — so the runner's clone is
  // unchanged, and nothing outside the adapter knows a bridge exists.
  const { diag, events } = recordingDiagnostics();
  const { cache, fetches } = recordingCache();
  const bridge = "http://radicle.test:7470";
  const rid = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
  const api = {
    upstreamUrl: (repo: { repoRef: string }) =>
      `${bridge}/v1/repos/${encodeURIComponent(repo.repoRef)}/git`,
    fetchAuth: () =>
      Promise.resolve({ origin: bridge, token: "bridge-secret", scheme: "bearer" as const }),
  } as unknown as ForgeApi;
  const grant: RunGrant = {
    runId: "r-1",
    repos: [{
      connectedRepoId: REPO,
      provider: "radicle" as const,
      repoRef: rid,
      // The row holds the RID as the repo's address; the fetchable upstream is derived.
      url: rid,
      ref: "main",
      branchNamespace: "ryph/ada/r-1",
      tenantId: null,
    }],
  };
  const deps: AppDeps = {
    keys: { resolve: (t) => Promise.resolve(t === TOKEN ? structuredClone(grant) : null) },
    cache,
    patches: {} as PatchStore,
    diag,
    forges: providerRegistry({ radicle: api }, "forge API"),
    serviceToken: "service-secret",
    config: { maxUploadPackBytes: 1024, maxBundleBytes: 1024, stagingDir: "/nowhere" },
  };
  await (await advertise(makeHandler(deps))).body?.cancel();

  assertEquals(fetches.length, 1);
  assertEquals(fetches[0].url, `${bridge}/v1/repos/${encodeURIComponent(rid)}/git`);
  assertEquals(fetches[0].auth, { origin: bridge, token: "bridge-secret", scheme: "bearer" });
  assertEquals(events.filter((e) => e.event === "git.no_forge_api"), []);
});

test("upload-pack spends a token only when it has to fetch", async () => {
  // The POSTs after an advertisement serve from the cache; minting on each would be a round
  // trip per request of every clone.
  const warm = build({ cached: true });
  const post = (h: (req: Request) => Promise<Response>) =>
    h(
      new Request(`http://gw.test/v1/git/r-1/${REPO}/repo.git/git-upload-pack`, {
        method: "POST",
        headers: authHeader,
        body: "0000",
      }),
    );
  await (await post(warm.handler)).body?.cancel();
  assertEquals(warm.minted, [], "a warm cache asks GitHub for nothing");
  assertEquals(warm.fetches, []);

  // A POST with no prior advertisement (or a wiped cache) still has to fetch — and pays.
  const cold = build({ cached: false });
  await (await post(cold.handler)).body?.cancel();
  assertEquals(cold.minted, ["161110166"]);
  assertEquals(cold.fetches[0].auth?.token, "ghs_live_token");
});

test("the credential is resolved only AFTER the grant is, never for a stranger", async () => {
  const { handler, minted, fetches } = build();
  const res = await handler(
    new Request(`http://gw.test/v1/git/r-1/${REPO}/repo.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${btoa("x-access-token:not-a-key")}` },
    }),
  );
  await res.body?.cancel();

  assertEquals(res.status, 401);
  assertEquals(minted, [], "an unauthenticated caller never causes a token to exist");
  assertEquals(fetches, []);
});

// ---------------------------------------------------------------------------
// The other end of the claim: what the cache adapter actually puts on the wire. A stub
// upstream records the one header that matters and refuses — the fetch fails either way, and
// the failure is not what is being measured.
// ---------------------------------------------------------------------------

async function stubUpstream() {
  const seen: Array<string | null> = [];
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    seen.push(req.headers.get("authorization"));
    return new Response("nope", { status: 404 });
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}/repo.git`,
    seen,
    shutdown: () => server.shutdown(),
  };
}

const basic = (token: string) => `Basic ${btoa(`x-access-token:${token}`)}`;

test("the per-fetch credential is the one git sends", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = await stubUpstream();
  const { diag } = recordingDiagnostics();
  try {
    const cache = localFsRepoCache({ root: `${root}/cache`, diag });

    await assertRejects(() =>
      cache.refreshBase({ url: upstream.url }, "main", () =>
        Promise.resolve({
          origin: new URL(upstream.url).origin,
          token: "ghs_live_token",
        }))
    );
    assertEquals(upstream.seen.at(-1), basic("ghs_live_token"));
  } finally {
    await upstream.shutdown();
    await rm(root, { recursive: true });
  }
});

test("with no credential, the fetch is anonymous — no header invented", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = await stubUpstream();
  const { diag } = recordingDiagnostics();
  try {
    const cache = localFsRepoCache({ root: `${root}/cache`, diag });
    await assertRejects(() => cache.refreshBase({ url: upstream.url }, "main", anonymous));
    assertEquals(upstream.seen.at(-1), null);
  } finally {
    await upstream.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a member outside the grant's set is a 401 like any other bad credential", async () => {
  const { handler, minted, fetches } = build();
  const res = await advertise(handler, "r-1", "cr-somebody-elses");
  await res.body?.cancel();
  assertEquals(res.status, 401);
  assertEquals(minted, [], "nothing is minted for a repo the run does not hold");
  assertEquals(fetches, []);
});

test("a two-repo grant serves each member from its own upstream, by the id in the path", async () => {
  const grant: RunGrant = {
    runId: "r-1",
    repos: [
      {
        connectedRepoId: "cr-api",
        provider: "github" as const,
        repoRef: "acme/app",
        url: "https://github.com/acme/api.git",
        ref: "main",
        branchNamespace: "ryph/ada/r-1",
        tenantId: "161110166",
      },
      {
        connectedRepoId: "cr-web",
        provider: "github" as const,
        repoRef: "acme/app",
        url: "https://github.com/acme/web.git",
        ref: "develop",
        branchNamespace: "ryph/ada/r-1",
        tenantId: "161110166",
      },
    ],
  };
  const { handler, fetches } = build({ grant });
  await (await advertise(handler, "r-1", "cr-web")).body?.cancel();
  await (await advertise(handler, "r-1", "cr-api")).body?.cancel();
  assertEquals(fetches.map((f) => [f.url, f.ref]), [
    ["https://github.com/acme/web.git", "develop"],
    ["https://github.com/acme/api.git", "main"],
  ]);
});

test("a GitLab member is never fetched by its path, even with no GitLab adapter to locate it", async () => {
  // The grant's URL is where the project WAS: a rename can have freed the path and somebody
  // else's public project taken it. A gateway whose GitLab config went missing cannot locate
  // the project by its id, so it fetches nothing — never the stranger's project at that path.
  const gitlab = {
    provider: "gitlab" as const,
    repoRef: "acme/app",
    url: "https://gitlab.example/acme/app.git",
    forgeId: "42@https://gitlab.example",
    tenantId: null,
  };
  for (const forgeApi of [false, true]) {
    const { handler, fetches, events } = build({ grant: grantFor(gitlab), forgeApi });
    const res = await advertise(handler);
    await res.body?.cancel();
    assertEquals(fetches, [], `forges: ${forgeApi}`);
    assertEquals(res.status, 502);
    assert(events.some((e) => e.level === "warn" && e.event === "git.no_forge_api"));
  }
});
