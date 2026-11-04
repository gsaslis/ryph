// The shared HTTP client's own guards: redirects are refused rather than followed (a 307 would
// carry the API token elsewhere), a plain-http address off this machine is warned about,
// RYPH_URL is held to an address alone, answers are read to a cap, a short-lived access token is
// still reused, and an upload answered with something other than JSON is an `ApiError`.

import { afterAll, beforeAll, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "@std/path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  ApiError,
  MAX_BODY_BYTES,
  resolveClientConfig,
  RyphClient,
  UsageError,
} from "../src/api/client.ts";
import { ChecksClient } from "../src/checks/api.ts";
import { accessToken } from "./_fake_ryph.ts";

let elsewhere: ReturnType<typeof Bun.serve>;
let redirecting: ReturnType<typeof Bun.serve>;
const reachedElsewhere: string[] = [];
let redirectExchange = true;

beforeAll(() => {
  // The host a redirect points at: it must never hear from the client.
  elsewhere = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      reachedElsewhere.push(`${req.method} ${new URL(req.url).pathname} ${await req.text()}`);
      return Response.json({ accessToken: accessToken(["*"]), expiresIn: 900 });
    },
  });
  redirecting = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/auth/token" && !redirectExchange) {
        return Response.json({ accessToken: accessToken(["*"]), expiresIn: 900 });
      }
      return new Response(null, {
        status: url.pathname === "/api/v1/auth/token" ? 307 : 308,
        headers: { location: `http://127.0.0.1:${elsewhere.port}${url.pathname}` },
      });
    },
  });
});

afterAll(() => {
  elsewhere.stop(true);
  redirecting.stop(true);
});

test("a 307 at the exchange is not followed, and the other host never hears the token", async () => {
  redirectExchange = true;
  const client = new RyphClient({
    url: `http://127.0.0.1:${redirecting.port}`,
    token: "ryph_pat_secret",
  });
  const err = await assertRejects(() => client.json("GET", "/v1/tasks"), ApiError);
  assertEquals(err.status, 307);
  assertStringIncludes(
    err.message,
    `redirected to http://127.0.0.1:${elsewhere.port}/api/v1/auth/token`,
  );
  assertStringIncludes(err.message, "set RYPH_URL to that address if it is correct");
  assertEquals(reachedElsewhere, []);
});

test("a redirect on any later request is refused the same way", async () => {
  redirectExchange = false;
  const client = new RyphClient({
    url: `http://127.0.0.1:${redirecting.port}`,
    token: "ryph_pat_secret",
  });
  const err = await assertRejects(() => client.json("POST", "/v1/tasks", { a: 1 }), ApiError);
  assertEquals(err.status, 308);
  assertStringIncludes(
    err.message,
    `redirected to http://127.0.0.1:${elsewhere.port}/api/v1/tasks`,
  );
  assertEquals(reachedElsewhere, []);
});

test("every request asks fetch not to follow redirects", async () => {
  const modes: Array<RequestInit["redirect"]> = [];
  const fetch = (_input: string | URL | Request, init?: RequestInit) => {
    modes.push(init?.redirect);
    return Promise.resolve(Response.json({ accessToken: accessToken(["*"]), expiresIn: 900 }));
  };
  const client = new RyphClient({
    url: "https://ryph.example",
    token: "ryph_pat_x",
    fetch: fetch as typeof globalThis.fetch,
  });
  await client.json("GET", "/v1/a");
  await client.text("/v1/b");
  assertEquals(modes, ["manual", "manual", "manual"]);
});

test("plain http off this machine is warned about once, on the warning channel", () => {
  const warnings: string[] = [];
  const warn = (m: string) => void warnings.push(m);
  for (
    const url of [
      "http://localhost:7400",
      "http://127.0.0.1",
      "http://127.8.9.10",
      "http://[::1]:3000",
    ]
  ) {
    new RyphClient({ url, token: "t", warn });
  }
  new RyphClient({ url: "https://ryph.lan", token: "t", warn });
  assertEquals(warnings, []);
  const client = new RyphClient({ url: "http://192.168.1.20:3000", token: "t", warn });
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "unencrypted");
  assertStringIncludes(warnings[0], "192.168.1.20:3000");
  // A view of the same client for one call says nothing again.
  client.withSignal(new AbortController().signal);
  assertEquals(warnings.length, 1);
});

