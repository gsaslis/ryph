// The standalone launcher's configuration: what it reads, and what it refuses to boot with.

import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launcherConfigFromEnv,
  prefetchImages,
  prefetchOn,
  withTokenFiles,
} from "../src/config.ts";
import { launcherTokenFromEnv } from "@ryph/orchestrator/docker";

/** The launcher's configuration from `vars`, on a deployment network unless they name another. */
const read = (vars: Record<string, string>, network: string | null = "ryph-test") =>
  launcherConfigFromEnv(
    (
      name,
    ) => (name === "RYPH_DOCKER_NETWORK" && network !== null ? vars[name] ?? network : vars[name]),
    (message) => {
      throw new Error(message);
    },
  );

test("a bare launcher runs unconfined, hosts nothing, and builds nothing", () => {
  const config = read({ RYPH_LAUNCHER_TOKEN: "t" });
  assertEquals(config.port, 7470);
  // Each check held to half of what the daemon has, read once a suite launches.
  assertEquals(config.docker, {
    network: "ryph-test",
    checkCaps: { cpus: "auto", memoryMi: "auto" },
  });
  assertEquals([config.tools, config.environments, config.checks], [null, null, false]);
  assertEquals(config.prefetch, []);
});

test("RYPH_CHECKS_CPUS and RYPH_CHECKS_MEMORY cap each check, or nothing", () => {
  const config = read({
    RYPH_LAUNCHER_TOKEN: "t",
    RYPH_CHECKS_CPUS: "3",
    RYPH_CHECKS_MEMORY: "off",
  });
  assertEquals(config.docker.checkCaps, { cpus: 3, memoryMi: null });
  assertThrows(
    () => read({ RYPH_LAUNCHER_TOKEN: "t", RYPH_CHECKS_CPUS: "many" }),
    Error,
    "RYPH_CHECKS_CPUS",
  );
});

/** What every hosting launcher is told: the guard's image, and where its relay goes. */
const HOSTING = {
  RYPH_LAUNCHER_TOKEN: "t",
  RYPH_LAUNCHER_TOOLS_TOKEN: "u",
  RYPH_TOOL_GUARD_IMAGE: "quay.io/ryph/ryph-tool-guard:edge",
  RYPH_TOOL_EGRESS_TARGET: "egress-proxy:7461",
  RYPH_DOCKER_GATE_IMAGE: "quay.io/ryph/ryph-run-gate:edge",
};

test("a tools token turns hosting on: joined, the guard on the deployment network, a relay out", () => {
  const config = read({ ...HOSTING, RYPH_TOOL_NETWORK: "ryph-compose-tools" });
  assertEquals(config.tools, {
    network: "ryph-compose-tools",
    joined: true,
    edge: "ryph-test",
    guardImage: "quay.io/ryph/ryph-tool-guard:edge",
    egress: { image: "quay.io/ryph/ryph-run-gate:edge", target: "egress-proxy", port: 7461 },
  });
  // The relay runs the run gate's image, fetched ahead with the guard's.
  assertEquals(config.prefetch, [
    { name: "run-gate", image: "quay.io/ryph/ryph-run-gate:edge" },
    { name: "tool-guard", image: "quay.io/ryph/ryph-tool-guard:edge" },
  ]);
});

test("a launcher's tools network defaults to its deployment's own, never the binary's", () => {
  const config = read(HOSTING, "ryph");
  // The networked stack's spelling, which it also sets outright.
  assertEquals(config.tools?.network, "ryph-tools-ryph");
  assertEquals(config.tools?.edge, "ryph");
});

test("hosting names its guard's image and its way out, or refuses to boot", () => {
  const without = (name: string) =>
    Object.fromEntries(Object.entries(HOSTING).filter(([n]) => n !== name));
  assertThrows(() => read(without("RYPH_TOOL_GUARD_IMAGE")), Error, "RYPH_TOOL_GUARD_IMAGE");
  assertThrows(() => read(without("RYPH_TOOL_EGRESS_TARGET")), Error, "RYPH_TOOL_EGRESS_TARGET");
  // The relay is the run gate's image, so it needs that image even with runs unconfined.
  assertThrows(() => read(without("RYPH_DOCKER_GATE_IMAGE")), Error, "RYPH_DOCKER_GATE_IMAGE");
  for (const target of ["egress-proxy", "egress-proxy:0", "-x:7461", "a:b:7461", "on"]) {
    assertThrows(
      () => read({ ...HOSTING, RYPH_TOOL_EGRESS_TARGET: target }),
      Error,
      "<host>:<port> or off",
      target,
    );
  }
  // `off`: hosted servers with no way out at all, and no relay image needed.
  const off = read({ ...without("RYPH_DOCKER_GATE_IMAGE"), RYPH_TOOL_EGRESS_TARGET: "off" });
  assertEquals(off.tools?.egress, null);
  // And no egress target where nothing is hosted.
  assertThrows(
    () => read({ RYPH_LAUNCHER_TOKEN: "t", RYPH_TOOL_EGRESS_TARGET: "egress-proxy:7461" }),
    Error,
    "RYPH_LAUNCHER_TOOLS_TOKEN",
  );
});

