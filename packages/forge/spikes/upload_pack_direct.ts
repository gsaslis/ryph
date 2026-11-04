// Spike variant B: spawn `git upload-pack --stateless-rpc` directly, no CGI.
// Same instrumentation, hand-written routes.
import { command } from "@ryph/process";
import { serve } from "@ryph/service";

const ROOT = process.env.GIT_ROOT!;
const PORT = Number(process.env.PORT ?? "8176");

function pkt(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  const len = (b.length + 4).toString(16).padStart(4, "0");
  return new Uint8Array([...new TextEncoder().encode(len), ...b]);
}
const FLUSH = new TextEncoder().encode("0000");

// We must do this ourselves; http-backend got it for free via GIT_PROJECT_ROOT.
function resolveRepo(pathname: string): { dir: string; rest: string } | null {
  const m = /^\/([A-Za-z0-9._-]+\.git)(\/.*)$/.exec(pathname);
  if (!m) return null;
  if (m[1].includes("..")) return null;
  return { dir: `${ROOT}/${m[1]}`, rest: m[2] };
}

function gitEnv(req: Request): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  const p = req.headers.get("git-protocol");
  if (p && /^[0-9a-zA-Z:=.,_-]{1,100}$/.test(p)) env.GIT_PROTOCOL = p;
  return env;
}

function noCache(h: Headers) {
  h.set("cache-control", "no-cache, max-age=0, must-revalidate");
  h.set("pragma", "no-cache");
  h.set("expires", "Fri, 01 Jan 1980 00:00:00 GMT");
}

await serve({ port: PORT, hostname: "127.0.0.1" }, async (req) => {
  const url = new URL(req.url);
  const t0 = performance.now();
  const r = resolveRepo(url.pathname);
  if (!r) return new Response("not found\n", { status: 404 });

  // ---- GET /info/refs?service=git-upload-pack ----
  if (req.method === "GET" && r.rest === "/info/refs") {
    const svc = url.searchParams.get("service");
    // Read-only: only upload-pack is routable. receive-pack has no route at all.
    if (svc !== "git-upload-pack") {
      return new Response("service not enabled\n", { status: 403 });
    }
    const out = await command("git", {
      args: ["upload-pack", "--stateless-rpc", "--advertise-refs", r.dir],
      env: gitEnv(req),
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!out.success) {
      return new Response("upload-pack failed\n", { status: 500 });
    }
    // Hand-written smart-HTTP preamble that http-backend would have emitted.
    const body = new Uint8Array([
      ...pkt("# service=git-upload-pack\n"),
      ...FLUSH,
      ...out.stdout,
    ]);
    const h = new Headers({
      "content-type": "application/x-git-upload-pack-advertisement",
    });
    noCache(h);
    console.error(
      `[direct] GET info/refs proto=${req.headers.get("git-protocol")} ` +
        `resp=${body.length}B t=${(performance.now() - t0).toFixed(1)}ms`,
    );
    return new Response(body, { headers: h });
  }

  // ---- POST /git-upload-pack ----
  if (req.method === "POST" && r.rest === "/git-upload-pack") {
    const child = await command("git", {
      args: ["upload-pack", "--stateless-rpc", r.dir],
      env: gitEnv(req),
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();

    // We must inflate gzip ourselves -- http-backend did this for us.
    let src = req.body!;
    if (req.headers.get("content-encoding") === "gzip") {
      src = src.pipeThrough(new DecompressionStream("gzip"));
    }
    const pumped = src.pipeTo(child.stdin).catch(() => {});

    const h = new Headers({
      "content-type": "application/x-git-upload-pack-result",
    });
    noCache(h);
    console.error(
      `[direct] POST upload-pack framing=${
        req.headers.get("content-length") ?? req.headers.get("transfer-encoding")
      } enc=${req.headers.get("content-encoding")}`,
    );
    // stdout streams straight through; no header parsing needed at all.
    const body = child.stdout.pipeThrough(
      new TransformStream({
        flush: async () => {
          await pumped;
          await child.status;
        },
      }),
    );
    return new Response(body, { headers: h });
  }

  return new Response("not found\n", { status: 404 });
});
console.error(`[direct] serving ${ROOT} on http://127.0.0.1:${PORT}`);
