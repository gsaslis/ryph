// The settings file is the thing a person edits by hand, so the two properties that matter are
// that hand edits survive a `ryph setup` re-run, and that nothing in the file can outrank a
// variable somebody exported on purpose.

import { test } from "bun:test";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { launcherCallerRefusal } from "@ryph/orchestrator/docker";
import {
  applyFileDirDefaults,
  buildsDefault,
  configExists,
  configPath,
  defaultFileDirs,
  defaultLocalRepoRoot,
  loadConfigIntoEnv,
  MANUAL_OPT_IN,
  parseConfig,
  provisionerRefusal,
  readConfig,
  ryphHome,
  updateConfig,
} from "../src/config_file.ts";

/** Each case gets its own RYPH_HOME, so nothing here can reach the developer's real one. */
async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "ryph-config-"));
  const before = process.env.RYPH_HOME;
  process.env.RYPH_HOME = home;
  try {
    await fn(home);
  } finally {
    if (before === undefined) delete process.env.RYPH_HOME;
    else process.env.RYPH_HOME = before;
    await rm(home, { recursive: true });
  }
}

test("parses assignments, comments and quoted values", () => {
  const { values } = parseConfig(`
# a comment
RYPH_PROVISIONER=docker

  RYPH_AGENT_IMAGE = ryph-agent:dev
RYPH_LOCAL_REPO_ROOT="/Users/someone/my code"
#RYPH_PORT=9999
`);
  assertEquals(values.get("RYPH_PROVISIONER"), "docker");
  assertEquals(values.get("RYPH_AGENT_IMAGE"), "ryph-agent:dev");
  assertEquals(values.get("RYPH_LOCAL_REPO_ROOT"), "/Users/someone/my code");
  assertEquals(values.has("RYPH_PORT"), false, "a commented line is not a setting");
});

test("only RYPH_* is applied, and RYPH_HOME cannot come from inside the file", () => {
  const { values, ignored } = parseConfig("PATH=/evil\nRYPH_HOME=/elsewhere\nRYPH_PORT=1234\n");
  assertEquals([...values.keys()], ["RYPH_PORT"]);
  assertEquals(ignored.sort(), ["PATH", "RYPH_HOME"]);
});

test("the environment beats the file", async () => {
  await withHome(async () => {
    await updateConfig(new Map([["RYPH_PORT", "1234"], ["RYPH_LOG_LEVEL", "debug"]]));
    process.env.RYPH_PORT = "9999";
    try {
      const applied = await loadConfigIntoEnv();
      assertEquals(applied, ["RYPH_LOG_LEVEL"], "only the key the file actually decided");
      assertEquals(process.env.RYPH_PORT, "9999");
      assertEquals(process.env.RYPH_LOG_LEVEL, "debug");
    } finally {
      delete process.env.RYPH_PORT;
      delete process.env.RYPH_LOG_LEVEL;
    }
  });
});

test("a re-run edits in place and keeps what somebody wrote by hand", async () => {
  await withHome(async (home) => {
    const path = join(home, "config.env");
    await updateConfig(new Map([["RYPH_PROVISIONER", "manual"]]));
    await writeFile(
      path,
      `${await readFile(path, "utf8")}\n# mine, do not touch\nRYPH_APP_PORT=4000\n`,
    );

    await updateConfig(
      new Map([["RYPH_PROVISIONER", "docker"], ["RYPH_AGENT_IMAGE", "ryph-agent:dev"]]),
    );

    const text = await readFile(path, "utf8");
    assertStringIncludes(text, "# mine, do not touch");
    assertStringIncludes(text, "RYPH_APP_PORT=4000");
    assertEquals(text.match(/^RYPH_PROVISIONER=/gm)?.length, 1, "replaced, not appended twice");
    const { values } = parseConfig(text);
    assertEquals(values.get("RYPH_PROVISIONER"), "docker");
    assertEquals(values.get("RYPH_AGENT_IMAGE"), "ryph-agent:dev");
  });
});

test("a null value removes the setting", async () => {
  await withHome(async () => {
    await updateConfig(new Map([["RYPH_AGENT_IMAGE", "x:1"], ["RYPH_HARNESS_KINDS", "pi,echo"]]));
    await updateConfig(new Map([["RYPH_HARNESS_KINDS", null]]));
    const { values } = await readConfig();
    assertEquals(values.has("RYPH_HARNESS_KINDS"), false);
    assertEquals(values.get("RYPH_AGENT_IMAGE"), "x:1", "its neighbour is untouched");
  });
});

test("the file is owner-only — it can hold a GitHub token", async () => {
  if (process.platform === "win32") return;
  await withHome(async () => {
    const path = await updateConfig(new Map([["RYPH_GITHUB_TOKEN", "ghp_secret"]]));
    assertEquals((await stat(path)).mode! & 0o777, 0o600);
  });
});

test("a wider settings file is replaced, never written into", async () => {
  if (process.platform === "win32") return;
  await withHome(async () => {
    const path = configPath()!;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "RYPH_AGENT_IMAGE=x:1\n", { mode: 0o644 });
    // Whoever could read the old file (here: holds it open) never sees the token.
    const before = await open(path, "r");
    try {
      await updateConfig(new Map([["RYPH_GITHUB_TOKEN", "ghp_secret"]]));
      assertEquals((await before.readFile("utf8")).includes("ghp_secret"), false);
    } finally {
      await before.close();
    }
    assertEquals((await stat(path)).mode! & 0o777, 0o600);
    assertStringIncludes(await readFile(path, "utf8"), "RYPH_AGENT_IMAGE=x:1");
  });
});