test("a run network brings its gate, from the launcher's own environment", () => {
  const home = mkdtempSync(join(tmpdir(), "launcher-home-"));
  try {
    const vars = {
      HOME: home,
      RYPH_LAUNCHER_TOKEN: "t",
      RYPH_DOCKER_NETWORK: "ryph-compose",
      RYPH_DOCKER_RUN_NETWORK: "ryph-compose-runs",
      RYPH_DOCKER_GATE_IMAGE: "quay.io/ryph/ryph-run-gate:edge",
      RYPH_DOCKER_GATE_ROUTES: "7411=ryph:7411, 7420=model-proxy:7420",
    };
    const config = read(vars);
    const owner = config.docker.gate!.owner!;
    assertEquals(config.docker.gate, {
      image: "quay.io/ryph/ryph-run-gate:edge",
      routes: [
        { listen: 7411, target: "ryph", port: 7411 },
        { listen: 7420, target: "model-proxy", port: 7420 },
      ],
      owner,
    });
    // An owner of its own, minted into its home and kept: the same on the next boot, and the
    // same under another deployment network, so a renamed deployment still knows its gate.
    assertEquals(/^launcher-[0-9a-f]{16}$/.test(owner), true);
    assertEquals(readFileSync(join(home, "gate-owner"), "utf8").trim(), owner.slice(9));
    assertEquals(read({ ...vars, RYPH_DOCKER_NETWORK: "renamed" }).docker.gate!.owner, owner);
    assertEquals(read({ ...vars, RYPH_DOCKER_GATE_OWNER: "named" }).docker.gate!.owner, "named");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("under a sandboxed runtime it trusts a build's branch only when told to", () => {
  assertEquals(read({ RYPH_LAUNCHER_TOKEN: "t" }).trustDefaultBranch, false);
  assertEquals(
    read({ RYPH_LAUNCHER_TOKEN: "t", RYPH_ENV_TRUST_DEFAULT_BRANCH: "on" }).trustDefaultBranch,
    true,
  );
});

test("it refuses to boot without its token, with one token twice, or with half a gate", () => {
  assertThrows(() => read({}), Error, "RYPH_LAUNCHER_TOKEN");
  // Without a deployment network it would take the binary's "default" identity on a shared daemon.
  assertThrows(() => read({ RYPH_LAUNCHER_TOKEN: "t" }, null), Error, "RYPH_DOCKER_NETWORK");
  assertThrows(
    () => read({ RYPH_LAUNCHER_TOKEN: "t", RYPH_LAUNCHER_TOOLS_TOKEN: "t" }),
    Error,
    "must differ",
  );
  assertThrows(
    () => read({ RYPH_LAUNCHER_TOKEN: "t", RYPH_DOCKER_RUN_NETWORK: "runs" }),
    Error,
    "RYPH_DOCKER_GATE_IMAGE",
  );
  assertThrows(
    () =>
      read({
        RYPH_LAUNCHER_TOKEN: "t",
        RYPH_DOCKER_GATE_OWNER: "o",
        RYPH_DOCKER_RUN_NETWORK: "runs",
        RYPH_DOCKER_GATE_IMAGE: "gate",
        RYPH_DOCKER_GATE_ROUTES: "7411=ryph:7411,7411=other:7411",
      }),
    Error,
    "twice",
  );
  assertThrows(
    () =>
      read({
        RYPH_LAUNCHER_TOKEN: "t",
        RYPH_DOCKER_GATE_OWNER: "o",
        RYPH_DOCKER_RUN_NETWORK: "runs",
        RYPH_DOCKER_GATE_IMAGE: "gate",
        RYPH_DOCKER_GATE_ROUTES: "7411",
      }),
    Error,
    "<listen>=<host>:<port>",
  );
  assertThrows(
    () => read({ RYPH_LAUNCHER_TOKEN: "t", RYPH_CHECKS: "yes" }),
    Error,
    '"on" or "off"',
  );
  // The binary's one-target gate setting, which a standalone launcher would silently ignore.
  assertThrows(
    () =>
      read({
        RYPH_LAUNCHER_TOKEN: "t",
        RYPH_DOCKER_GATE_OWNER: "o",
        RYPH_DOCKER_RUN_NETWORK: "runs",
        RYPH_DOCKER_GATE_IMAGE: "gate",
        RYPH_DOCKER_GATE_ROUTES: "7411=ryph:7411",
        RYPH_DOCKER_GATE_TARGET: "ryph",
      }),
    Error,
    "RYPH_DOCKER_GATE_ROUTES",
  );
});

test("token files are minted once, read after, and read the same by the caller", () => {
  const dir = mkdtempSync(join(tmpdir(), "launcher-tokens-"));
  try {
    const vars: Record<string, string> = {
      RYPH_LAUNCHER_TOKEN_FILE: join(dir, "token"),
      RYPH_LAUNCHER_TOOLS_TOKEN_FILE: join(dir, "tools-token"),
    };
    const fail = (message: string): never => {
      throw new Error(message);
    };
    const first = withTokenFiles((name) => vars[name], fail);
    const token = first("RYPH_LAUNCHER_TOKEN")!;
    const tools = first("RYPH_LAUNCHER_TOOLS_TOKEN")!;
    assertEquals(token.length, 64);
    assertEquals(token === tools, false);
    // The caller's read, which mounts the volume read-only: the same values.
    assertEquals(launcherTokenFromEnv((name) => vars[name], "RYPH_LAUNCHER_TOKEN"), token);
    assertEquals(launcherTokenFromEnv((name) => vars[name], "RYPH_LAUNCHER_TOOLS_TOKEN"), tools);
    // A second boot reads what the first minted, and the file is not rewritten.
    const again = withTokenFiles((name) => vars[name], fail);
    assertEquals(again("RYPH_LAUNCHER_TOKEN"), token);
    assertEquals(readFileSync(join(dir, "token"), "utf8"), `${token}\n`);
    assertEquals(statSync(join(dir, "token")).mode & 0o777, 0o644);
    // A variable set outright wins over its file.
    const set = withTokenFiles((name) => ({ ...vars, RYPH_LAUNCHER_TOKEN: "given" })[name], fail);
    assertEquals(set("RYPH_LAUNCHER_TOKEN"), "given");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a caller refuses an unreadable token file by name", () => {
  assertThrows(
    () =>
      launcherTokenFromEnv(
        (name) => name === "RYPH_LAUNCHER_TOKEN_FILE" ? "/nonexistent/token" : undefined,
        "RYPH_LAUNCHER_TOKEN",
      ),
    Error,
    "RYPH_LAUNCHER_TOKEN_FILE=/nonexistent/token could not be read",
  );
});

test("one prefetch list for both launchers: a confined build's BuildKit too, nothing unset or off", () => {
  const none = () => undefined;
  const builds = { harness: "harness:1", universal: "off", confined: true };
  assertEquals(
    prefetchImages({
      agent: "agent:1",
      gate: "gate:1",
      browser: "",
      toolGuard: null,
      builds,
      env: none,
    }).map((i) => i.name),
    ["agent", "run-gate", "harness", "buildkit"],
  );
  // Unconfined builds run on the daemon's own builder: no BuildKit image to fetch.
  assertEquals(
    prefetchImages({
      agent: null,
      gate: null,
      browser: null,
      toolGuard: "guard:1",
      builds: { ...builds, confined: false },
      env: none,
    }).map((i) => i.name),
    ["tool-guard", "harness"],
  );
  assertEquals(
    prefetchImages({
      agent: null,
      gate: null,
      browser: null,
      toolGuard: null,
      builds,
      env: (name) => name === "RYPH_ENV_BUILDKIT_IMAGE" ? "bk:2" : undefined,
    }).find((i) => i.name === "buildkit")?.image,
    "bk:2",
  );
  const fail = (message: string): never => {
    throw new Error(message);
  };
  assertEquals(prefetchOn(none, fail), true);
  assertEquals(prefetchOn(() => "OFF", fail), false);
  assertThrows(() => prefetchOn(() => "maybe", fail), Error, "RYPH_IMAGE_PREFETCH");
});
