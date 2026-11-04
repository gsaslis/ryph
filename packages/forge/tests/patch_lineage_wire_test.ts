// A newborn patch's lineage question across the REAL wire: the orchestrator's `httpForge` → an
// actual HTTP request → this package's route and its strict request schema → real git bundles.
//
// It exists because the orchestrator passed its whole patch row as the bundle, and the route's
// schema refuses unknown fields: every real question was a 400, read as "no answer", and every
// newborn was held as unconfirmed. The orchestrator's suites fake the `Forge` port above the
// wire and patch_lineage_test.ts calls the route directly, so neither could see the mismatch.
// Cross-package by design, like permission_wire_test.ts.

import { test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals } from "@std/assert";
import { serve } from "@ryph/service";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { type ForgeApi, providerRegistry } from "../src/ports/forge_api.ts";
import { git } from "../src/helpers/git_exec.ts";
import { httpForge } from "../../orchestrator/src/adapters/forge/http.ts";
import { commit, makeUpstream, silentDiagnostics } from "./util.ts";

const SERVICE_TOKEN = "service-secret";
const REPO = "cr-1";

test("a lineage question built from whole patch rows is answered across the real wire", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const diag = silentDiagnostics();
  const upstream = `${root}/upstream`;
  await makeUpstream(upstream, "patch-lineage-wire");
  const stagingDir = `${root}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const never = () => Promise.reject(new Error("not part of this surface"));
  const deps: AppDeps = {
    keys: { resolve: () => Promise.resolve(null) },
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: providerRegistry({
      github: {
        upstreamUrl: (_repo: unknown, url: string) => url,
        fetchAuth: () => Promise.resolve(null),
      } as unknown as ForgeApi,
    }, "forge API"),
    transports: providerRegistry({ github: { deliver: never } }, "change transport"),
    serviceToken: SERVICE_TOKEN,
    config: { maxUploadPackBytes: 10 * 1024 * 1024, maxBundleBytes: 1024 * 1024, stagingDir },
  };
  const service = await serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    makeHandler(deps),
  );

  try {
    const work = `${root}/work`;
    await mkdir(work);
    await git(work, "clone", "--quiet", "--", upstream, ".");
    const base = await git(work, "rev-parse", "HEAD");

    /** A line's branch with one commit, bundled from the run's base and filed as intake files
     * it; answers a patch row as the orchestrator holds one — more than the bundle's names. */
    const row = async (name: string, from: string) => {
      const branchName = `ryph/run-1/${name}`;
      await git(work, "checkout", "--quiet", "-B", branchName, from);
      await writeFile(`${work}/${name}.md`, `${name}\n`);
      await git(work, "add", ".");
      await commit(work, `add ${name}`);
      const headSha = await git(work, "rev-parse", "HEAD");
      const path = `${root}/${name}.bundle`;
      await git(work, "bundle", "create", path, `${base}..refs/heads/${branchName}`);
      const bundleKey = `run-1/${name}/${REPO}/${headSha}.bundle`;
      await deps.patches.put(bundleKey, path);
      return {
        bundleKey,
        branchName,
        headSha,
        runId: "run-1",
        line: name,
        generation: 1,
        title: `the ${name} line`,
      };
    };

    const a = await row("a", base);
    const b = await row("b", base);
    const forge = httpForge({
      baseUrl: `http://127.0.0.1:${service.addr.port}`,
      forgeToken: SERVICE_TOKEN,
      diag,
    });
    const repo = { provider: "github", repoRef: "acme/app", tenantId: "42" } as const;

    // Disjoint lines: answered, and nothing in common.
    assertEquals(
      await forge.patchLineage(repo, upstream, {
        connectedRepoId: REPO,
        targetRef: "main",
        patch: b,
        others: [a],
        mustHold: base,
      }),
      { kind: "answered", overlaps: [], holdsTip: true },
    );
  } finally {
    await service.shutdown();
    await rm(root, { recursive: true });
  }
});