test("RYPH_URL is an address alone: no credentials, query or fragment", async () => {
  const config = (url: string) =>
    resolveClientConfig(() => undefined, new Map([["RYPH_URL", url], ["RYPH_TOKEN", "t"]]));
  for (
    const [url, words] of [
      ["https://ada:pw@ryph.example", "a user name or a password"],
      ["https://ryph.example/?x=1", "a query"],
      ["https://ryph.example/#top", "a fragment"],
      ["ftp://ryph.example", "http(s)"],
      ["not a url", "http(s)"],
    ]
  ) {
    await assertRejects(() => config(url), UsageError, words);
  }
  assertEquals((await config("https://ryph.example///")).url, "https://ryph.example");
  assertEquals((await config("https://h.example/ryph/")).url, "https://h.example/ryph");
});

test("a deployment under a path keeps it on every request and link", async () => {
  const urls: string[] = [];
  const fetch = (input: string | URL | Request) => {
    urls.push(String(input));
    return Promise.resolve(Response.json({ accessToken: accessToken(["*"]), expiresIn: 900 }));
  };
  const client = new RyphClient({
    url: "https://h.example/ryph/",
    token: "t",
    fetch: fetch as typeof globalThis.fetch,
  });
  await client.json("GET", "/v1/tasks?limit=2");
  assertEquals(urls, [
    "https://h.example/ryph/api/v1/auth/token",
    "https://h.example/ryph/api/v1/tasks?limit=2",
  ]);
  assertEquals(client.appUrl("/tasks/t-1"), "https://h.example/ryph/tasks/t-1");
  assertEquals(client.origin, "https://h.example/ryph");
});

test("a short-lived access token is still reused rather than exchanged on every request", async () => {
  let exchanges = 0;
  const fetch = (input: string | URL | Request) => {
    if (String(input).endsWith("/auth/token")) {
      exchanges++;
      return Promise.resolve(Response.json({ accessToken: accessToken(["*"]), expiresIn: 30 }));
    }
    return Promise.resolve(Response.json({}));
  };
  const client = new RyphClient({
    url: "https://ryph.example",
    token: "t",
    fetch: fetch as typeof globalThis.fetch,
  });
  for (let i = 0; i < 3; i++) await client.json("GET", "/v1/a");
  assertEquals(exchanges, 1);
});

test("an answer past the cap is refused, not read into memory", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(0x61);
  let sent = 0;
  const fetch = (input: string | URL | Request) => {
    if (String(input).endsWith("/auth/token")) {
      return Promise.resolve(Response.json({ accessToken: accessToken(["*"]), expiresIn: 900 }));
    }
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent > MAX_BODY_BYTES * 4) return controller.close();
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      ),
    );
  };
  const client = new RyphClient({
    url: "https://ryph.example",
    token: "t",
    fetch: fetch as typeof globalThis.fetch,
  });
  const err = await assertRejects(() => client.text("/v1/log"), ApiError);
  assertStringIncludes(err.message, "larger than 16 MiB");
  // It stopped reading shortly past the cap, not at the end of the stream.
  assert(sent < MAX_BODY_BYTES + 4 * chunk.byteLength, String(sent));
});

test("a bundle upload answered with something that is not JSON is an ApiError", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-bundle-"));
  try {
    const path = join(dir, "x.bundle");
    await writeFile(path, "bundle");
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/auth/token")) {
        return Response.json({ accessToken: accessToken(["*"]), expiresIn: 900 });
      }
      await new Response(init?.body).arrayBuffer();
      return new Response("<html>Sign in to the Wi-Fi</html>", { status: 202 });
    };
    const checks = new ChecksClient({
      url: "https://ryph.example",
      token: "t",
      fetch: fetch as typeof globalThis.fetch,
    });
    const err = await assertRejects(
      () => checks.askBundle({ repo: "cr-1", branch: "main", path }),
      ApiError,
    );
    assertStringIncludes(err.message, "not JSON");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