test("a missing file is not an error, and the home moves everything together", async () => {
  await withHome(async (home) => {
    assertEquals(await configExists(), false);
    assertEquals((await readConfig()).values.size, 0);
    assertEquals(ryphHome(), home);
    assertEquals(configPath(), join(home, "config.env"));
    await updateConfig(new Map([["RYPH_PORT", "1"]]));
    assert(await configExists());
  });
});

test("a run's images and build logs default under the home, beside the database, never in it", async () => {
  await withHome((home) => {
    const dirs = defaultFileDirs();
    assertEquals(dirs, {
      RYPH_ATTACHMENT_DIR: join(home, "files"),
      RYPH_ENV_LOG_DIR: join(home, "files"),
      RYPH_FORGE_DATA: join(home, "forge"),
      RYPH_RADICLE_DATA: join(home, "radicle"),
      RYPH_ENV_CACHE_DIR: join(home, "env-cache"),
      RYPH_ENV_TEMP_DIR: join(home, "tmp"),
    });
    // Not PGlite's directory (`<home>/data`), which a restore replaces whole.
    assert(!dirs.RYPH_ATTACHMENT_DIR.startsWith(join(home, "data")));
    return Promise.resolve();
  });
  assertEquals(defaultFileDirs(null), {});
});

test("a launcher elsewhere keeps its own build dirs, so the defaults pass the host's refusal", () => {
  const home = "/home/someone/.ryph";
  const url = "http://launcher:7470";
  const remote: Record<string, string | undefined> = { RYPH_LAUNCHER_URL: url };
  applyFileDirDefaults(remote, home);
  assertEquals(remote.RYPH_ENV_CACHE_DIR, undefined);
  assertEquals(remote.RYPH_ENV_TEMP_DIR, undefined);
  assertEquals(remote.RYPH_ATTACHMENT_DIR, join(home, "files"));
  // What the host does with RYPH_LAUNCHER_URL set: refuse the launcher's own settings here.
  assertEquals(
    launcherCallerRefusal((name) => remote[name], url, null, {
      checks: true,
      builds: true,
      builder: "docker",
    }),
    null,
  );

  for (const setting of [undefined, "embedded", " "]) {
    const embedded: Record<string, string | undefined> = { RYPH_LAUNCHER_URL: setting };
    applyFileDirDefaults(embedded, home);
    assertEquals(embedded.RYPH_ENV_CACHE_DIR, join(home, "env-cache"));
    assertEquals(embedded.RYPH_ENV_TEMP_DIR, join(home, "tmp"));
  }
  // Set by hand, kept, and then the refusal is the operator's to see.
  const own: Record<string, string | undefined> = { RYPH_ATTACHMENT_DIR: "/srv/files" };
  applyFileDirDefaults(own, home);
  assertEquals(own.RYPH_ATTACHMENT_DIR, "/srv/files");
});

test("the local repo root defaults to HOME, not RYPH_HOME, and is no file dir", async () => {
  const before = process.env.HOME;
  process.env.HOME = "/home/someone/";
  try {
    await withHome((home) => {
      // Moving ryph's own files does not move your code.
      assertEquals(defaultLocalRepoRoot(), "/home/someone");
      assert(!Object.values(defaultFileDirs()).includes(defaultLocalRepoRoot()!));
      assert(!defaultLocalRepoRoot()!.startsWith(home));
      return Promise.resolve();
    });
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
});

test("environment builds and checks default on under docker, and off elsewhere", () => {
  assertEquals(buildsDefault("docker"), "on");
  for (const other of ["manual", "kubernetes", undefined]) {
    assertEquals(buildsDefault(other), "off");
  }
});

test("`up` refuses to start with no provisioner, or `manual` without the dev opt-in", () => {
  // Unset: every run would sit until it is marked lost, so the boot says how to fix it.
  for (const unset of [{}, { RYPH_PROVISIONER: "" }, { RYPH_PROVISIONER: "  " }]) {
    const refused = provisionerRefusal(unset);
    assert(refused !== null, JSON.stringify(unset));
    assertStringIncludes(refused, "ryph setup");
  }
  // `manual` launches nothing either; only the playground's explicit opt-in starts it.
  const manual = provisionerRefusal({ RYPH_PROVISIONER: "manual" });
  assert(manual !== null);
  assertStringIncludes(manual, `${MANUAL_OPT_IN}=1`);
  assert(provisionerRefusal({ RYPH_PROVISIONER: "manual", [MANUAL_OPT_IN]: "0" }) !== null);
  assertEquals(provisionerRefusal({ RYPH_PROVISIONER: "manual", [MANUAL_OPT_IN]: "1" }), null);
  // A launching provisioner boots; the opt-in is not needed for it.
  assertEquals(provisionerRefusal({ RYPH_PROVISIONER: "docker" }), null);
  assertEquals(provisionerRefusal({ RYPH_PROVISIONER: "kubernetes" }), null);
});
