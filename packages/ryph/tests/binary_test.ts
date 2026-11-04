// The compiled binary, built the way the shipping one is (scripts/compile.ts) around a probe
// entry (fixtures/binary_probe.ts), and run: the files it reads at runtime resolve inside it, its
// workers start, PGlite boots from its packed build, the artifact sanitizer runs as the binary
// itself, and a bunfig.toml or .env where it is started is never read. Skipped until the UI is
// built (`bun run build:app`): a binary is not built without it.

import { afterAll, beforeAll, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { command } from "@ryph/process";
import { canCompile, compileBinary, refusesHostileStart } from "../scripts/compile.ts";
import { MIGRATION_SETS } from "../src/embedded.ts";
import { removeTree } from "../src/resources.ts";
import { sanitizerRuntime } from "../../orchestrator/src/adapters/artifact_html/process_preparer.ts";

const require = createRequire(new URL("../../service/src/ws.ts", import.meta.url));
const ready = await canCompile();
const binaryTest = test.skipIf(!ready);

let dir = "";
let probe = "";

beforeAll(async () => {
  if (!ready) return;
  dir = await mkdtemp(join(tmpdir(), "ryph-binary-"));
  probe = join(dir, "probe");
  await compileBinary({
    output: probe,
    entry: new URL("./fixtures/binary_probe.ts", import.meta.url).pathname,
  });
}, 300_000);

afterAll(() => {
  // The unpacked copy under it is read-only: removeTree makes it writable first.
  if (dir !== "") removeTree(dir);
});

/**
 * Every environment the probe runs under: HOME and RYPH_HOME inside this test's directory, so
 * nothing it starts can reach the real ~/.ryph (its sanitizer child, with an empty environment,
 * is handed the runtime directory instead of finding one).
 */
function probeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = {
    HOME: join(dir, "home"),
    RYPH_HOME: join(dir, "home", ".ryph"),
    PATH: process.env.PATH ?? "",
    ...extra,
  };
  for (const name of ["HOME", "RYPH_HOME"] as const) {
    if (!env[name].startsWith(dir + "/")) throw new Error(`${name} outside the test: ${env[name]}`);
  }
  return env;
}

/** The runtime directory the probe unpacked under its HOME. */
async function probeRoot(): Promise<string> {
  const base = join(dir, "home", ".ryph", "runtime");
  const ids = (await readdir(base)).filter((name) => /^[0-9a-f]{16}$/.test(name));
  assertEquals(ids.length, 1, ids.join(", "));
  return realpathSync(join(base, ids[0]));
}

/** The probe run with nothing of this process's environment but a HOME of its own. */
function run(args: string[], stdin?: string, cwd = dir) {
  const child = command(probe, {
    args,
    cwd,
    env: probeEnv(),
    clearEnv: true,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  });
  if (stdin === undefined) return child.output();
  return child.spawn().then(async (c) => {
    const writer = c.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
    return await c.output();
  });
}

binaryTest("inside the binary: the packed files, the converter's worker, and PGlite", async () => {
  const out = await run([]);
  const said = new TextDecoder().decode(out.stderr);
  assert(out.success, said);
  const found = JSON.parse(new TextDecoder().decode(out.stdout));
  let migrations = 0;
  for (const set of MIGRATION_SETS) {
    migrations += (await readdir(set.dir)).filter((f) => f.endsWith(".sql")).length;
  }
  assertEquals(found.compiled, true);
  assertStringIncludes(found.markdown, "Hello");
  assertStringIncludes(found.markdown, "**worker**");
  assertEquals(found.migrations, migrations);
  assertEquals(found.app, true);
  assertEquals(found.postgres, 42);
});

binaryTest(
  "inside the binary: memory's embeddings load from the packed runtime and weights",
  async () => {
    const out = await run(["embed"]);
    const said = new TextDecoder().decode(out.stderr);
    // Exit 0, not Bun's abort on exiting with the ONNX runtime's thread still alive.
    assert(out.success, said);
    const found = JSON.parse(new TextDecoder().decode(out.stdout));
    assertEquals(found.dimensions, 384);
    assert(found.near > found.far + 0.1, JSON.stringify(found));
  },
);

binaryTest("inside the binary: the artifact sanitizer runs as the binary itself", async () => {
  const out = await run(
    ["__artifact-sanitizer", await probeRoot(), "3000", "192"],
    "<html><body><h1>published</h1></body></html>",
  );
  const answer = JSON.parse(new TextDecoder().decode(out.stdout));
  assertEquals(answer.kind, "ok", new TextDecoder().decode(out.stderr));
  assertStringIncludes(answer.served, "<h1>published</h1>");
});

