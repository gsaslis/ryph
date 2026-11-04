// `caFetch` against a real TLS server whose certificate a test CA signed: the CA is what makes it
// verify, another CA does not, and nothing turns verification off.

import { afterAll, beforeAll, describe, test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { caFetch } from "../src/ca_fetch.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url), "utf8");
const CA = fixture("ca.crt");
const OTHER = fixture("other.crt");

let server: Server;
let base = "";
const seen: Array<{ method?: string; auth?: string; body: string }> = [];

beforeAll(async () => {
  server = createServer({ key: fixture("server.key"), cert: fixture("server.crt") }, (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, auth: req.headers.authorization, body });
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"type":"ADDED"}\n');
        setTimeout(() => res.end('{"type":"DELETED"}\n'), 50);
        return;
      }
      if (req.url === "/hang") return;
      res.writeHead(req.url === "/missing" ? 404 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("caFetch", () => {
  test("a certificate the CA signed verifies, and the request goes through whole", async () => {
    const res = await caFetch(CA)(`${base}/api/v1/pods`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ kind: "Pod" }),
    });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "application/json");
    assertEquals(await res.json(), { path: "/api/v1/pods" });
    assertEquals(seen.at(-1), { method: "POST", auth: "Bearer t", body: '{"kind":"Pod"}' });
  });

  test("a certificate some other CA would vouch for is refused", async () => {
    // The verification failure is the whole point: no option exists to skip it.
    const err = await caFetch(OTHER)(`${base}/`).catch((e) => e);
    assert(err instanceof Error);
    assertEquals((err as NodeJS.ErrnoException).code, "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
  });

  test("the global fetch, with no CA, refuses the same server", async () => {
    await assertRejects(() => fetch(`${base}/`));
  });

  test("an error status comes back as a response, not a throw", async () => {
    const res = await caFetch(CA)(`${base}/missing`);
    assertEquals(res.status, 404);
    assertEquals(res.ok, false);
    await res.text();
  });

  test("the body streams as it arrives", async () => {
    const res = await caFetch(CA)(`${base}/stream`);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    assertEquals((await reader.read()).value, '{"type":"ADDED"}\n');
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += value;
    }
    assertEquals(rest, '{"type":"DELETED"}\n');
  });

  test("an abort signal ends a request that hangs", async () => {
    await assertRejects(() => caFetch(CA)(`${base}/hang`, { signal: AbortSignal.timeout(100) }));
  });

  test("plain http is refused rather than sent without TLS", async () => {
    await assertRejects(() => caFetch(CA)("http://127.0.0.1:1/"), TypeError, "https:");
  });
});
