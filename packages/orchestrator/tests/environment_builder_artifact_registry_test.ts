// Removing what a registry-backed build pushed from Artifact Registry (artifact_registry.ts):
// a removal untags by name and deletes by recorded digest, never forced, so a tag somebody moved
// never decides what goes; what a crash or a race leaves is finished by the next attempt; a
// deletion with no verdict is asked again; a reconcile deletes only untagged versions nothing
// names, in this deployment's own path; a cache prune ages untagged exports. Against a fake of the
// REST API shaped like the real answers (measured against a live registry).

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  artifactRegistryCleaner,
  type ArtifactRegistryCleanerOptions,
  parseArtifactImage,
  parseArtifactRegistry,
} from "../src/adapters/environment_builder/artifact_registry.ts";
import { cloudBuildEnvironmentBuilder } from "../src/adapters/environment_builder/cloud_build.ts";
import { kubernetesEnvironmentBuilder } from "../src/adapters/environment_builder/kubernetes.ts";
import type { RemoveImagesSpec } from "../src/ports/environment_builder.ts";
import { silentDiagnostics, UNSIZED } from "./doubles.ts";

const REGISTRY = "us-central1-docker.pkg.dev/acme-dev/ryph-envs/ryph";
const BRANCH_REGISTRY = "us-central1-docker.pkg.dev/acme-dev/ryph-env-branches/ryph";
const API = "https://artifactregistry.googleapis.com/v1";
const REPO = "projects/acme-dev/locations/us-central1/repositories";
const NOW = Date.parse("2026-10-12T12:00:00Z");
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const ref = (pkg: string, d: string, registry = REGISTRY) => `${registry}/${pkg}@${d}`;

interface FakeVersion {
  tags: Set<string>;
  createTime: string;
  updateTime: string;
}

/**
 * Artifact Registry, as much of it as removal speaks: tags, versions with `relatedTags` (capped
 * at 100, as the real one is), packages, deletion as a long-running operation, a tagged version
 * refused without `force`, and Google's JSON errors.
 */
