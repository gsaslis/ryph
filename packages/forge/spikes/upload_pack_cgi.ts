// Spike: read-only git smart-HTTP via `git http-backend` CGI.
import { command } from "@ryph/process";
import { serve } from "@ryph/service";

const ROOT = process.env.GIT_ROOT!;
const PORT = Number(process.env.PORT ?? "8174");
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === "1";
const EXPECT = "Basic " + btoa("agent:s3cr3t");

const CRLF2 = new Uint8Array([13, 10, 13, 10]);

function indexOfSeq(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// A counting passthrough so we can measure the real request-body size on the wire.
function counter(onDone: (n: number) => void) {
  let n = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(c, ctl) {
      n += c.byteLength;
      ctl.enqueue(c);
    },
    flush() {
      onDone(n);
    },
  });
}

await serve({ port: PORT, hostname: "127.0.0.1" }, async (req) => {
  const url = new URL(req.url);
  const t0 = performance.now();

  // ---- INSTRUMENTATION (question 3) ----
  const framing = req.headers.get("content-length") !== null
    ? `Content-Length: ${req.headers.get("content-length")}`
    : req.headers.get("transfer-encoding") !== null
    ? `Transfer-Encoding: ${req.headers.get("transfer-encoding")}`
    : "(none)";
  console.error(
    `\n[REQ] ${req.method} ${url.pathname}${url.search}\n` +
      `      framing=${framing}\n` +
      `      ua=${req.headers.get("user-agent")}\n` +
      `      git-protocol=${req.headers.get("git-protocol")} ` +
      `content-encoding=${req.headers.get("content-encoding")}`,
  );

  // ---- AUTH: happens BEFORE we spawn anything (question 5) ----
  let remoteUser = "";
  if (REQUIRE_AUTH) {
    const auth = req.headers.get("authorization");
    if (!auth || auth !== EXPECT) {
      console.error(`      -> 401 (auth=${auth ? "wrong" : "absent"})`);
      return new Response("unauthorized\n", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="ryph"' },
      });
    }
    remoteUser = atob(auth.slice(6)).split(":")[0];
    console.error(`      -> authed as ${remoteUser}`);
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GIT_PROJECT_ROOT: ROOT,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: url.pathname,
    REQUEST_METHOD: req.method,
    QUERY_STRING: url.search.slice(1),
    REMOTE_USER: remoteUser,
    // Hard read-only: refuse receive-pack no matter what the repo config says.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.receivepack",
    GIT_CONFIG_VALUE_0: "false",
    // http-backend buffers the whole request body in memory and hard-caps it
    // here (default 10M). This is the ONLY thing bounding request-body memory.
    GIT_HTTP_MAX_REQUEST_BUFFER: process.env.MAXREQ ?? "10M",
  };
  // http-backend only speaks protocol v2 if GIT_PROTOCOL is set from the
  // Git-Protocol request header. Drop it and every client silently falls back
  // to v0 (full ref advertisement on every connection). Sanitize rather than
  // pass through blindly -- this value reaches a subprocess env.
  const gitProto = req.headers.get("git-protocol");
  if (gitProto && /^[0-9a-zA-Z:=.,_-]{1,100}$/.test(gitProto)) {
    env.GIT_PROTOCOL = gitProto;
  }

  const ct = req.headers.get("content-type");
  if (ct) env.CONTENT_TYPE = ct;
  const cl = req.headers.get("content-length");
  if (cl) env.CONTENT_LENGTH = cl;

  // git gzips the upload-pack request body whenever it is NOT chunked.
  // http-backend inflates it itself, but only if it sees HTTP_CONTENT_ENCODING
  // (standard CGI mangling of the Content-Encoding header). Omit this and the
  // subprocess reads gzip bytes as pkt-lines and dies with
  // "bad line length character".
  const ce = req.headers.get("content-encoding");
  if (ce) env.HTTP_CONTENT_ENCODING = ce;

  const child = await command("git", {
    args: ["http-backend"],
    env,
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();

  // Pump request body -> stdin CONCURRENTLY with reading stdout (no await here:
  // awaiting the full body write before draining stdout deadlocks on big responses).
  let reqBytes = 0;
  const pumped = (async () => {
    if (req.body) {
      await req.body.pipeThrough(counter((n) => (reqBytes = n))).pipeTo(child.stdin);
    } else {
      await child.stdin.close();
    }
  })();

  // ---- Split CGI headers from body at the first CRLFCRLF ----
  const reader = child.stdout.getReader();
  let buf = new Uint8Array(0);
  let split = -1;
  while (split === -1) {
    const { value, done } = await reader.read();
    if (done) break;
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf);
    next.set(value, buf.length);
    buf = next;
    split = indexOfSeq(buf, CRLF2);
    if (buf.length > 64 * 1024 && split === -1) throw new Error("CGI headers too large");
  }
  if (split === -1) {
    reader.releaseLock();
    return new Response("bad CGI response\n", { status: 502 });
  }

  const headerText = new TextDecoder().decode(buf.subarray(0, split));
  const leftover = buf.subarray(split + 4);

  let status = 200;
  const headers = new Headers();
  for (const line of headerText.split("\r\n")) {
    if (!line) continue;
    const i = line.indexOf(":");
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k.toLowerCase() === "status") status = parseInt(v, 10) || 200;
    else headers.append(k, v);
  }

  const ttfb = (performance.now() - t0).toFixed(1);

  // ---- Stream the rest of stdout straight out ----
  let outBytes = leftover.byteLength;
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      if (leftover.byteLength) ctl.enqueue(leftover);
    },
    async pull(ctl) {
      const { value, done } = await reader.read();
      if (done) {
        await pumped.catch(() => {});
        const st = await child.status;
        console.error(
          `      reqBody=${reqBytes}B resp=${outBytes}B chunks=${chunks} ` +
            `status=${status} ttfb=${ttfb}ms total=${
              (performance.now() - t0).toFixed(1)
            }ms exit=${st.code}`,
        );
        ctl.close();
        return;
      }
      outBytes += value.byteLength;
      chunks++;
      // Timeline proof that bytes leave incrementally rather than in one buffered blob.
      if (chunks <= 3 || chunks % 200 === 0) {
        console.error(
          `      [stream] chunk#${chunks} +${value.byteLength}B ` +
            `cum=${outBytes}B t=${(performance.now() - t0).toFixed(1)}ms rss=${
              (process.memoryUsage().rss / 1048576).toFixed(1)
            }MB`,
        );
      }
      ctl.enqueue(value);
    },
    cancel() {
      reader.cancel();
      try {
        child.kill();
      } catch { /* already gone */ }
    },
  });

  return new Response(body, { status, headers });
});
console.error(`serving ${ROOT} on http://127.0.0.1:${PORT} auth=${REQUIRE_AUTH}`);
