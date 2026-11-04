import { test } from "bun:test";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { ownerOf, peerHosts, tunnelBase } from "../src/core/cluster.ts";
import { contentSecurityPolicy, validHost } from "../src/core/csp.ts";
import {
  appOrigin,
  landing,
  onAppSite,
  origin,
  pathOf,
  type Place,
  previewOf,
  serviceWorker,
} from "../src/core/gate.ts";
import {
  containCookie,
  downstreamHeaders,
  upstreamHeaders,
  withoutReporting,
} from "../src/core/headers.ts";
import {
  COOKIE,
  COOKIE_TTL_S,
  cookieName,
  cookieValues,
  forwardCredential,
  HTTP_COOKIE,
  keys,
  peerCredential,
  previewId,
  setViewerCookie,
  shardOf,
  shardOfId,
  VIEWER_TICKET_MS,
  viewerCookie,
  viewerCookieValid,
  viewerTicket,
  viewerTicketValid,
  withoutCookies,
} from "../src/core/keys.ts";

const SECRET = "s".repeat(64);
const ID = "0123456789abcdef0123456789abcdef";

test("preview ids are stable per run and port, distinct otherwise, and keyed", async () => {
  const k = await keys(SECRET);
  const id = await previewId(k, "r-1", 5173);
  assert(/^[a-f0-9]{32}$/.test(id));
  assertEquals(await previewId(await keys(SECRET), "r-1", 5173), id);
  assertNotEquals(await previewId(k, "r-1", 5174), id);
  assertNotEquals(await previewId(k, "r-2", 5173), id);
  assertNotEquals(await previewId(await keys("t".repeat(64)), "r-1", 5173), id);
  // The labels are domain-separated: an id is never a cookie MAC's prefix.
  assertNotEquals((await k.sign(`view:${id}:1`)).slice(0, 32), await previewId(k, id, 1));
});

test("a preview id starts with its run's shard, which says nothing without the key", async () => {
  const k = await keys(SECRET);
  const shard = await shardOf(k, "r-1");
  assert(/^[a-f0-9]{8}$/.test(shard));
  // Every preview of a run shares the prefix (and so its owner); the rest is per port.
  const a = await previewId(k, "r-1", 5173);
  const b = await previewId(k, "r-1", 5174);
  assertEquals(shardOfId(a), shard);
  assertEquals(shardOfId(b), shard);
  assertNotEquals(a.slice(8), b.slice(8));
  assertEquals(a.slice(8), (await k.sign("id:r-1:5173")).slice(0, 24));
  assertNotEquals(shardOfId(await previewId(k, "r-2", 5173)), shard);
  assertNotEquals(await shardOf(await keys("t".repeat(64)), "r-1"), shard);
  // Domain-separated from the id's own label, and the peer credential from everything.
  assertNotEquals(shard, (await k.sign("id:r-1")).slice(0, 8));
  const credential = await peerCredential(k);
  assert(/^[a-f0-9]{64}$/.test(credential));
  assertNotEquals(credential, SECRET);
  assertNotEquals(credential, await peerCredential(await keys("t".repeat(64))));
  // The forward credential stands in for the token between pods: neither it nor the peer one.
  const forward = await forwardCredential(k);
  assert(/^[a-f0-9]{64}$/.test(forward));
  assertNotEquals(forward, SECRET);
  assertNotEquals(forward, credential);
});

test("a run's owner is the same on every pod, spread evenly, and moves only when it must", () => {
  const shards = Array.from({ length: 3000 }, (_, i) => i.toString(16).padStart(8, "0"));
  for (const shard of shards.slice(0, 50)) assertEquals(ownerOf(shard, 1), 0);
  const counts = [0, 0, 0];
  for (const shard of shards) counts[ownerOf(shard, 3)]++;
  for (const count of counts) assert(count > 800 && count < 1200, `${counts}`);
  // Growing to four moves runs only onto the new pod; shrinking to two only off the pod that left.
  for (const shard of shards) {
    const three = ownerOf(shard, 3);
    const four = ownerOf(shard, 4);
    assert(four === three || four === 3, shard);
    const two = ownerOf(shard, 2);
    assert(three === 2 || two === three, shard);
  }
});