function fakeRegistry(opts: {
  /** What a version deletion's operation does: done (default), never done, or failed. */
  op?: (d: string) => "done" | "pending" | { code: number; message: string };
  /** How a tagged version's unforced deletion is refused; Google's documented answer is unknown. */
  tagged?: () => Response;
  /** An answer for a request, by method and path, before anything else is looked at. */
  refuse?: (method: string, path: string) => Response | undefined;
  pageSize?: number;
  cleaner?: Partial<ArtifactRegistryCleanerOptions>;
  now?: () => number;
} = {}) {
  // repository → package → digest → version
  const repos = new Map<string, Map<string, Map<string, FakeVersion>>>();
  const requests: Array<{ method: string; path: string }> = [];
  const ops = new Map<string, string>();
  const put = (
    repo: string,
    pkg: string,
    d: string,
    tags: string[],
    times: { created?: string; updated?: string } = {},
  ) => {
    const packages = repos.get(repo) ?? new Map();
    repos.set(repo, packages);
    const versions = packages.get(pkg) ?? new Map();
    packages.set(pkg, versions);
    const created = times.created ?? "2026-10-01T00:00:00Z";
    versions.set(d, {
      tags: new Set(tags),
      createTime: created,
      updateTime: times.updated ?? created,
    });
  };
  const json = (value: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(value), { status }));
  const notFound = () =>
    json(
      { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } },
      404,
    );
  const versionName = (repo: string, pkg: string, d: string) =>
    `${REPO}/${repo}/packages/${encodeURIComponent(pkg)}/versions/${d}`;
  const versionBody = (repo: string, pkg: string, d: string, v: FakeVersion) => ({
    name: versionName(repo, pkg, d),
    createTime: v.createTime,
    updateTime: v.updateTime,
    ...(v.tags.size === 0 ? {} : {
      relatedTags: [...v.tags].slice(0, 100).map((t) => ({
        name: `${REPO}/${repo}/packages/${encodeURIComponent(pkg)}/tags/${t}`,
        version: versionName(repo, pkg, d),
      })),
    }),
  });
  const page = <T>(all: T[], url: URL, key: string) => {
    const size = opts.pageSize ?? 1000;
    const from = Number(url.searchParams.get("pageToken") ?? "0");
    return json({
      [key]: all.slice(from, from + size),
      ...(from + size < all.length ? { nextPageToken: String(from + size) } : {}),
    });
  };
  let opCount = 0;

  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    assertEquals(url.origin + "/v1", API);
    const path = url.pathname.slice("/v1/".length);
    requests.push({ method, path: `${path}${url.search}` });
    assert(url.searchParams.get("force") !== "true", "never forced");
    const refused = opts.refuse?.(method, path);
    if (refused) return Promise.resolve(refused);

    const op = path.match(/^projects\/[^/]+\/locations\/[^/]+\/operations\/(.+)$/);
    if (op) {
      const d = ops.get(op[1]);
      if (d === undefined) return notFound();
      const how = opts.op?.(d) ?? "done";
      if (how === "pending") return json({ name: path, done: false });
      return json({ name: path, done: true, ...(how === "done" ? {} : { error: how }) });
    }
    const packages = path.match(
      /^projects\/acme-dev\/locations\/us-central1\/repositories\/([^/]+)\/packages$/,
    );
    if (packages) {
      const all = [...(repos.get(packages[1]) ?? new Map()).keys()].map((pkg) => ({
        name: `${REPO}/${packages[1]}/packages/${encodeURIComponent(pkg)}`,
      }));
      return page(all, url, "packages");
    }
    const m = path.match(
      /^projects\/acme-dev\/locations\/us-central1\/repositories\/([^/]+)\/packages\/([^/]+)\/(tags|versions)(?:\/(.+))?$/,
    );
    if (!m) return Promise.resolve(new Response("<html>404</html>", { status: 404 }));
    const [, repo, encodedPkg, kind, rest] = m;
    const pkg = decodeURIComponent(encodedPkg);
    const versions = repos.get(repo)?.get(pkg);
    if (kind === "tags" && rest !== undefined && method === "DELETE") {
      const tag = decodeURIComponent(rest);
      const found = [...(versions ?? new Map<string, FakeVersion>()).values()].find((v) =>
        v.tags.has(tag)
      );
      if (!found) return notFound();
      found.tags.delete(tag);
      found.updateTime = new Date(opts.now?.() ?? NOW).toISOString();
      return Promise.resolve(new Response("", { status: 200 }));
    }
    if (kind === "versions" && rest !== undefined && method === "DELETE") {
      const d = decodeURIComponent(rest);
      const version = versions?.get(d);
      if (version === undefined) return notFound();
      if (version.tags.size > 0) {
        if (opts.tagged) return Promise.resolve(opts.tagged());
        return json(
          { error: { code: 400, message: "tagged", status: "FAILED_PRECONDITION" } },
          400,
        );
      }
      const name = `op-${++opCount}`;
      ops.set(name, d);
      const how = opts.op?.(d) ?? "done";
      if (how === "done") versions!.delete(d);
      return json({ name: `projects/acme-dev/locations/us-central1/operations/${name}` });
    }
    if (kind === "versions" && rest !== undefined && method === "GET") {
      const d = decodeURIComponent(rest);
      const version = versions?.get(d);
      return version === undefined ? notFound() : json(versionBody(repo, pkg, d, version));
    }
    if (kind === "versions" && rest === undefined && method === "GET") {
      if (versions === undefined) return notFound();
      return page([...versions].map(([d, v]) => versionBody(repo, pkg, d, v)), url, "versions");
    }
    return json({ error: { message: `unexpected ${method} ${path}` } }, 500);
  };

  const cleaner = artifactRegistryCleaner(
    { registry: REGISTRY, branchRegistry: BRANCH_REGISTRY, operationPollMs: 1, ...opts.cleaner },
    silentDiagnostics(),
    {
      fetch: fetch as typeof globalThis.fetch,
      token: () => Promise.resolve("token"),
      now: opts.now ?? (() => NOW),
    },
  )!;
  const tagsOf = (repo: string, pkg: string, d: string) => {
    const version = repos.get(repo)?.get(pkg)?.get(d);
    return version === undefined ? null : [...version.tags].sort();
  };
  return { cleaner, put, requests, tagsOf };
}

