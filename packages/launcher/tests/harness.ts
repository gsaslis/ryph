// A real launcher over real HTTP on loopback, with a fake docker CLI behind every adapter: what
// the wire tests drive with the real clients.

import { serve, type ServeHandler } from "@ryph/service";
import {
  type CommandRunner,
  type Diagnostics,
  type DockerExec,
  launcherClients,
  type LaunchSpec,
} from "@ryph/orchestrator/docker";
import type { DockerToolCli } from "@ryph/mcp-gateway/tool-host";
import { type LauncherStartOptions, type RunningLauncher, startLauncher } from "../src/main.ts";
import { type FakeImage, inspectAnswer } from "../../orchestrator/tests/image_store.ts";

export const TOKEN = "run-token-for-tests-0000000000000000";
export const TOOLS_TOKEN = "tools-token-for-tests-00000000000000";

export const silent: Diagnostics = { debug() {}, warn() {} };

export const UNSIZED = {
  name: "unsized",
  cpu: null,
  memory: null,
  ephemeralStorage: null,
  workVolume: null,
};

export const SPEC: LaunchSpec = {
  runId: "r-1",
  image: "quay.io/ryph/ryph-agent:test",
  size: UNSIZED,
  env: { RYPH_RUN_ID: "r-1", RYPH_BOOTSTRAP_TOKEN: "single-use-secret" },
};

/**
 * A docker CLI that answers by the first argument that matches, and logs every call. The image
 * judgement's inspections are answered from `images` (none: every image a registry's, absent).
 */
export function fakeDocker(
  answer: (args: string[]) => string | Error | Promise<string> | undefined = () => "",
  images: FakeImage[] = [],
) {
  const calls: string[] = [];
  const exec: DockerExec = async (args) => {
    calls.push(args.join(" "));
    const inspected = inspectAnswer(images, args);
    if (inspected instanceof Error) throw inspected;
    if (inspected !== undefined) return inspected;
    const out = await answer(args);
    if (out instanceof Error) throw out;
    return out ?? "";
  };
  return { exec, calls };
}

/** A build's command runner whose image judgement is answered from `images` (none: every image
 * a registry's, absent), and everything else by `run`. */
export function storeRun(run: CommandRunner, images: FakeImage[] = []): CommandRunner {
  return (cmd, args, opts) => {
    const inspected = cmd === "docker" ? inspectAnswer(images, args) : undefined;
    if (inspected instanceof Error) {
      return Promise.resolve({ code: 1, stdout: "", stderr: inspected.message });
    }
    if (inspected !== undefined) return Promise.resolve({ code: 0, stdout: inspected, stderr: "" });
    return run(cmd, args, opts);
  };
}

/** A tool-host docker CLI the same way. */
export function fakeToolCli(answer: (args: string[]) => string | Error = () => "") {
  const calls: string[] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const cli: DockerToolCli = (args, env) => {
    calls.push(args.join(" "));
    envs.push(env);
    const out = answer(args);
    return out instanceof Error
      ? Promise.reject(out)
      : Promise.resolve({ stdout: out, stderr: "" });
  };
  return { cli, calls, envs };
}

export interface Started {
  launcher: RunningLauncher;
  clients: ReturnType<typeof launcherClients>;
  close(): Promise<void>;
}

/** A launcher on a free loopback port, and the run-side clients pointed at it. */
export async function started(
  opts: Partial<LauncherStartOptions> & { exec: DockerExec },
): Promise<Started> {
  const launcher = await startLauncher({
    token: TOKEN,
    toolsToken: TOOLS_TOKEN,
    docker: {},
    checks: true,
    environments: null,
    prefetch: null,
    tools: null,
    beatMs: 50,
    serve: (handler) => serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, handler),
    ...opts,
  });
  const clients = launcherClients({ url: launcher.url, token: TOKEN, stallMs: 2_000 }, silent);
  return {
    launcher,
    clients,
    close: () => launcher.close(),
  };
}

/**
 * A request body that never finishes: "{", then a space every 50 ms. Once the request is cut off
 * its stream is closed under it, so a tick that finds it so stops rather than throw — an enqueue
 * onto a closed stream throws on a timer, and bun pins that on whichever test is running then.
 */
export function trickle(): { body: ReadableStream<Uint8Array>; stop(): void } {
  const encoder = new TextEncoder();
  let tick: ReturnType<typeof setInterval> | undefined;
  const stop = () => clearInterval(tick);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("{"));
      tick = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(" "));
        } catch {
          stop();
        }
      }, 50);
    },
    cancel: stop,
  });
  return { body, stop };
}

/**
 * A loopback `serve` that counts the requests whose bodies the launcher has begun to read. It
 * reads one only once the request holds a body-read slot (routes.ts `acquire`), so `reading(n)`
 * is every one of `n` slots held — a condition to wait on rather than a guess at how long.
 */
export function bodyReads() {
  let count = 0;
  const waits: Array<{ n: number; wake: () => void }> = [];
  const began = () => {
    count++;
    for (const w of waits.filter((w) => count >= w.n)) {
      waits.splice(waits.indexOf(w), 1);
      w.wake();
    }
  };
  const watched = (req: Request): Request => {
    if (req.body === null) return req;
    const reader = req.body.getReader();
    let first = true;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (first) began();
        first = false;
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    }, { highWaterMark: 0 });
    return new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body,
      signal: req.signal,
      duplex: "half",
    } as RequestInit);
  };
  return {
    serve: (handler: ServeHandler) =>
      serve(
        { port: 0, hostname: "127.0.0.1", onListen: () => {} },
        (req, info) => handler(watched(req), info),
      ),
    reading: (n: number) =>
      count >= n ? Promise.resolve() : new Promise<void>((wake) => waits.push({ n, wake })),
  };
}

/** A raw request to the launcher, for what the clients would never send. */
export function raw(
  launcher: RunningLauncher,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<Response> {
  return fetch(`${launcher.url}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
