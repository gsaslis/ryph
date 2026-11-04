// gateCoverage: the addresses a caller hands confined runs, held against the routes the docker
// launcher's run gate relays. The launcher owns the gate and the caller owns the addresses, so
// this comparison is the only place a mismatch can be said before a run fails to call home.

import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { gateCoverage, launcherCallerRefusal } from "../src/adapters/launcher/mod.ts";
import { everyBuildRefused } from "../src/adapters/environment_builder/mod.ts";

const info = {
  gate: "ryph-gate-ryph",
  routes: [
    { listen: 7411, target: "control-plane", port: 7411 },
    { listen: 7460, target: "egress-proxy", port: 7460 },
  ],
};

test("an unconfined launcher has no gate to fall short of", () => {
  assertEquals(
    gateCoverage({ gate: null, routes: null }, [{ setting: "A", url: "http://x:1" }]),
    { elsewhere: [], unrouted: [] },
  );
});

test("addresses on the gate's routes pass; unset ones are not handed to runs", () => {
  assertEquals(
    gateCoverage(info, [
      { setting: "RYPH_PUBLIC_URL", url: "http://ryph-gate-ryph:7411" },
      { setting: "RYPH_EGRESS_PROXY_URL", url: "http://ryph-gate-ryph:7460" },
      { setting: "RYPH_HISTORY_URL", url: null },
    ]),
    { elsewhere: [], unrouted: [] },
  );
});

test("another host is elsewhere, the gate on an unrelayed port is unrouted", () => {
  assertEquals(
    gateCoverage(info, [
      { setting: "RYPH_GIT_GATEWAY_URL", url: "http://forge:7412" },
      { setting: "RYPH_HISTORY_URL", url: "http://ryph-gate-ryph:7413" },
      // No port is the scheme's own, which the gate does not relay either.
      { setting: "RYPH_PREVIEWS_URL", url: "http://ryph-gate-ryph" },
    ]),
    {
      elsewhere: ["RYPH_GIT_GATEWAY_URL=http://forge:7412"],
      unrouted: [
        "RYPH_HISTORY_URL=http://ryph-gate-ryph:7413",
        "RYPH_PREVIEWS_URL=http://ryph-gate-ryph",
      ],
    },
  );
});

test("a caller of a launcher elsewhere refuses the launcher's own settings, and what it does not serve", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  const url = "http://launcher:7470";
  const none = { checks: false, builds: false, builder: "docker" };
  assertEquals(launcherCallerRefusal(env({}), url, null, none), null);
  for (
    const name of ["RYPH_DOCKER_RUNTIME", "RYPH_IMAGE_PREFETCH", "RYPH_ENV_TRUST_DEFAULT_BRANCH"]
  ) {
    const refusal = launcherCallerRefusal(env({ [name]: "x" }), url, null, none);
    assertEquals(refusal?.includes(`configuration ${name} is`), true, name);
  }
  const serves = { checks: true, builds: false, buildsRefused: null, runNetwork: null };
  assertEquals(
    launcherCallerRefusal(env({}), url, serves, { checks: true, builds: false, builder: "docker" }),
    null,
  );
  assertEquals(
    launcherCallerRefusal(env({}), url, serves, { checks: true, builds: true, builder: "docker" })
      ?.includes(
        "runs no builds",
      ),
    true,
  );
  assertEquals(
    launcherCallerRefusal(env({}), url, { ...serves, checks: false, builds: true }, {
      checks: true,
      builds: false,
      builder: "docker",
    })?.includes("runs no check suites"),
    true,
  );
});