const PKG = "ryph/repo-cr-api";
const SPEC: RemoveImagesSpec = {
  environmentId: "env-1",
  subjectKey: "repo-cr-api",
  defaultBranch: true,
  recorded: true,
  image: ref("repo-cr-api", digest("a")),
  machineImage: null,
  bakedImage: null,
};

test("a registry is Artifact Registry's repository and path; anything else is no registry here", () => {
  assertEquals(parseArtifactRegistry(REGISTRY), {
    location: "us-central1",
    project: "acme-dev",
    repository: "ryph-envs",
    prefix: "ryph/",
  });
  assertEquals(
    parseArtifactRegistry("us-central1-docker.pkg.dev/acme-dev/ryph-envs/")?.prefix,
    "",
  );
  assertEquals(parseArtifactRegistry("gcr.io/acme-dev/envs"), null);
  assertEquals(parseArtifactRegistry("registry.local:5000/envs"), null);
  assertEquals(parseArtifactRegistry(`${REGISTRY}/..`), null);
  assertEquals(parseArtifactRegistry("us-central1-docker.pkg.dev/acme-dev/ryph-envs/./x"), null);
  assertEquals(parseArtifactImage(ref("repo-cr-api", digest("a"))), {
    repo: parseArtifactRegistry("us-central1-docker.pkg.dev/acme-dev/ryph-envs")!,
    pkg: PKG,
    digest: digest("a"),
  });
  assertEquals(parseArtifactImage(`${REGISTRY}/repo-cr-api:baked-env-1@${digest("a")}`)?.pkg, PKG);
  assertEquals(parseArtifactImage(`${REGISTRY}/repo-cr-api:baked-env-1`), null, "not pinned");
  assertEquals(parseArtifactImage(`${REGISTRY}/../radicle/repo-cr-api@${digest("a")}`), null);
  assertEquals(parseArtifactImage(`ryph-env/repo-cr-api:baked-env-1`), null);
});

test("a retired build's own tags come off by name, and what it recorded goes by digest", async () => {
  const r = fakeRegistry();
  r.put("ryph-envs", PKG, digest("a"), ["env-1"]);
  r.put("ryph-envs", PKG, digest("b"), ["baked-env-1"]);
  r.put("ryph-envs", PKG, digest("e"), ["machine-env-1"]);
  r.put("ryph-envs", PKG, digest("c"), ["env-2"]);
  assert(
    await r.cleaner.removeBuild({
      ...SPEC,
      machineImage: ref("repo-cr-api", digest("e")),
      bakedImage: ref("repo-cr-api", digest("b")),
    }),
  );
  for (const d of ["a", "b", "e"]) assertEquals(r.tagsOf("ryph-envs", PKG, digest(d)), null);
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("c")), ["env-2"], "another build's");
  // The three names, exactly; nothing was read to find them.
  assertEquals(
    r.requests.filter((q) => q.path.includes("/tags/")).map((q) => q.path.split("/tags/")[1]),
    ["env-1", "baked-env-1", "machine-env-1"],
  );
  assertEquals(r.requests.filter((q) => q.method === "GET" && q.path.includes("/tags/")), []);
});

test("a tag pointed at another build's image never gets that image deleted", async () => {
  const r = fakeRegistry();
  // Whoever may push re-pointed `env-1` at a live build's image, and tagged the retiring build's.
  r.put("ryph-envs", PKG, digest("f"), ["env-9", "env-1"]);
  r.put("ryph-envs", PKG, digest("a"), ["somebody-else"]);
  assert(await r.cleaner.removeBuild(SPEC));
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("f")), ["env-9"], "untagged of ours only");
  // The recorded digest is still tagged by a stranger: kept, not forced.
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("a")), ["somebody-else"]);
});

