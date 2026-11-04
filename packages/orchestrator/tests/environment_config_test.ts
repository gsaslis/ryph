// The environments configuration, read at boot: harness kinds, the RYPH_ENV_* family, and the
// refusals a deployment that claims environments without the inputs to build one gets.

import { test } from "bun:test";
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  DEFAULT_ENVIRONMENTS_CONFIG,
  environmentsConfigFromEnv,
  harnessKindsFromEnv,
  parseDuration,
} from "../src/core/environment_config.ts";

const failing = (message: string): never => {
  throw new Error(message);
};
const envOf = (vars: Record<string, string>) => (name: string) => vars[name];

test("harness kinds default to pi and echo, and are validated when set", () => {
  assertEquals(harnessKindsFromEnv(envOf({}), failing), ["pi", "echo"]);
  assertEquals(
    harnessKindsFromEnv(envOf({ RYPH_HARNESS_KINDS: " pi , claude-code " }), failing),
    ["pi", "claude-code"],
  );
  for (const bad of ["", " , ", "Pi", "pi,pi", "-pi"]) {
    const err = assertThrows(
      () => harnessKindsFromEnv(envOf({ RYPH_HARNESS_KINDS: bad }), failing),
      Error,
    );
    assertStringIncludes(err.message, "RYPH_HARNESS_KINDS", bad);
  }
});

test("off by default, with the documented defaults, and the builder following the provisioner", () => {
  const config = environmentsConfigFromEnv(envOf({}), failing, "kubernetes");
  assertEquals(config, { ...DEFAULT_ENVIRONMENTS_CONFIG, builder: "kubernetes" });
  assertEquals(config.enabled, false);
  assertEquals(config.rebuildIntervalMs, 6 * 60 * 60 * 1000);
  assertEquals(config.buildConcurrency, 2);
  assertEquals(config.buildTimeoutMs, 60 * 60 * 1000);
  // Every provisioner has an answer: manual narrates and refuses builds, but it exists.
  for (const kind of ["docker", "manual"] as const) {
    assertEquals(environmentsConfigFromEnv(envOf({}), failing, kind).builder, kind);
  }
});

test("an operator names a builder, but only one that can build", () => {
  assertEquals(
    environmentsConfigFromEnv(envOf({ RYPH_ENV_BUILDER: "docker" }), failing, "kubernetes")
      .builder,
    "docker",
  );
  for (const bad of ["manual", "buildkite"]) {
    assertThrows(
      () => environmentsConfigFromEnv(envOf({ RYPH_ENV_BUILDER: bad }), failing, "docker"),
      Error,
      "RYPH_ENV_BUILDER",
    );
  }
});

test("on, with everything a build needs, reads every knob", () => {
  const config = environmentsConfigFromEnv(
    envOf({
      RYPH_ENVIRONMENTS: "on",
      RYPH_HARNESS_IMAGE: `registry.example/ryph-harness@sha256:${"a".repeat(64)}`,
      RYPH_ENV_BASE_IMAGE: `registry.example/ryph-universal@sha256:${"b".repeat(64)}`,
      RYPH_ENV_REGISTRY: "europe-docker.pkg.dev/acme-dev/ryph-envs/",
      RYPH_ENV_BRANCH_REGISTRY: "europe-docker.pkg.dev/acme-dev/ryph-env-branches/",
      RYPH_ENV_REBUILD_INTERVAL: "90m",
      RYPH_ENV_BUILD_CONCURRENCY: "4",
      RYPH_ENV_BUILD_TIMEOUT: "2h",
    }),
    failing,
    "kubernetes",
  );
  assertEquals(config, {
    enabled: true,
    builder: "kubernetes",
    harnessImage: `registry.example/ryph-harness@sha256:${"a".repeat(64)}`,
    baseImage: `registry.example/ryph-universal@sha256:${"b".repeat(64)}`,
    registry: "europe-docker.pkg.dev/acme-dev/ryph-envs",
    branchRegistry: "europe-docker.pkg.dev/acme-dev/ryph-env-branches",
    rebuildIntervalMs: 90 * 60 * 1000,
    buildConcurrency: 4,
    buildTimeoutMs: 2 * 60 * 60 * 1000,
    buildGatewayUrl: null,
    buildProxyUrl: null,
    warmChain: 4,
  });
});