test("each ordinal's address comes from the chart's template, and runners dial it", () => {
  assertEquals(peerHosts("previews-{ordinal}.ryph.svc", 2), [
    "previews-0.ryph.svc",
    "previews-1.ryph.svc",
  ]);
  assertEquals(
    tunnelBase({ host: "previews-1.ryph.svc", tunnelPort: 7491, apiPort: 7493, peerPort: 7492 }),
    "ws://previews-1.ryph.svc:7491",
  );
  for (
    const template of [
      "previews.previews-peers.ryph.svc",
      "previews-{ordinal}-{ordinal}.svc",
      "previews-{ordinal}.svc/x",
      "previews-{ordinal}.svc:7492",
      "Previews-{ordinal}.svc",
    ]
  ) {
    assertEquals(peerHosts(template, 2), null, template);
  }
});

test("the bearer check accepts the token alone", async () => {
  const k = await keys(SECRET);
  assert(await k.bearer(SECRET));
  assert(!await k.bearer(null));
  assert(!await k.bearer(""));
  assert(!await k.bearer(SECRET.slice(1)));
  assert(!await k.bearer(SECRET + "s"));
});

test("viewer cookies are bound to their preview and expire", async () => {
  const k = await keys(SECRET);
  const now = 1_700_000_000_000;
  const value = await viewerCookie(k, ID, now);
  assert(await viewerCookieValid(k, ID, value, now));
  assert(await viewerCookieValid(k, ID, value, now + (COOKIE_TTL_S - 1) * 1000));
  assert(!await viewerCookieValid(k, ID, value, now + COOKIE_TTL_S * 1000));
  assert(!await viewerCookieValid(k, "f".repeat(32), value, now));
  assert(!await viewerCookieValid(await keys("t".repeat(64)), ID, value, now));
  const [exp, mac] = value.split(".");
  // A later expiry under the old MAC, a flipped MAC, junk.
  assert(!await viewerCookieValid(k, ID, `${Number(exp) + 1}.${mac}`, now));
  const flipped = (mac[0] === "0" ? "1" : "0") + mac.slice(1);
  assert(!await viewerCookieValid(k, ID, `${exp}.${flipped}`, now));
  assert(!await viewerCookieValid(k, ID, "", now));
  assert(!await viewerCookieValid(k, ID, `${exp}.${mac}.x`, now));
  // Correctly signed, but further out than this service ever mints.
  const far = Math.floor(now / 1000) + COOKIE_TTL_S * 2;
  assert(!await viewerCookieValid(k, ID, `${far}.${await k.sign(`view:${ID}:${far}`)}`, now));
});

test("viewer tickets carry their own MAC, bound to their preview, and expire", async () => {
  const k = await keys(SECRET);
  const now = 1_700_000_000_000;
  const value = await viewerTicket(k, ID, now);
  const [exp, nonce, mac] = value.split(".");
  assert(/^[A-Za-z0-9._-]+$/.test(value), "fits in a URL as it is");
  assertNotEquals(nonce, (await viewerTicket(k, ID, now)).split(".")[1]);
  assert(await viewerTicketValid(k, ID, value, now));
  assert(await viewerTicketValid(k, ID, value, now + VIEWER_TICKET_MS - 1));
  assert(!await viewerTicketValid(k, ID, value, now + VIEWER_TICKET_MS + 1000));
  assert(!await viewerTicketValid(k, "f".repeat(32), value, now));
  assert(!await viewerTicketValid(await keys("t".repeat(64)), ID, value, now));
  // A later expiry, another nonce or a flipped MAC under the old one; junk.
  assert(!await viewerTicketValid(k, ID, `${Number(exp) + 1}.${nonce}.${mac}`, now));
  assert(!await viewerTicketValid(k, ID, `${exp}.${"0".repeat(32)}.${mac}`, now));
  const flipped = (mac[0] === "0" ? "1" : "0") + mac.slice(1);
  assert(!await viewerTicketValid(k, ID, `${exp}.${nonce}.${flipped}`, now));
  assert(!await viewerTicketValid(k, ID, "", now));
  // Correctly signed, but further out than a ticket is ever minted for.
  const far = Math.floor(now / 1000) + 3600;
  const signed = await k.sign(`enter:${ID}:${far}:${nonce}`);
  assert(!await viewerTicketValid(k, ID, `${far}.${nonce}.${signed}`, now));
  // Nothing signed for another purpose passes as a ticket, nor a ticket as a cookie.
  const cookie = await viewerCookie(k, ID, now);
  assert(!await viewerTicketValid(k, ID, cookie, now));
  assert(!await viewerCookieValid(k, ID, `${exp}.${mac}`, now));
});