test("two removals of one shared machine, at once, end with it deleted", async () => {
  const r = fakeRegistry();
  r.put("ryph-envs", PKG, digest("e"), ["machine-env-1", "machine-env-2"]);
  const machineImage = ref("repo-cr-api", digest("e"));
  const answers = await Promise.all([
    r.cleaner.removeBuild({ ...SPEC, image: null, machineImage }),
    r.cleaner.removeBuild({ ...SPEC, environmentId: "env-2", image: null, machineImage }),
  ]);
  assertEquals(answers, [true, true]);
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("e")), null);
});

test("one machine's first removal keeps it for the build still tagging it", async () => {
  const r = fakeRegistry();
  const others = Array.from({ length: 150 }, (_, i) => `machine-env-x${i}`);
  r.put("ryph-envs", PKG, digest("e"), ["machine-env-1", ...others]);
  assert(await r.cleaner.removeBuild({ ...SPEC, machineImage: ref("repo-cr-api", digest("e")) }));
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("e"))!.length, 150, "more than a page of tags");
});

test("a crash between the untag and the delete is finished by the next attempt", async () => {
  let down = true;
  const r = fakeRegistry({
    refuse: (method, path) =>
      down && method === "DELETE" && path.includes("/versions/")
        ? new Response(JSON.stringify({ error: { code: 503, status: "UNAVAILABLE" } }), {
          status: 503,
        })
        : undefined,
  });
  r.put("ryph-envs", PKG, digest("a"), ["env-1"]);
  await assertRejects(() => r.cleaner.removeBuild(SPEC));
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("a")), [], "untagged, still there");
  down = false;
  assert(await r.cleaner.removeBuild(SPEC));
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("a")), null);
});

test("a deletion with no verdict is asked again; a failed one rejects", async () => {
  let clock = NOW;
  const pending = fakeRegistry({
    op: () => "pending",
    now: () => (clock += 1_000),
    cleaner: { operationWaitMs: 5_000 },
  });
  pending.put("ryph-envs", PKG, digest("a"), ["env-1"]);
  assertEquals(await pending.cleaner.removeBuild(SPEC), false);

  const unread = fakeRegistry({
    op: () => "pending",
    refuse: (method, path) =>
      method === "GET" && path.includes("/operations/")
        ? new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED" } }), {
          status: 403,
        })
        : undefined,
  });
  unread.put("ryph-envs", PKG, digest("a"), ["env-1"]);
  assertEquals(await unread.cleaner.removeBuild(SPEC), false);

  const broken = fakeRegistry({ op: () => ({ code: 13, message: "internal" }) });
  broken.put("ryph-envs", PKG, digest("a"), ["env-1"]);
  await assertRejects(() => broken.cleaner.removeBuild(SPEC), Error, "internal");
});

test("a refusal is read back, whatever its code: still tagged is kept, untagged rejects", async () => {
  for (const status of [400, 409, 412]) {
    const r = fakeRegistry({
      tagged: () =>
        new Response(JSON.stringify({ error: { code: status, status: "ABORTED" } }), { status }),
    });
    r.put("ryph-envs", PKG, digest("e"), ["machine-env-1", "machine-env-2"]);
    assert(
      await r.cleaner.removeBuild({
        ...SPEC,
        image: null,
        machineImage: ref("repo-cr-api", digest("e")),
      }),
      `${status}: another build's tag keeps it`,
    );
    assertEquals(r.tagsOf("ryph-envs", PKG, digest("e")), ["machine-env-2"]);
  }
  // A refusal of a version with no tag left is no "kept": it is the refusal.
  const odd = fakeRegistry({
    refuse: (method, path) =>
      method === "DELETE" && path.includes("/versions/")
        ? new Response(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT" } }), {
          status: 400,
        })
        : undefined,
  });
  odd.put("ryph-envs", PKG, digest("a"), ["env-1"]);
  await assertRejects(() => odd.cleaner.removeBuild(SPEC));
  // An operation that ends in an error is read back the same way: still there, untagged, rejects.
  const late = fakeRegistry({ op: () => ({ code: 10, message: "aborted" }) });
  late.put("ryph-envs", PKG, digest("a"), ["env-1"]);
  await assertRejects(() => late.cleaner.removeBuild(SPEC), Error, "aborted");
});