binaryTest(
  "inside the binary: the sanitizer only opens the runtime directory it is named, never its own",
  async () => {
    // As the control plane starts it, but with no runtime directory named, or a wrong one: it
    // refuses, and writes nothing under the HOME it was given.
    const home = await mkdtemp(join(dir, "sanitizer-home-"));
    for (const named of [[], ["/nonexistent/0123456789abcdef"], [join(home, "x")]]) {
      const out = await command(probe, {
        args: ["__artifact-sanitizer", ...named, "3000", "192"],
        cwd: dir,
        env: { HOME: home },
        clearEnv: true,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(out.code, 1, new TextDecoder().decode(out.stderr));
      assertEquals(await readdir(home), []);
    }
  },
);

// What a source run decides here, which the binary must match: confined under mise's Node.
const sourceRuntime = sanitizerRuntime();

binaryTest(
  "inside the binary: the sanitizer runs confined under a Node 25 or later on PATH",
  async () => {
    assertEquals(sourceRuntime.kind, "confined", "no Node 25 or later on PATH to test with");
    const out = await run(["sanitize"]);
    const said = new TextDecoder().decode(out.stderr);
    assert(out.success, said);
    const found = JSON.parse(new TextDecoder().decode(out.stdout));
    assertEquals(found.runtime.kind, "confined", JSON.stringify(found));
    assertEquals(found.told, []);
    assertEquals(found.answer.kind, "ok", JSON.stringify(found));
    assertStringIncludes(found.answer.served, "<h1>published</h1>");
    // It reads the unpacked copy, never the repository's.
    for (const read of found.runtime.reads) {
      assert(read.startsWith(realpathSync(join(dir, "home", ".ryph", "runtime"))), read);
    }
  },
);

binaryTest(
  "inside the binary: with no node on PATH, the sanitizer runs unconfined and says so",
  async () => {
    const empty = await mkdtemp(join(dir, "no-node-"));
    const out = await command(probe, {
      args: ["sanitize"],
      cwd: dir,
      env: probeEnv({ PATH: empty }),
      clearEnv: true,
      stdin: "null",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    const found = JSON.parse(new TextDecoder().decode(out.stdout));
    assertEquals(found.runtime.kind, "unconfined");
    assertEquals(found.told.length, 1);
    assertStringIncludes(found.told[0], "unconfined: ");
    assertEquals(found.answer.kind, "ok", JSON.stringify(found));
  },
);

binaryTest(
  "inside the binary: a WebSocket upgrade uses the bundled ws, never one in cwd",
  async () => {
    const empty = await mkdtemp(join(dir, "empty-"));
    const clean = await run(["ws-upgrade"], undefined, empty);
    assert(clean.success, new TextDecoder().decode(clean.stderr));
    assertEquals(JSON.parse(new TextDecoder().decode(clean.stdout)).echoed, "echo:ping");

    // A `ws` planted where node resolution from the working directory (or HOME) would find it.
    const planted = await mkdtemp(join(dir, "planted-"));
    const mark = join(dir, "planted-ws-ran");
    const plant = `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");\n` +
      `module.exports = require(${
        JSON.stringify(require.resolve("ws/package.json").replace(/package\.json$/, "index.js"))
      });\n`;
    for (const base of [planted, join(dir, "home")]) {
      const pkg = join(base, "node_modules", "ws");
      await mkdir(pkg, { recursive: true });
      await writeFile(
        join(pkg, "package.json"),
        JSON.stringify({ name: "ws", version: "8.21.3", main: "index.js" }),
      );
      await writeFile(join(pkg, "index.js"), plant);
    }
    const out = await run(["ws-upgrade"], undefined, planted);
    assert(out.success, new TextDecoder().decode(out.stderr));
    assertEquals(JSON.parse(new TextDecoder().decode(out.stdout)).echoed, "echo:ping");
    assertEquals(existsSync(mark), false, "the binary loaded a ws planted beside where it ran");
  },
);

binaryTest(
  "the binary never reads a bunfig.toml or .env where it is started, nor starts under BUN_OPTIONS",
  async () => {
    await refusesHostileStart(probe);
  },
);

binaryTest(
  "a runtime directory others can write stops the binary with one line naming the fix",
  async () => {
    // RYPH_HOME on a share under umask 002: the runtime directory comes out group-writable.
    const home = join(dir, "shared-home");
    const base = join(home, "runtime");
    await mkdir(base, { recursive: true });
    await chmod(base, 0o775);
    const out = await command(probe, {
      args: [],
      cwd: dir,
      env: probeEnv({ RYPH_HOME: home }),
      clearEnv: true,
      stdin: "null",
    }).output();
    const said = new TextDecoder().decode(out.stderr).trim();
    assertEquals(out.code, 1, said);
    assertEquals(said.split("\n").length, 1, said);
    assertStringIncludes(said, base);
    assertStringIncludes(said, `chmod g-w,o-w ${base}`);
  },
);