test("the viewer cookie is __Host- and Secure over https, plain and host-only over http", () => {
  assertEquals(
    setViewerCookie("v", "https"),
    `${COOKIE}=v; Max-Age=${COOKIE_TTL_S}; Path=/; Secure; HttpOnly; SameSite=Lax`,
  );
  // Safari refuses `Secure` on http://*.localhost, and `__Host-` needs it.
  assertEquals(
    setViewerCookie("v", "http"),
    `${HTTP_COOKIE}=v; Max-Age=${COOKIE_TTL_S}; Path=/; HttpOnly; SameSite=Lax`,
  );
  assertEquals(cookieName("https"), COOKIE);
  assertEquals(cookieName("http"), HTTP_COOKIE);
});

test("cookie headers: our values found, and removed from what is forwarded", () => {
  const header = `a=1; ${COOKIE}=x; b=2; ${COOKIE}=y`;
  assertEquals(cookieValues(header, COOKIE), ["x", "y"]);
  assertEquals(cookieValues(undefined, COOKIE), []);
  assertEquals(withoutCookies(header, [COOKIE]), "a=1; b=2");
  assertEquals(withoutCookies(`${COOKIE}=x`, [COOKIE]), undefined);
  assertEquals(withoutCookies(undefined, [COOKIE]), undefined);
  assertEquals(withoutCookies(`${HTTP_COOKIE}=x; a=1; ${COOKIE}=y`, [COOKIE, HTTP_COOKIE]), "a=1");
});

test("the CSP follows the run's allowlist, and open mode holds only framing", () => {
  // Framed by its own pages only: Storybook and the Vitest UI do that.
  assertEquals(contentSecurityPolicy(null), "frame-ancestors 'self'");
  assertEquals(
    contentSecurityPolicy([]),
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; form-action 'self'; " +
      "base-uri 'self'; frame-ancestors 'self'",
  );
  // Fetches fall back to default-src, so there is no connect-src; forms post over https only.
  assertEquals(
    contentSecurityPolicy(["api.example.com", "*.cdn.example"]),
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://api.example.com " +
      "wss://api.example.com https://*.cdn.example wss://*.cdn.example; form-action 'self' " +
      "https://api.example.com https://*.cdn.example; base-uri 'self'; frame-ancestors 'self'",
  );
  for (const host of ["registry.npmjs.org", "*.githubusercontent.com"]) assert(validHost(host));
  for (
    const host of ["", "*", "*.", "localhost", "a.b; script-src *", "https://a.b", "A.B", "a.b:1"]
  ) {
    assert(!validHost(host), host);
  }
});

const place: Place = { scheme: "https", domain: "preview.ryph-previews.example" };
const local: Place = { scheme: "http", domain: "preview.localhost", publicPort: 7490 };

test("only a preview's exact host names it", () => {
  assertEquals(previewOf(place, `${ID}.preview.ryph-previews.example`), ID);
  assertEquals(previewOf(local, `${ID}.preview.localhost:7490`), ID);
  for (
    const host of [
      undefined,
      `${ID}.preview.localhost`,
      `${ID}.preview.localhost:7491`,
      `${ID}.preview.ryph-previews.example:443`,
      `${ID.toUpperCase()}.preview.ryph-previews.example`,
      `x.${ID}.preview.ryph-previews.example`,
      `${ID}.preview.ryph-previews.example.evil.example`,
      "preview.ryph-previews.example",
    ]
  ) {
    assertEquals(previewOf(host?.includes("localhost") ? local : place, host), null, host);
  }
  assertEquals(origin(local, ID), `http://${ID}.preview.localhost:7490`);
  assertEquals(pathOf("/a/b?c=//d#e"), "/a/b");
  assertEquals(pathOf("//evil/"), null);
  assertEquals(pathOf("http://x/"), null);
  assertEquals(pathOf(undefined), null);
});

test("a landing path is a plain same-origin path, or the root", () => {
  for (
    const path of [
      "/",
      "/nodes/oak.radicle.garden",
      "/a?b=//c&d=%2F",
      "/%2F/x",
      "/__ryph",
      "/a%2eb",
    ]
  ) {
    assertEquals(landing(path), path);
  }
  for (
    const path of [
      undefined,
      1,
      "",
      "a",
      "//evil.example",
      "/\\evil.example",
      "/a\\b",
      "https://evil.example",
      "/a\nb",
      "/a\tb",
      "/a\u007f",
      "/a b",
      "/ü",
      "/a#b",
      "/__ryph/enter",
      "/./__ryph/enter?ticket=x",
      "/x/../__ryph/x",
      "/x/..",
      // Escaped, which a browser reads as dots all the same.
      "/%2e/__ryph/enter",
      "/%2E%2e/__ryph/x",
      "/x/.%2E",
      "/x/%2e?y",
      `/${"a".repeat(2048)}`,
    ]
  ) {
    assertEquals(landing(path), "/", JSON.stringify(path));
  }
});