test("a build no row recorded is only untagged", async () => {
  const r = fakeRegistry();
  r.put("ryph-envs", PKG, digest("e"), ["machine-env-1"]);
  r.put("ryph-envs", PKG, digest("b"), ["baked-env-1"]);
  assert(await r.cleaner.removeBuild({ ...SPEC, image: null }));
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("e")), []);
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("b")), []);
  assertEquals(r.requests.filter((q) => q.path.includes("/versions/")), []);
});

test("a branch build is removed from the branch registry, and only from its own package", async () => {
  const r = fakeRegistry();
  r.put("ryph-env-branches", PKG, digest("a"), ["env-1"]);
  r.put("ryph-envs", PKG, digest("a"), ["env-1"]);
  r.put("ryph-env-branches", "ryph/repo-cr-other", digest("d"), []);
  // A digest outside the row's package is never deleted: a leak, said once, and the row done
  // with, since nothing this deployment does will ever answer it.
  assert(
    await r.cleaner.removeBuild({
      ...SPEC,
      defaultBranch: false,
      image: ref("repo-cr-api", digest("a"), BRANCH_REGISTRY),
      bakedImage: ref("repo-cr-other", digest("d"), BRANCH_REGISTRY),
    }),
  );
  assertEquals(r.tagsOf("ryph-env-branches", PKG, digest("a")), null);
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("a")), ["env-1"]);
  assertEquals(r.tagsOf("ryph-env-branches", "ryph/repo-cr-other", digest("d")), [], "not ours");
});

test("only Google's own NOT_FOUND is gone; any other 404 is no answer", async () => {
  const empty = fakeRegistry();
  assert(await empty.cleaner.removeBuild(SPEC), "nothing there is gone already");

  const html = fakeRegistry({
    refuse: () => new Response("<html><body>404 Not Found</body></html>", { status: 404 }),
  });
  await assertRejects(() => html.cleaner.removeBuild(SPEC));

  const denied = fakeRegistry({
    refuse: () =>
      new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED" } }), {
        status: 403,
      }),
  });
  await assertRejects(() => denied.cleaner.removeBuild(SPEC));
});

test("a cache prune takes untagged exports retired long enough ago, on every page", async () => {
  const r = fakeRegistry({ pageSize: 2 });
  const old = { created: "2026-10-10T00:00:00Z", updated: "2026-10-11T00:00:00Z" };
  r.put("ryph-envs", "ryph/cache", digest("1"), [], old);
  r.put("ryph-envs", "ryph/cache", digest("2"), [], {
    created: "2026-10-01T00:00:00Z",
    updated: "2026-10-12T11:30:00Z", // retired half an hour ago: a build may still read it
  });
  r.put("ryph-envs", "ryph/cache", digest("3"), ["repo-cr-api-environment"], old);
  r.put("ryph-envs", "ryph/cache", digest("4"), [], old);
  r.put("ryph-envs", "ryph/cache", digest("5"), [], old);
  r.put("ryph-envs", "radicle/cache", digest("6"), [], old);
  await r.cleaner.pruneCache(60 * 60 * 1000);
  assertEquals(r.tagsOf("ryph-envs", "ryph/cache", digest("1")), null);
  assertEquals(r.tagsOf("ryph-envs", "ryph/cache", digest("2")), []);
  assertEquals(r.tagsOf("ryph-envs", "ryph/cache", digest("3")), ["repo-cr-api-environment"]);
  // Deleting while paging would have moved these off the page they were on.
  assertEquals(r.tagsOf("ryph-envs", "ryph/cache", digest("4")), null);
  assertEquals(r.tagsOf("ryph-envs", "ryph/cache", digest("5")), null);
  assertEquals(r.tagsOf("ryph-envs", "radicle/cache", digest("6")), [], "another cell's");
});

