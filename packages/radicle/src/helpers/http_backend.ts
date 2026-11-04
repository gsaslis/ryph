// Smart-HTTP git serving by spawning `git upload-pack --stateless-rpc` DIRECTLY — no CGI.
//
// DUPLICATED from @ryph/forge's helpers/http_backend.ts, which is where every non-obvious line
// below was paid for against real git (see that package's docs/git-gateway.md). The bridge may
// not import the forge, and this is the file both ends of that seam need.
//
// Why direct and not `git http-backend`: it makes read-only STRUCTURAL. receive-pack has no
// route at all, rather than being switched off by a config flag that has to stay correct.
// The price is that http-backend's freebies are re-implemented here: gzip inflation, the
// pkt-line preamble — and above all its 10 MiB request-body cap, which going direct forfeits.
//
// THE CAP IS LOAD-BEARING. Measured: the same 30 MB request http-backend refused,
// `upload-pack --stateless-rpc` swallowed whole and answered with a 200 MB pack. And it must
// reject WHILE STREAMING — buffer-then-check *is* the DoS. An upload-pack body is bounded by
// ref count (50 B/ref, chunked framing above ~21k refs), so the cap is a property of repos we
// choose to serve: the default 10 MiB matches http-backend and breaks only above ~209k refs.
//
// This file spawns git RAW instead of through ports/rad.ts for exactly one reason:
// upload-pack must stream (stdin pumped concurrently with stdout, backpressure intact), and
// makeGit buffers to completion. The invariants git_exec exists for are kept another way:
// `clearEnv: true` plus the explicit env below — no config, no prompt, no credential can
// reach the child. upload-pack itself never dials out, so there is nothing to prompt for.
//
// Gotchas encoded below, all hit for real:
// - GIT_PROTOCOL must be passed through (sanitized) or every client silently downgrades to
//   protocol v0 — an 11,000× advertisement regression that throws no error
// - request bodies arrive gzipped under Content-Length framing; inflate before the child
// - pump stdin concurrently with draining stdout, or large responses deadlock; catch the
//   pump's rejection, or an early upload-pack death takes the process down
// - once the streaming Response is returned, failure can no longer be signalled — a tripped
//   cap kills the child and the client sees a cut stream, which is the best git's own
//   protocol allows

import { command } from "@ryph/process";

/** The slice of Diagnostics this helper needs, declared locally (helpers never reach ports). */
export interface BackendTracer {
  debug(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

function pkt(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  const len = (b.length + 4).toString(16).padStart(4, "0");
  const out = new Uint8Array(4 + b.length);
  out.set(new TextEncoder().encode(len));
  out.set(b, 4);
  return out;
}
const FLUSH = new TextEncoder().encode("0000");

/** The child's entire environment: hermetic (no user/system config, no ambient GIT_CONFIG_*
 * injection), non-interactive, and carrying the client's protocol wish — sanitized, because a
 * header is attacker-shaped and this becomes an env var. */
function gitEnv(gitProtocol: string | null): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // Apple's git also loads a config file compiled into the binary, at scope `unknown`, which
    // GIT_CONFIG_SYSTEM does not reach. Kept in step with adapters/rad/cli.ts.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (gitProtocol && /^[0-9a-zA-Z:=.,_-]{1,100}$/.test(gitProtocol)) {
    env.GIT_PROTOCOL = gitProtocol;
  }
  return env;
}

function noCache(h: Headers) {
  h.set("cache-control", "no-cache, max-age=0, must-revalidate");
  h.set("pragma", "no-cache");
  h.set("expires", "Fri, 01 Jan 1980 00:00:00 GMT");
}

/**
 * GET …/info/refs?service=git-upload-pack — the ref advertisement.
 * The caller has already authenticated and resolved `repoDir`, and refused any other service.
 */