test("the app's URL must be exactly an http(s) origin", () => {
  assertEquals(appOrigin("https://ryph.example.com"), "https://ryph.example.com");
  assertEquals(appOrigin("https://ryph.example.com/"), "https://ryph.example.com");
  assertEquals(appOrigin("http://localhost:3000"), "http://localhost:3000");
  for (
    const value of [
      "ryph.example.com",
      "ftp://ryph.example.com",
      "javascript:alert(1)",
      "https://ryph.example.com/app",
      "https://ryph.example.com?x=1",
      "https://ryph.example.com#x",
      "https://user:pw@ryph.example.com",
      "https://ryph.example.com\\@evil.example",
      "https:///",
    ]
  ) {
    assertEquals(appOrigin(value), null, value);
  }
});

test("service worker scripts are recognised", () => {
  assert(serviceWorker({ "service-worker": "script" }));
  assert(!serviceWorker({}));
});

const target = { port: 5173, origin: `https://${ID}.preview.ryph-previews.example`, csp: "X" };

test("upstream headers: the dev server's own host and origin, never our cookie", () => {
  const out = upstreamHeaders({
    host: `${ID}.preview.ryph-previews.example`,
    origin: target.origin,
    cookie: `${COOKIE}=secret; theirs=1`,
    "x-forwarded-host": "spoofed",
    accept: "text/html",
  }, target);
  assertEquals(out, {
    host: "localhost:5173",
    origin: "http://localhost:5173",
    cookie: "theirs=1",
    "x-forwarded-host": `${ID}.preview.ryph-previews.example`,
    "x-forwarded-proto": "https",
    accept: "text/html",
  });
  const bare = upstreamHeaders({ cookie: `${COOKIE}=secret` }, target);
  assertEquals(bare.cookie, undefined);
  assertEquals(bare.origin, undefined);
});

test("downstream headers: cookies contained, redirects home, CSP added beside theirs", () => {
  assertEquals(containCookie("a=1; Domain=ryph-previews.example; Path=/"), "a=1; Path=/");
  assertEquals(containCookie("a=1;domain=.preview.ryph-previews.example"), "a=1");
  assertEquals(containCookie(`${COOKIE}=forged; Path=/`), null);
  assertEquals(containCookie(`__host-RYPH-preview=forged`), null);
  const out = downstreamHeaders({
    "set-cookie": ["a=1; Domain=ryph-previews.example", `${COOKIE}=x`],
    location: "http://127.0.0.1:5173/next?a=1",
    "content-security-policy": "script-src 'self'",
    "clear-site-data": '"cookies"',
    "x-other": "kept",
  }, target);
  assertEquals(out["set-cookie"], ["a=1"]);
  assertEquals(out.location, `${target.origin}/next?a=1`);
  assertEquals(out["content-security-policy"], ["script-src 'self'", "X"]);
  assertEquals(out["clear-site-data"], undefined);
  assertEquals(out["x-other"], "kept");
  const plain = downstreamHeaders({ "set-cookie": [`${COOKIE}=x`] }, target);
  assertEquals(plain["set-cookie"], undefined);
  assertEquals(plain["content-security-policy"], "X");
  for (
    const [location, rewritten] of [
      ["http://localhost:5173", target.origin],
      ["http://localhost:5173#x", `${target.origin}#x`],
      ["http://localhost:51730/", "http://localhost:51730/"],
      ["http://localhost:5174/", "http://localhost:5174/"],
      ["https://example.com/", "https://example.com/"],
      ["/relative", "/relative"],
    ]
  ) {
    assertEquals(downstreamHeaders({ location }, target).location, rewritten);
  }
});

test("the proxy-mode CSP holds forms and <base> to the allowlist too", () => {
  for (const hosts of [[], ["api.example.com"]]) {
    const tail = hosts.map((host) => ` https://${host}`).join("");
    const directives = contentSecurityPolicy(hosts).split("; ");
    assert(directives.includes(`form-action 'self'${tail}`), directives.join("; "));
    assert(directives.includes("base-uri 'self'"), directives.join("; "));
  }
});