test("a reconcile deletes untagged versions nothing names, in this cell's own path alone", async () => {
  const r = fakeRegistry({ pageSize: 2 });
  const old = { created: "2026-10-01T00:00:00Z", updated: "2026-10-05T00:00:00Z" };
  r.put("ryph-envs", PKG, digest("1"), [], old); // an orphan
  r.put("ryph-envs", PKG, digest("2"), [], old); // a live row still names it
  r.put("ryph-envs", PKG, digest("3"), ["env-3"], old); // tagged
  r.put("ryph-envs", PKG, digest("4"), [], { created: "2026-10-12T11:00:00Z" }); // too young
  r.put("ryph-envs", "ryph/cache", digest("5"), [], old); // the cache's own rule
  r.put("ryph-envs", "radicle/repo-cr-api", digest("6"), [], old); // another cell
  r.put("ryph-envs", "ryph/deeper/thing", digest("7"), [], old); // not a subject package
  r.put("ryph-env-branches", PKG, digest("8"), [], old); // a branch orphan
  const asked: string[][] = [];
  await r.cleaner.reconcileImages({
    untaggedForMs: 24 * 60 * 60 * 1000,
    inUse: (digests) => {
      asked.push(digests);
      return Promise.resolve(new Set(digests.filter((d) => d === digest("2"))));
    },
  });
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("1")), null);
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("2")), []);
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("3")), ["env-3"]);
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("4")), []);
  assertEquals(r.tagsOf("ryph-envs", "ryph/cache", digest("5")), []);
  assertEquals(r.tagsOf("ryph-envs", "radicle/repo-cr-api", digest("6")), []);
  assertEquals(r.tagsOf("ryph-envs", "ryph/deeper/thing", digest("7")), []);
  assertEquals(r.tagsOf("ryph-env-branches", PKG, digest("8")), null);
  assertEquals(asked.flat().sort(), [digest("1"), digest("2"), digest("8")].sort());
});

test("a reconcile weighs at most so many versions a package per pass, oldest first", async () => {
  const r = fakeRegistry();
  const hex = (i: number) => `sha256:${i.toString(16).padStart(64, "0")}`;
  for (let i = 0; i < 250; i++) {
    r.put("ryph-envs", PKG, hex(i), [], {
      created: "2026-09-01T00:00:00Z",
      updated: new Date(Date.parse("2026-09-02T00:00:00Z") + i * 1000).toISOString(),
    });
  }
  let asked = 0;
  await r.cleaner.reconcileImages({
    untaggedForMs: 0,
    inUse: (digests) => {
      asked += digests.length;
      return Promise.resolve(new Set());
    },
  });
  assertEquals(asked, 200);
  assertEquals(r.tagsOf("ryph-envs", PKG, hex(0)), null, "the oldest went");
  assertEquals(r.tagsOf("ryph-envs", PKG, hex(249)), [], "the rest wait for the next pass");
});

test("a reconcile spends its budget on deletions, never on what is still in use", async () => {
  const r = fakeRegistry();
  const hex = (i: number) => `sha256:${i.toString(16).padStart(64, "0")}`;
  for (let i = 0; i < 250; i++) {
    r.put("ryph-envs", PKG, hex(i), [], {
      created: "2026-09-01T00:00:00Z",
      updated: new Date(Date.parse("2026-09-02T00:00:00Z") + i * 1000).toISOString(),
    });
  }
  // The oldest 220 are still somebody's: the 30 orphans after them go all the same.
  const inUse = (digests: string[]) =>
    Promise.resolve(new Set(digests.filter((d) => parseInt(d.slice(7), 16) < 220)));
  await r.cleaner.reconcileImages({ untaggedForMs: 0, inUse });
  assertEquals(r.tagsOf("ryph-envs", PKG, hex(219)), []);
  for (const i of [220, 249]) assertEquals(r.tagsOf("ryph-envs", PKG, hex(i)), null);
});