test("a docker build clones on this machine, so it dials the forge as this process does", () => {
  const forge = { RYPH_FORGE_URL: "http://localhost:7412/" };
  // The kubernetes clone runs in a pod, like a run: the run's gateway address is right.
  assertEquals(
    environmentsConfigFromEnv(envOf(forge), failing, "kubernetes").buildGatewayUrl,
    null,
  );
  assertEquals(
    environmentsConfigFromEnv(envOf(forge), failing, "docker").buildGatewayUrl,
    "http://localhost:7412",
  );
  // The noop forge is not an address, and an explicit one wins over the derived one.
  assertEquals(
    environmentsConfigFromEnv(envOf({ RYPH_FORGE_URL: "noop" }), failing, "docker")
      .buildGatewayUrl,
    null,
  );
  assertEquals(
    environmentsConfigFromEnv(
      envOf({ ...forge, RYPH_ENV_GIT_GATEWAY_URL: "http://forge.internal:7412/" }),
      failing,
      "kubernetes",
    ).buildGatewayUrl,
    "http://forge.internal:7412",
  );
});

test("on, without the inputs a build cannot start without, is refused at boot by name", () => {
  const on = {
    RYPH_ENVIRONMENTS: "on",
    RYPH_HARNESS_IMAGE: "h@sha256:aa",
    RYPH_ENV_BASE_IMAGE: "b@sha256:bb",
  };
  // docker keeps the image in its local store, so it needs no registry.
  assertEquals(environmentsConfigFromEnv(envOf(on), failing, "docker").enabled, true);
  const missing: Array<[Record<string, string>, string, string]> = [
    [{ ...on, RYPH_HARNESS_IMAGE: "" }, "docker", "RYPH_HARNESS_IMAGE"],
    [{ ...on, RYPH_ENV_BASE_IMAGE: "" }, "docker", "RYPH_ENV_BASE_IMAGE"],
    [on, "kubernetes", "RYPH_ENV_REGISTRY"],
  ];
  for (const [vars, provisioner, named] of missing) {
    assertThrows(
      () => environmentsConfigFromEnv(envOf(vars), failing, provisioner),
      Error,
      named,
    );
  }
});

test("the kubernetes builder takes its harness and base only by digest", () => {
  const pinned = (name: string) => `europe-docker.pkg.dev/p/ryph/${name}@sha256:${"c".repeat(64)}`;
  const on = {
    RYPH_ENVIRONMENTS: "on",
    RYPH_HARNESS_IMAGE: pinned("ryph-harness"),
    RYPH_ENV_BASE_IMAGE: pinned("ryph-universal"),
    RYPH_ENV_REGISTRY: "europe-docker.pkg.dev/p/ryph-envs/ryph",
  };
  assertEquals(environmentsConfigFromEnv(envOf(on), failing, "kubernetes").enabled, true);
  // A tag is what a re-push moves without either comparison noticing.
  for (
    const [name, tagged] of [
      ["RYPH_HARNESS_IMAGE", "europe-docker.pkg.dev/p/ryph/ryph-harness:3f2a1bc"],
      ["RYPH_ENV_BASE_IMAGE", "europe-docker.pkg.dev/p/ryph/ryph-universal:3f2a1bc"],
    ]
  ) {
    const err = assertThrows(
      () => environmentsConfigFromEnv(envOf({ ...on, [name]: tagged }), failing, "kubernetes"),
      Error,
    );
    assertStringIncludes(err.message, name);
    assertStringIncludes(err.message, "digest");
  }
  // The docker builder's inputs are local images, which a tag names.
  assertEquals(
    environmentsConfigFromEnv(
      envOf({ ...on, RYPH_HARNESS_IMAGE: "ryph-harness:dev", RYPH_ENV_BASE_IMAGE: "u:dev" }),
      failing,
      "docker",
    ).enabled,
    true,
  );
});

