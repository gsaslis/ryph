// `command()` against real programs: exit codes, signals, pipes both ways, the environment, and a
// program that cannot be started.

import { describe, test } from "bun:test";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { spawn as nodeSpawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../src/mod.ts";

const dec = new TextDecoder();
const enc = new TextEncoder();

describe("output()", () => {
  test("collects stdout and stderr, with the exit code", async () => {
    const out = await command("sh", { args: ["-c", "echo out; echo err >&2; exit 3"] }).output();
    assertEquals(out.code, 3);
    assertEquals(out.success, false);
    assertEquals(out.signal, null);
    assertEquals(dec.decode(out.stdout), "out\n");
    assertEquals(dec.decode(out.stderr), "err\n");
    // Plain Uint8Arrays, as Deno's were: a Buffer would not compare equal to one.
    assertEquals(out.stdout.constructor, Uint8Array);
  });

  // Under Bun, a pipe with no reader when the child wrote and exited could drop the output, and a
  // reader attached once `spawn()` resolved came too late: busy CPUs and many short children made
  // a few in a thousand exit 0 with nothing on stdout. Loses tens of 3000 without the fix.
  // Its wall time scales inversely with the cores there are: about 60s on a 2-core runner, right at
  // bun's default per-test timeout, so it carries its own. Fewer spawns would miss the loss.
  test("a short child's output survives a loaded machine", async () => {
    // One child that keeps every core busy, killed as a group. Not a `yes` per core spawned from
    // here: a burst of long-lived direct children trips a separate Bun bug in which a sibling's
    // exit is never reported.
    const burners = nodeSpawn(
      "sh",
      ["-c", `for i in $(seq ${2 * availableParallelism()}); do yes >/dev/null & done; wait`],
      { stdio: "ignore", detached: true },
    );
    try {
      let lost = 0;
      let next = 0;
      await Promise.all(Array.from({ length: 64 }, async (_, lane) => {
        while (next++ < 3000) {
          if (lane % 2 === 0) {
            const out = await command("printf", { args: ["x\n"], stdin: "null" }).output();
            if (dec.decode(out.stdout) !== "x\n") lost++;
          } else {
            const child = await command("printf", {
              args: ["x\n"],
              stdin: "null",
              stdout: "piped",
            }).spawn();
            if (await new Response(child.stdout).text() !== "x\n") lost++;
            await child.status;
          }
        }
      }));
      assertEquals(lost, 0);
    } finally {
      process.kill(-burners.pid!, "SIGKILL");
    }
  }, 240_000);

  test("success is exit code 0", async () => {
    const out = await command("true").output();
    assertEquals({ code: out.code, success: out.success }, { code: 0, success: true });
  });

  test("a pipe that is not piped throws on reading", async () => {
    const out = await command("true", { stdout: "null" }).output();
    assertThrows(() => out.stdout, TypeError, "not piped");
    assertEquals(out.stderr.length, 0);
  });

  test("a program that is not there rejects with ENOENT", async () => {
    const err = await command("definitely-not-a-program-here").output().catch((e) => e);
    assertEquals((err as NodeJS.ErrnoException).code, "ENOENT");
    const spawnErr = await command("definitely-not-a-program-here").spawn().catch((e) => e);
    assertEquals((spawnErr as NodeJS.ErrnoException).code, "ENOENT");
  });

  test("a file that is not executable rejects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "process-test-"));
    try {
      const file = join(dir, "script");
      await writeFile(file, "#!/bin/sh\necho hi\n");
      await chmod(file, 0o644);
      await assertRejects(() => command(file).output());
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("an aborted signal kills it, reported as SIGTERM", async () => {
    const abort = new AbortController();
    const running = command("sleep", { args: ["10"], signal: abort.signal }).output();
    setTimeout(() => abort.abort(), 50);
    const out = await running;
    assertEquals({ code: out.code, signal: out.signal, success: out.success }, {
      code: 143,
      signal: "SIGTERM",
      success: false,
    });
  });

  test("cwd is where it runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "process-test-"));
    try {
      const out = await command("pwd", { cwd: dir }).output();
      // macOS's tmpdir is behind a /private symlink.
      assert(dec.decode(out.stdout).trim().endsWith(dir.replace(/^\/private/, "")));
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("the environment", () => {
  test("env is added to this process's", async () => {
    process.env.RYPH_PROCESS_TEST_INHERITED = "yes";
    try {
      const out = await command("sh", {
        args: ["-c", 'echo "$RYPH_PROCESS_TEST_INHERITED $ADDED"'],
        env: { ADDED: "too" },
      }).output();
      assertEquals(dec.decode(out.stdout), "yes too\n");
    } finally {
      delete process.env.RYPH_PROCESS_TEST_INHERITED;
    }
  });

  test("clearEnv gives the child env and nothing else, yet finds the program on our PATH", async () => {
    process.env.RYPH_PROCESS_TEST_SECRET = "leak";
    try {
      // `env` is looked up on this process's PATH: the child's has none.
      const out = await command("env", { clearEnv: true, env: { ONLY: "this" } }).output();
      const lines = dec.decode(out.stdout).trim().split("\n");
      assert(lines.includes("ONLY=this"), lines.join(","));
      assert(
        !lines.some((l) => l.startsWith("RYPH_PROCESS_TEST_SECRET=")),
        "the parent env leaked",
      );
      assert(!lines.some((l) => l.startsWith("PATH=")), lines.join(","));
    } finally {
      delete process.env.RYPH_PROCESS_TEST_SECRET;
    }
  });

  test("a PATH in env is the one the program is looked up on", async () => {
    const dir = await mkdtemp(join(tmpdir(), "process-test-"));
    try {
      await writeFile(join(dir, "only-here"), "#!/bin/sh\necho found\n", { mode: 0o755 });
      const out = await command("only-here", { clearEnv: true, env: { PATH: dir } }).output();
      assertEquals(dec.decode(out.stdout), "found\n");
      await assertRejects(() => command("only-here").output());
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("spawn()", () => {
  test("streams stdin in and stdout out", async () => {
    const child = await command("cat", { stdin: "piped", stdout: "piped" }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(enc.encode("hello "));
    await writer.write(enc.encode("world"));
    await writer.close();
    assertEquals(await new Response(child.stdout).text(), "hello world");
    assertEquals((await child.status).code, 0);
    assert(child.pid > 0);
  });

  test("pipes default to inherited, and reading one throws", async () => {
    const child = await command("true").spawn();
    assertThrows(() => child.stdout, TypeError, "not piped");
    assertThrows(() => child.stdin, TypeError, "not piped");
    await child.status;
  });

  test("kill ends it with the signal, and throws once it has exited", async () => {
    const child = await command("sleep", { args: ["10"] }).spawn();
    child.kill();
    assertEquals(await child.status, { success: false, code: 143, signal: "SIGTERM" });
    assertThrows(() => child.kill(), TypeError, "already terminated");

    const killed = await command("sleep", { args: ["10"] }).spawn();
    killed.kill("SIGKILL");
    assertEquals((await killed.status).code, 137);
  });

  test("output() on a spawned child collects what is piped", async () => {
    const child = await command("sh", {
      args: ["-c", "cat; echo done >&2"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    await new Response("piped through").body!.pipeTo(child.stdin);
    const out = await child.output();
    assertEquals(dec.decode(out.stdout), "piped through");
    assertEquals(dec.decode(out.stderr), "done\n");
  });

  test("a large output is not truncated", async () => {
    const out = await command("sh", { args: ["-c", "head -c 5000000 /dev/zero"] }).output();
    assertEquals(out.stdout.length, 5_000_000);
  });

  test("detached starts its own process group", async () => {
    const child = await command("sh", {
      args: ["-c", "ps -o pgid= -p $$"],
      stdout: "piped",
      detached: true,
    }).spawn();
    const pgid = Number(dec.decode((await child.output()).stdout).trim());
    assertEquals(pgid, child.pid);
  });
});

describe("lookup", () => {
  test("a relative PATH entry is never searched: it would name one directory and run from another", async () => {
    // Checked against this process's cwd but executed from the child's, a relative entry runs a
    // program nobody looked at. A shell resolves it against the child's; skipping it is safer.
    const root = await mkdtemp(join(tmpdir(), "ryph-"));
    const original = process.cwd();
    try {
      for (const side of ["parent", "child"]) {
        await mkdir(join(root, side, "bin"), { recursive: true });
        const tool = join(root, side, "bin", "ryph-probe-tool");
        await writeFile(tool, `#!/bin/sh\necho ${side}\n`);
        await chmod(tool, 0o755);
      }
      process.chdir(join(root, "parent"));
      const err = await assertRejects(() =>
        command("ryph-probe-tool", {
          cwd: join(root, "child"),
          env: { PATH: "bin:/usr/bin:/bin" },
          clearEnv: true,
        }).output()
      );
      assertEquals((err as NodeJS.ErrnoException).code, "ENOENT");
      // An absolute entry still is.
      const out = await command("ryph-probe-tool", {
        cwd: join(root, "child"),
        env: { PATH: `${join(root, "child", "bin")}:/usr/bin:/bin` },
        clearEnv: true,
      }).output();
      assertEquals(dec.decode(out.stdout), "child\n");
    } finally {
      process.chdir(original);
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("a refused argument or env value is never quoted in the error", async () => {
  for (
    const opts of [{ args: ["secret-value\0"] }, { env: { RYPH_X: "secret-value\0" } }]
  ) {
    const err = await assertRejects(() => command("true", opts).output());
    assert(!String(err).includes("secret-value"), String(err));
    assert(String(err).includes("true could not be started"), String(err));
  }
});