test("a caller with builds on refuses a launcher that refuses every build", () => {
  const url = "http://launcher:7470";
  const refused = (runtime: string | undefined, trustDefaultBranch: boolean) =>
    everyBuildRefused({ runtime, runNetwork: "ryph-runs", trustDefaultBranch, soleTenant: false });
  const why = refused("runsc", false);
  assertStringIncludes(why!, "RYPH_DOCKER_RUNTIME=runsc");
  assertStringIncludes(why!, "RYPH_ENV_TRUST_DEFAULT_BRANCH");
  // Trusted, or runc by any name, or no runtime: some builds go through.
  assertEquals(refused("runsc", true), null);
  for (const runtime of [undefined, "runc", "io.containerd.runc.v2", " "]) {
    assertEquals(refused(runtime, false), null, runtime);
  }
  // Unconfined, a launcher that is not the daemon's one tenant builds nothing; the binary's does.
  const unconfined = (soleTenant: boolean) =>
    everyBuildRefused({
      runtime: undefined,
      runNetwork: undefined,
      trustDefaultBranch: true,
      soleTenant,
    });
  assertStringIncludes(unconfined(false)!, "RYPH_DOCKER_RUN_NETWORK");
  assertEquals(unconfined(true), null);
  const refusing = { checks: true, builds: true, buildsRefused: why, runNetwork: null };
  const refusal = launcherCallerRefusal(() => undefined, url, refusing, {
    checks: true,
    builds: true,
    builder: "docker",
  });
  assertStringIncludes(refusal!, "refuses every build");
  assertStringIncludes(refusal!, "RYPH_ENV_TRUST_DEFAULT_BRANCH=on");
  assertStringIncludes(refusal!, "RYPH_DOCKER_RUNTIME");
  // Builds off here: nothing to refuse.
  assertEquals(
    launcherCallerRefusal(() => undefined, url, refusing, {
      checks: true,
      builds: false,
      builder: "docker",
    }),
    null,
  );
});

test("a caller with builds on keeps no build proxy of its own where the launcher confines builds", () => {
  const url = "http://launcher:7470";
  const proxy = (name: string) =>
    name === "RYPH_ENV_EGRESS_PROXY_URL" ? "http://egress-proxy:7460" : undefined;
  const builds = { checks: false, builds: true, builder: "docker" };
  const confined = { checks: true, builds: true, buildsRefused: null, runNetwork: "ryph-run" };
  assertStringIncludes(launcherCallerRefusal(proxy, url, confined, builds)!, "Unset it");
  // Unconfined builds dial it; builds off never send it; unset, nothing to refuse.
  assertEquals(launcherCallerRefusal(proxy, url, { ...confined, runNetwork: null }, builds), null);
  assertEquals(
    launcherCallerRefusal(proxy, url, confined, { checks: true, builds: false, builder: "docker" }),
    null,
  );
  assertEquals(launcherCallerRefusal(() => undefined, url, confined, builds), null);
});

test("the tool side of the launcher's own settings is the gateway's list, held once", async () => {
  const { LAUNCHER_OWNED_SETTINGS } = await import("../src/adapters/launcher/mod.ts");
  const { LAUNCHER_OWNED_TOOL_SETTINGS } = await import("@ryph/mcp-gateway/tool-host");
  for (const name of LAUNCHER_OWNED_TOOL_SETTINGS) {
    assertEquals(LAUNCHER_OWNED_SETTINGS.filter((n) => n === name).length, 1, name);
  }
});

test("the docker builder's knobs are the launcher's only where the builder is docker", () => {
  const url = "http://launcher:7470";
  const off = { checks: false, builds: false, builder: "docker" };
  for (
    const name of [
      "RYPH_ENV_BUILDKIT_IMAGE",
      "RYPH_ENV_CACHE_DIR",
      "RYPH_ENV_TEMP_DIR",
      "RYPH_ENV_BUILD_PLATFORM",
      "RYPH_ENV_IMAGE_REMOVAL",
    ]
  ) {
    const set = (n: string) => (n === name ? "x" : undefined);
    // Beside the docker builder (named or defaulted), the launcher's: refused here.
    assertStringIncludes(launcherCallerRefusal(set, url, null, off)!, name);
    assertStringIncludes(
      launcherCallerRefusal(set, url, null, { ...off, builder: "docker" })!,
      name,
    );
    // The kubernetes and cloud-build builders run here and read it themselves, before the
    // launcher answers and after: the check after connecting must not undo the first.
    const answered = { checks: true, builds: true, buildsRefused: null, runNetwork: "runs" };
    for (const builder of ["kubernetes", "cloud-build"]) {
      assertEquals(launcherCallerRefusal(set, url, null, { ...off, builder }), null, builder);
      assertEquals(
        launcherCallerRefusal(set, url, answered, { checks: true, builds: false, builder }),
        null,
        builder,
      );
    }
  }
  // The launcher's networks stay its own whatever builds here.
  const network = (n: string) => (n === "RYPH_DOCKER_RUN_NETWORK" ? "x" : undefined);
  assertStringIncludes(
    launcherCallerRefusal(network, url, null, { ...off, builder: "kubernetes" })!,
    "RYPH_DOCKER_RUN_NETWORK",
  );
});
