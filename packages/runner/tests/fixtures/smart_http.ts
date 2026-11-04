// A git smart-HTTP origin over a local bare repo: what a test needs when the fetch under test
// must be an http one, the way the forge gateway's is (an `http.proxy` applies to nothing else).
// Upload-pack only, protocol v0, served from `<origin>/repo.git`; every other path goes to the
// caller's `routes`, so the same server can stand in for the gateway's JSON routes too.

import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { serve } from "@ryph/service";

export interface SmartHttpOrigin {
  /** The server, e.g. `http://127.0.0.1:1234`: what the gateway transport is told is its origin. */
  origin: string;
  /** The repo's URL on it. */
  url: string;
  shutdown(): Promise<void>;
}

/** Runs `git upload-pack --stateless-rpc` on `bare` with `input`, answering its stdout. */
function uploadPack(bare: string, args: string[], input: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["upload-pack", "--stateless-rpc", ...args, bare], {
      env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null" },
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on(
      "close",
      (code) =>
        code === 0
          ? resolve(new Uint8Array(Buffer.concat(chunks)))
          : reject(new Error(`upload-pack exited ${code}`)),
    );
    child.stdin.end(input);
  });
}

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;

export async function smartHttpOrigin(
  bare: string,
  routes: (req: Request, url: URL) => Response | null | Promise<Response | null> = () => null,
): Promise<SmartHttpOrigin> {
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/repo.git/info/refs") {
      if (url.searchParams.get("service") !== "git-upload-pack") {
        return new Response("upload-pack only", { status: 403 });
      }
      const refs = await uploadPack(bare, ["--advertise-refs"], new Uint8Array());
      const preamble = new TextEncoder().encode(`${pkt("# service=git-upload-pack\n")}0000`);
      return new Response(Buffer.concat([preamble, refs]), {
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      });
    }
    if (req.method === "POST" && url.pathname === "/repo.git/git-upload-pack") {
      let body = new Uint8Array(await req.arrayBuffer());
      if (req.headers.get("content-encoding") === "gzip") body = new Uint8Array(gunzipSync(body));
      return new Response(await uploadPack(bare, [], body), {
        headers: { "content-type": "application/x-git-upload-pack-result" },
      });
    }
    return (await routes(req, url)) ?? new Response("not found", { status: 404 });
  });
  const origin = `http://127.0.0.1:${server.addr.port}`;
  return { origin, url: `${origin}/repo.git`, shutdown: () => server.shutdown() };
}
