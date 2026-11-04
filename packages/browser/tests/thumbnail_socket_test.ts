import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { chmod, lstat, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareThumbnailSocket } from "../src/thumbnail_socket.ts";

const temporary = async () => realpath(await mkdtemp(join(tmpdir(), "ryph-thumbnail-socket-")));

test("thumbnail socket refuses unsafe directories and non-socket entries", async () => {
  const directory = await temporary();
  const socket = join(directory, "render.sock");
  try {
    await prepareThumbnailSocket(socket);
    await writeFile(socket, "do not delete");
    await assertRejects(() => prepareThumbnailSocket(socket));
    await rm(socket);
    await symlink(join(directory, "missing"), socket);
    await assertRejects(() => prepareThumbnailSocket(socket));
    await rm(socket);
    await chmod(directory, 0o770);
    await assertRejects(() => prepareThumbnailSocket(socket));
    await assertRejects(() => prepareThumbnailSocket("relative.sock"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("thumbnail failed startup exits nonzero without opening its listener", async () => {
  const directory = await temporary();
  const socket = join(directory, "render.sock");
  const child = Bun.spawn([
    process.execPath,
    "--no-env-file",
    resolve(import.meta.dirname, "../src/thumbnail.ts"),
  ], {
    env: {
      ...process.env,
      RYPH_THUMBNAIL_SOCKET: socket,
      RYPH_THUMBNAIL_SANDBOX: "required",
      RYPH_BROWSER_EXECUTABLE: join(directory, "missing-chromium"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [code, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    assertEquals(code, 1);
    assert(stderr.includes("executable_missing"));
    assert(!stderr.includes(directory));
    assertEquals(stdout, "");
    await assertRejects(() => lstat(socket));
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test("thumbnail Unix listener is 0660, active socket is preserved, stale socket is removed", async () => {
  const directory = await temporary();
  const socket = join(directory, "render.sock");
  const child = Bun.spawn([
    process.execPath,
    "--no-env-file",
    "--eval",
    `import { main } from ${JSON.stringify(resolve(import.meta.dirname, "../src/thumbnail.ts"))};
     await main(() => Promise.resolve(new Uint8Array([1])));`,
  ], {
    env: { ...process.env, RYPH_THUMBNAIL_SOCKET: socket, RYPH_THUMBNAIL_SANDBOX: "required" },
    stdout: "ignore",
    stderr: "inherit",
  });
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        response = await fetch("http://localhost/health", { unix: socket });
        break;
      } catch {
        await Bun.sleep(10);
      }
    }
    assertEquals(response?.status, 200);
    assertEquals(await response?.text(), "ok");
    assertEquals((await lstat(socket)).mode & 0o777, 0o660);
    await assertRejects(() => prepareThumbnailSocket(socket));
    child.kill("SIGKILL");
    await child.exited;
    assertEquals((await lstat(socket)).isSocket(), true);
    await prepareThumbnailSocket(socket);
    await assertRejects(() => lstat(socket));
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