test("a pass that runs out of budget, the next one starts where it stopped", async () => {
  const r = fakeRegistry();
  const hex = (p: number, i: number) => `sha256:${(p * 1000 + i).toString(16).padStart(64, "0")}`;
  const pkgs = ["ryph/repo-cr-a", "ryph/repo-cr-b", "ryph/repo-cr-c"];
  pkgs.forEach((pkg, p) => {
    for (let i = 0; i < 200; i++) {
      r.put("ryph-envs", pkg, hex(p, i), [], { created: "2026-09-01T00:00:00Z" });
    }
  });
  const left = () =>
    pkgs.map((pkg, p) =>
      Array.from({ length: 200 }, (_, i) => r.tagsOf("ryph-envs", pkg, hex(p, i)))
        .filter((t) => t !== null).length
    );
  const none = () => Promise.resolve(new Set<string>());
  await r.cleaner.reconcileImages({ untaggedForMs: 0, inUse: none });
  assertEquals(left(), [0, 0, 100], "500 a pass");
  await r.cleaner.reconcileImages({ untaggedForMs: 0, inUse: none });
  assertEquals(left(), [0, 0, 0], "resumed at the package it stopped in");
});

test("a pass counts a deletion once the registry accepts it, finished or not", async () => {
  const r = fakeRegistry({ op: () => "pending" });
  const old = { created: "2026-10-01T00:00:00Z", updated: "2026-10-02T00:00:00Z" };
  r.put("ryph-envs", "ryph/cache", digest("1"), [], old);
  r.put("ryph-envs", "ryph/cache", digest("2"), [], old);
  r.put("ryph-envs", "ryph/cache", digest("3"), ["repo-cr-api-machine"], old);
  assertEquals(await r.cleaner.pruneCache(0), { candidates: 2, deleteRequested: 2, failures: 0 });
  r.put("ryph-envs", PKG, digest("4"), [], old);
  assertEquals(
    await r.cleaner.reconcileImages({ untaggedForMs: 0, inUse: () => Promise.resolve(new Set()) }),
    { candidates: 1, deleteRequested: 1, failures: 0, packageFailures: 0 },
  );
  assertEquals(r.cleaner.removalStats(), { versionsDeleteRequested: 3 }, "cumulative");
});

test("a package the reconcile cannot read is passed over, and the ones after it are not", async () => {
  const r = fakeRegistry({
    refuse: (method, path) =>
      method === "GET" && path.includes(encodeURIComponent("ryph/repo-cr-a")) &&
        path.endsWith("/versions")
        ? new Response(JSON.stringify({ error: { code: 500, status: "INTERNAL" } }), {
          status: 500,
        })
        : undefined,
  });
  const old = { created: "2026-10-01T00:00:00Z" };
  r.put("ryph-envs", "ryph/repo-cr-a", digest("1"), [], old);
  r.put("ryph-envs", "ryph/repo-cr-b", digest("2"), [], old);
  const summary = await r.cleaner.reconcileImages({
    untaggedForMs: 0,
    inUse: () => Promise.resolve(new Set()),
  });
  const { firstError, ...counts } = summary;
  assertEquals(counts, { candidates: 1, deleteRequested: 1, failures: 0, packageFailures: 1 });
  assertStringIncludes(firstError!, "INTERNAL");
  assertEquals(r.tagsOf("ryph-envs", "ryph/repo-cr-a", digest("1")), []);
  assertEquals(r.tagsOf("ryph-envs", "ryph/repo-cr-b", digest("2")), null);
});

test("a refusal of our own identity ends a prune or a reconcile at once", async () => {
  const denied = () =>
    new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED" } }), {
      status: 403,
    });
  const old = { created: "2026-10-01T00:00:00Z" };
  const prune = fakeRegistry({
    refuse: (method, path) =>
      method === "DELETE" && path.includes("/versions/") ? denied() : undefined,
  });
  for (const c of ["1", "2", "3"]) prune.put("ryph-envs", "ryph/cache", digest(c), [], old);
  await assertRejects(() => prune.cleaner.pruneCache(0), Error, "PERMISSION_DENIED");
  assertEquals(prune.requests.filter((q) => q.method === "DELETE").length, 1, "asked once");

  const reconcile = fakeRegistry({
    refuse: (method, path) => method === "GET" && path.endsWith("/versions") ? denied() : undefined,
  });
  reconcile.put("ryph-envs", "ryph/repo-cr-a", digest("1"), [], old);
  reconcile.put("ryph-envs", "ryph/repo-cr-b", digest("2"), [], old);
  await assertRejects(
    () =>
      reconcile.cleaner.reconcileImages({
        untaggedForMs: 0,
        inUse: () => Promise.resolve(new Set()),
      }),
    Error,
    "PERMISSION_DENIED",
  );
  assertEquals(
    reconcile.requests.filter((q) => q.path.split("?")[0].endsWith("/versions")).length,
    1,
    "not one refusal per package",
  );
});

