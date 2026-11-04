// `ryph login`: the secret `up` leaves for it, and what it says when it cannot get a link.

import { test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  loginSecretPath,
  mintLoginSecret,
  requestLoginLink,
  writeLoginSecret,
} from "../src/login.ts";

test("the login secret is written owner-only, fresh every launch", async () => {
  const home = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const path = loginSecretPath(home)!;
    assertEquals(path, join(home, "login.secret"));
    const first = mintLoginSecret();
    const second = mintLoginSecret();
    assert(/^[0-9a-f]{64}$/.test(second));
    assert(first !== second, "a restart retires the old secret");
    await writeLoginSecret(first, path);
    await writeLoginSecret(second, path);
    assertEquals((await readFile(path, "utf8")).trim(), second);
    if (process.platform !== "win32") assertEquals((await stat(path)).mode! & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true });
  }
});

test("a secret replacing a wider file never sits in it: the file ends owner-only", async () => {
  if (process.platform === "win32") return;
  const home = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const path = loginSecretPath(home)!;
    await writeFile(path, "old\n", { mode: 0o644 });
    await chmod(path, 0o644);
    const secret = mintLoginSecret();
    await writeLoginSecret(secret, path);
    assertEquals(await readFile(path, "utf8"), `${secret}\n`);
    assertEquals((await stat(path)).mode! & 0o777, 0o600);
    // Nothing is left beside it.
    assertEquals(await readdir(home), ["login.secret"]);
  } finally {
    await rm(home, { recursive: true });
  }
});

test("a link is asked for with the secret, and every failure says what to do", async () => {
  const home = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const path = join(home, "login.secret");
    const missing = await requestLoginLink("http://127.0.0.1:7411", path);
    assert(!missing.ok);
    assertStringIncludes(missing.reason, "ryph up");

    const secret = mintLoginSecret();
    await writeLoginSecret(secret, path);
    const seen: { url: string; auth: string | null }[] = [];
    const answering = (status: number, body: unknown) =>
      ((input: string | URL | Request, init?: RequestInit) => {
        seen.push({
          url: String(input),
          auth: new Headers(init?.headers).get("authorization"),
        });
        return Promise.resolve(new Response(JSON.stringify(body), { status }));
      }) as unknown as typeof fetch;

    const ok = await requestLoginLink(
      "http://127.0.0.1:7411",
      path,
      answering(201, { link: "http://localhost:3000/auth/login-link/abc" }),
    );
    assertEquals(ok, { ok: true, link: "http://localhost:3000/auth/login-link/abc" });
    assertEquals(seen[0], {
      url: "http://127.0.0.1:7411/v1/auth/local/login-link",
      auth: `Bearer ${secret}`,
    });

    const stale = await requestLoginLink("http://127.0.0.1:7411", path, answering(401, {}));
    assert(!stale.ok);
    assertStringIncludes(stale.reason, "Restart `ryph up`");

    // A 404 from the route itself carries its reason; one from the router means the control
    // plane has no such route, which a restart of `ryph up` would not explain.
    const ownerless = await requestLoginLink(
      "http://127.0.0.1:7411",
      path,
      answering(404, { error: "this instance has no owner who can sign in" }),
    );
    assertEquals(ownerless, { ok: false, reason: "this instance has no owner who can sign in" });
    const noRoute = await requestLoginLink(
      "http://127.0.0.1:7411",
      path,
      answering(404, { error: "not found" }),
    );
    assert(!noRoute.ok);
    assertStringIncludes(noRoute.reason, "not started by `ryph up`");
    assert(!noRoute.reason.includes("Restart `ryph up`"));

    const multiUser = await requestLoginLink(
      "http://127.0.0.1:7411",
      path,
      answering(409, { error: "login links are for a single-user instance" }),
    );
    assertEquals(multiUser, { ok: false, reason: "login links are for a single-user instance" });

    const down = await requestLoginLink(
      "http://127.0.0.1:7411",
      path,
      (() => Promise.reject(new TypeError("connection refused"))) as unknown as typeof fetch,
    );
    assert(!down.ok);
    assertStringIncludes(down.reason, "nothing answers");
  } finally {
    await rm(home, { recursive: true });
  }
});