test("upstream headers: the viewer's address and any forwarding chain never reach the dev server", () => {
  const out = upstreamHeaders({
    // What one previews pod says to another, whichever way a request came.
    "x-ryph-previews-peer": "a".repeat(64),
    "x-ryph-previews-hop": "1",
    "x-forwarded-for": "203.0.113.7",
    "x-forwarded-port": "443",
    "x-forwarded-proto": "http",
    "x-forwarded-host": "spoofed",
    "x-real-ip": "203.0.113.7",
    forwarded: "for=203.0.113.7",
    via: "1.1 google",
    accept: "*/*",
  }, target);
  assertEquals(out, {
    host: "localhost:5173",
    "x-forwarded-host": `${ID}.preview.ryph-previews.example`,
    "x-forwarded-proto": "https",
    accept: "*/*",
  });
});

test("downstream headers: no reporting endpoints, and no nameless cookie posing as ours", () => {
  const out = downstreamHeaders({
    nel: '{"report_to":"x","max_age":86400}',
    "report-to": '{"group":"x","endpoints":[{"url":"https://collect.example"}]}',
    "reporting-endpoints": 'x="https://collect.example"',
    "x-other": "kept",
  }, target);
  assertEquals(out.nel, undefined);
  assertEquals(out["report-to"], undefined);
  assertEquals(out["reporting-endpoints"], undefined);
  assertEquals(out["x-other"], "kept");
  assertEquals(containCookie(`=${COOKIE}=forged; Path=/`), null);
  assertEquals(containCookie(` =__HOST-ryph-preview=forged`), null);
  assertEquals(containCookie(`=other=1`), "=other=1");
});

test("downstream headers: neither cookie name of ours, in either mode", () => {
  for (const name of [COOKIE, HTTP_COOKIE]) {
    assertEquals(containCookie(`${name}=forged; Path=/`), null, name);
    assertEquals(containCookie(`${name.toUpperCase()}=forged`), null, name);
    assertEquals(containCookie(`=${name}=forged`), null, name);
  }
  const out = upstreamHeaders({ cookie: `${HTTP_COOKIE}=a; ${COOKIE}=b; theirs=1` }, target);
  assertEquals(out.cookie, "theirs=1");
});

test("downstream headers: the dev server's CSP keeps all but where it reports to", () => {
  assertEquals(
    withoutReporting("img-src 'none'; report-uri https://c.example/r"),
    "img-src 'none'",
  );
  assertEquals(withoutReporting("Report-To grp;img-src 'none'"), "img-src 'none'");
  assertEquals(
    withoutReporting(" REPORT-URI\thttps://c.example ; script-src 'self'"),
    "script-src 'self'",
  );
  // A comma separates policies: each is kept or emptied on its own.
  assertEquals(
    withoutReporting("report-uri https://c.example, img-src 'none'; report-to g"),
    "img-src 'none'",
  );
  assertEquals(withoutReporting("report-uri https://c.example; report-to g"), null);
  // Only the directive's own name counts, not a source that happens to spell one.
  assertEquals(withoutReporting("img-src report-uri.example"), "img-src report-uri.example");
  const out = downstreamHeaders({
    "content-security-policy": "img-src 'none'; report-uri https://c.example/r",
    "content-security-policy-report-only": "default-src 'none'; report-uri https://c.example",
  }, target);
  assertEquals(out["content-security-policy"], ["img-src 'none'", "X"]);
  assertEquals(out["content-security-policy-report-only"], undefined);
  // A policy that only reported is gone, and ours is all that is left.
  assertEquals(
    downstreamHeaders({ "content-security-policy": "report-to g" }, target)[
      "content-security-policy"
    ],
    "X",
  );
  // Several header lines, as a list.
  assertEquals(
    downstreamHeaders({
      "content-security-policy": ["report-uri https://c.example", "script-src 'self'"],
    } as unknown as Record<string, string>, target)["content-security-policy"],
    ["script-src 'self'", "X"],
  );
});

test("a preview domain on the app's registrable domain is refused, and only that", () => {
  for (
    const [domain, app] of [
      ["preview.ryph.example.com", "https://ryph.example.com"],
      ["preview.example.com", "https://ryph.example.com"],
      ["PREVIEW.Example.com.", "https://example.com"],
      ["preview.acme.co.uk", "https://app.acme.co.uk"],
    ]
  ) {
    assert(onAppSite(domain, app), `${domain} ${app}`);
  }
  for (
    const [domain, app] of [
      ["preview.example.net", "https://ryph.example.com"],
      ["preview.other.co.uk", "https://app.acme.co.uk"],
      ["preview.localhost", "http://localhost:3000"],
      ["preview.localhost", "http://192.168.1.4:3000"],
    ]
  ) {
    assert(!onAppSite(domain, app), `${domain} ${app}`);
  }
});