test("cloud-build is named, not derived, and needs the addresses a worker outside the cluster dials", () => {
  const pinned = (name: string) => `europe-docker.pkg.dev/p/ryph/${name}@sha256:${"c".repeat(64)}`;
  const on = {
    RYPH_ENVIRONMENTS: "on",
    RYPH_ENV_BUILDER: "cloud-build",
    RYPH_HARNESS_IMAGE: pinned("ryph-harness"),
    RYPH_ENV_BASE_IMAGE: pinned("ryph-universal"),
    RYPH_ENV_REGISTRY: "europe-docker.pkg.dev/p/ryph-envs/ryph",
    RYPH_ENV_GIT_GATEWAY_URL: "http://10.10.0.40:7412/",
    RYPH_ENV_EGRESS_PROXY_URL: "http://10.10.0.41:7460/",
  };
  const config = environmentsConfigFromEnv(envOf(on), failing, "kubernetes");
  assertEquals(config.builder, "cloud-build");
  assertEquals(config.buildGatewayUrl, "http://10.10.0.40:7412");
  assertEquals(config.buildProxyUrl, "http://10.10.0.41:7460");
  for (
    const name of ["RYPH_ENV_REGISTRY", "RYPH_ENV_GIT_GATEWAY_URL", "RYPH_ENV_EGRESS_PROXY_URL"]
  ) {
    assertThrows(
      () => environmentsConfigFromEnv(envOf({ ...on, [name]: "" }), failing, "kubernetes"),
      Error,
      name,
    );
  }
  assertThrows(
    () =>
      environmentsConfigFromEnv(
        envOf({ ...on, RYPH_ENV_BASE_IMAGE: "europe-docker.pkg.dev/p/ryph/u:tag" }),
        failing,
        "kubernetes",
      ),
    Error,
    "digest",
  );
});

test("RYPH_ENV_WARM_CHAIN is a whole number, and 0 turns incremental builds off", () => {
  assertEquals(environmentsConfigFromEnv(envOf({}), failing, "docker").warmChain, 4);
  assertEquals(
    environmentsConfigFromEnv(envOf({ RYPH_ENV_WARM_CHAIN: "0" }), failing, "docker").warmChain,
    0,
  );
  for (const bad of ["-1", "2.5", "lots"]) {
    assertThrows(
      () => environmentsConfigFromEnv(envOf({ RYPH_ENV_WARM_CHAIN: bad }), failing, "docker"),
      Error,
      "RYPH_ENV_WARM_CHAIN",
    );
  }
});

test("switches and numbers are spelled one way, and a wrong one fails naming the variable", () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ RYPH_ENVIRONMENTS: "yes" }, "RYPH_ENVIRONMENTS"],
    [{ RYPH_ENV_BUILD_CONCURRENCY: "0" }, "RYPH_ENV_BUILD_CONCURRENCY"],
    [{ RYPH_ENV_BUILD_CONCURRENCY: "two" }, "RYPH_ENV_BUILD_CONCURRENCY"],
    [{ RYPH_ENV_BUILD_TIMEOUT: "60" }, "RYPH_ENV_BUILD_TIMEOUT"],
    [{ RYPH_ENV_REBUILD_INTERVAL: "6 hours" }, "RYPH_ENV_REBUILD_INTERVAL"],
  ];
  for (const [vars, named] of cases) {
    assertThrows(() => environmentsConfigFromEnv(envOf(vars), failing, "docker"), Error, named);
  }
});

test("durations carry their unit, because a bare number means something different to everyone", () => {
  assertEquals(parseDuration("90s"), 90_000);
  assertEquals(parseDuration("60m"), 3_600_000);
  assertEquals(parseDuration("6h"), 21_600_000);
  assertEquals(parseDuration("1d"), 86_400_000);
  assertEquals(parseDuration("250ms"), 250);
  for (const bad of ["60", "0m", "1.5h", "h", "-1m"]) assertEquals(parseDuration(bad), null, bad);
});