test("the reconcile's age gate is the later of a version's creation and its last change", async () => {
  const r = fakeRegistry();
  // Pushed just now and untagged at once (an in-flight build's push no row records yet): its
  // creation alone holds it, whatever its `updateTime` says.
  r.put("ryph-envs", PKG, digest("1"), [], {
    created: "2026-10-12T11:50:00Z",
    updated: "2026-01-01T00:00:00Z",
  });
  await r.cleaner.reconcileImages({
    untaggedForMs: 60 * 60 * 1000,
    inUse: () => Promise.resolve(new Set()),
  });
  assertEquals(r.tagsOf("ryph-envs", PKG, digest("1")), []);
});

test("a reconcile refuses a bare repository, which another deployment may share", async () => {
  const r = fakeRegistry({
    cleaner: {
      registry: "us-central1-docker.pkg.dev/acme-dev/ryph-envs",
      branchRegistry: "us-central1-docker.pkg.dev/acme-dev/ryph-env-branches",
    },
  });
  r.put("ryph-envs", "repo-cr-api", digest("1"), [], { created: "2026-01-01T00:00:00Z" });
  await r.cleaner.reconcileImages({ untaggedForMs: 0, inUse: () => Promise.resolve(new Set()) });
  await r.cleaner.pruneCache(0);
  assertEquals(r.requests, [], "nor its cache pruned");
  assertEquals(r.tagsOf("ryph-envs", "repo-cr-api", digest("1")), []);
});

test("the registry builders remove images only where the registry is Artifact Registry", () => {
  const diag = silentDiagnostics();
  const cloud = (registry: string) =>
    cloudBuildEnvironmentBuilder(
      {
        pool: "projects/acme-dev/locations/us-central1/workerPools/ryph-builds",
        logsBucket: "logs",
        branchLogsBucket: "branch-logs",
        serviceAccount: "b@acme-dev.iam.gserviceaccount.com",
        branchServiceAccount: "bb@acme-dev.iam.gserviceaccount.com",
        registry,
        branchRegistry: BRANCH_REGISTRY,
        buildkitImage: "moby/buildkit",
        disk: null,
      },
      diag,
      { token: () => Promise.resolve("t") },
    );
  assert(cloud(REGISTRY).removeImages !== undefined);
  assert(cloud(REGISTRY).pruneCache !== undefined);
  assert(cloud(REGISTRY).reconcileImages !== undefined);
  assertEquals(cloud("registry.local:5000/envs").removeImages, undefined);

  const kube = (registryAuth: "gke-metadata" | "none") =>
    kubernetesEnvironmentBuilder({
      apiUrl: "https://kube.test",
      tokenFile: null,
      caFile: null,
      namespace: "ryph-builds",
      serviceAccount: "ryph-builder",
      branchServiceAccount: "ryph-branch-builder",
      runtimeClass: "gvisor",
      registry: REGISTRY,
      branchRegistry: BRANCH_REGISTRY,
      buildkitImage: "moby/buildkit:rootless",
      size: { ...UNSIZED, name: "build" },
      registryAuth,
    }, diag);
  assert(kube("gke-metadata").removeImages !== undefined);
  // An open registry: deleting a manifest there frees nothing until its own GC runs.
  assertEquals(kube("none").removeImages, undefined);
  assertEquals(kube("none").reconcileImages, undefined);
});