export async function advertiseRefs(
  repoDir: string,
  gitProtocol: string | null,
  diag: BackendTracer,
): Promise<Response> {
  const started = performance.now();
  const out = await command("git", {
    args: ["upload-pack", "--stateless-rpc", "--advertise-refs", repoDir],
    env: gitEnv(gitProtocol),
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    diag.warn("git.advertise_failed", {
      repoDir,
      code: out.code,
      err: new TextDecoder().decode(out.stderr).slice(0, 500),
    });
    return new Response("upload-pack failed\n", { status: 500 });
  }
  // The smart-HTTP preamble http-backend would have emitted.
  const preamble = pkt("# service=git-upload-pack\n");
  const body = new Uint8Array(preamble.length + FLUSH.length + out.stdout.length);
  body.set(preamble);
  body.set(FLUSH, preamble.length);
  body.set(out.stdout, preamble.length + FLUSH.length);
  const headers = new Headers({
    "content-type": "application/x-git-upload-pack-advertisement",
  });
  noCache(headers);
  diag.debug("git.advertise", {
    repoDir,
    proto: gitProtocol,
    bytes: body.length,
    ms: Math.round(performance.now() - started),
  });
  return new Response(body, { headers });
}

/** Counts bytes through, erroring the stream the moment `limit` is exceeded — the reject-
 * while-streaming discipline. The error carries a recognizable name for the pump's catch.
 * Exported: bundle intake meters its uploads through this same cap. */
export function byteCap(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        const err = new Error(`request body exceeds ${limit} bytes`);
        err.name = "BodyCapExceeded";
        controller.error(err);
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

export interface UploadPackOptions {
  /** Hard cap on the (inflated) request body. Applied while streaming, never buffer-then-check. */
  maxRequestBytes: number;
  diag: BackendTracer;
}

/**
 * POST …/git-upload-pack — the fetch negotiation and pack stream.
 * The caller has already authenticated and resolved `repoDir`.
 */
export async function uploadPack(
  repoDir: string,
  req: Request,
  opts: UploadPackOptions,
): Promise<Response> {
  const { diag } = opts;

  // Content-Length framing gets a clean 413 before any work. This is a fast path, not the
  // defense: chunked bodies carry no length, and gzip can hide size — the streaming cap below
  // is what actually holds the line.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > opts.maxRequestBytes) {
    return new Response("request body too large\n", { status: 413 });
  }

  const child = await command("git", {
    args: ["upload-pack", "--stateless-rpc", repoDir],
    env: gitEnv(req.headers.get("git-protocol")),
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();

  // Inflate gzip ourselves (http-backend did this for us), then meter the INFLATED bytes —
  // capping the compressed size would let a small gzip smuggle an arbitrarily large body.
  let src: ReadableStream<Uint8Array> = req.body ??
    new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  if (req.headers.get("content-encoding") === "gzip") {
    // DecompressionStream is typed to accept any BufferSource on its writable side;
    // narrowing to bytes-in/bytes-out is safe (only bytes are ever written) but needs saying.
    src = src.pipeThrough(
      new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
  }
  src = src.pipeThrough(byteCap(opts.maxRequestBytes));

  // Pump stdin concurrently with draining stdout — awaiting the body first deadlocks on large
  // responses. The catch is mandatory twice over: an early upload-pack death rejects the pump
  // (normal, git closed stdin), and a tripped cap rejects it too — that one kills the child,
  // which is the only failure signal left once the 200 below has streamed its first byte.
  const pumped = src.pipeTo(child.stdin).catch((err) => {
    if (err instanceof Error && err.name === "BodyCapExceeded") {
      diag.warn("git.upload_pack.body_capped", { repoDir, limit: opts.maxRequestBytes });
      try {
        child.kill();
      } catch {
        // already exited — nothing to cut short
      }
    }
  });

  const headers = new Headers({
    "content-type": "application/x-git-upload-pack-result",
  });
  noCache(headers);
  diag.debug("git.upload_pack", {
    repoDir,
    framing: req.headers.get("content-length") ?? req.headers.get("transfer-encoding"),
    encoding: req.headers.get("content-encoding"),
  });
  // stdout streams straight through with real backpressure; flush holds the response open
  // until both the pump and the child have fully settled, so nothing leaks.
  const body = child.stdout.pipeThrough(
    new TransformStream({
      flush: async () => {
        await pumped;
        await child.status;
      },
    }),
  );
  return new Response(body, { headers });
}
