/**
 * The app's dev server, against a deployment's services — `./dev remote`.
 *
 * A laptop has no agents, no runs and no history, which is exactly what a frontend change needs to
 * be looked at. The deployment has all three, and the app is a BFF: the browser never reaches a
 * service, the app server does, over the handful of URLs its env names. So pointing those URLs at
 * port-forwards puts the local Vite server in front of the real deployment — SSR, the `/api/v1`
 * proxy, the session cookies and all — with nothing running on this machine but the app itself.
 *
 *   ./dev remote --context <kube context>
 *   ./dev remote --context <kube context> --namespace acme
 *
 * Nothing is deployed to make this work, and nothing is exposed: a port-forward is a tunnel
 * through the API server to the pod's own loopback, so what gates it is the RBAC on the
 * credentials this runs with, and the forwarded port exists only on this machine.
 *
 * THE WIRING IS READ, NOT WRITTEN HERE. The `app` Deployment in the services namespace already names
 * every service the app talks to, so this asks the cluster for its container env and rewrites each
 * `http://<service>.<namespace>.svc:<port>` value into the loopback port it forwards that service
 * on. A link added to the app tomorrow is picked up the day it is deployed; nothing in this file
 * lists services, and nothing here can drift from what actually runs.
 *
 * What is dropped rather than forwarded is in LOCAL_ONLY below. Everything else — the GitHub App's
 * public coordinates, the ingestion origin shown beside a webhook automation — is passed through
 * verbatim, because a deployment's answer is the right one: they describe the deployment, not this
 * process.
 *
 * This is the one verb that does not go through the tmux board. The forwards need a supervisor for
 * as long as the session lasts, and that is this process: it runs in the foreground, Ctrl-C takes
 * the forwards and the dev server down together, and `status`/`logs` know nothing about it. It is
 * a session you sit in, not a unit you converge.
 *
 * A port-forward is not held out by any NetworkPolicy (it arrives on the pod's own loopback), but
 * it IS the deployment's real database and real secrets. Everything done in this browser tab
 * happens to the deployment: a task created here launches a pod there, an agent edited here is
 * edited for everyone. It is a window onto production data, not a copy of it.
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { type Child, command } from "@ryph/process";
import { probe } from "../probe.ts";
import { units } from "../stack.ts";
import { taskArgv } from "../toolchain.ts";
import { dim, yellow } from "../ui.ts";

export interface RemoteOptions {
  /**
   * The kube context to forward through. Required, never kubectl's current context: a context that
   * silently changes underneath (`kind create cluster` switches it) points this at another cluster.
   */
  context: string;
  /** The services namespace whose `app` Deployment is read: a Helm release's, `ryph` by default. */
  namespace: string;
  /** Vite's port; its own default (and its own step-up when that is taken) otherwise. */
  port?: number;
  /** False holds the forwards open and prints the env for a dev server started by hand. */
  app: boolean;
}

/**
 * Env the deployment sets that describes the deployment's own front door rather than the app's
 * wiring, and would be wrong — or simply unused — in front of a Vite dev server.
 *
 * `PORT`, `ORIGIN` and the two address headers belong to adapter-node behind a load balancer;
 * Vite serves its own origin and sees the browser directly. The asset fallback exists so a pod
 * can serve a chunk from the OTHER build during a rollout, and a dev server builds every chunk it
 * is asked for — its credentials are in a Secret this never reads anyway.
 */
const LOCAL_ONLY = [
  "PORT",
  "ORIGIN",
  "ADDRESS_HEADER",
  "XFF_DEPTH",
  "KEEP_ALIVE_TIMEOUT",
  "HEADERS_TIMEOUT",
  "RYPH_ASSET_FALLBACK_URL",
  "RYPH_ASSET_BUCKET",
  "RYPH_ASSET_REGION",
];

/** kubectl's own chatter, which says nothing a person needs while the forward is working. */
const FORWARD_NOISE = /^(Forwarding from|Handling connection for)/;

interface Forward {
  service: string;
  remotePort: number;
  localPort: number;
  process?: Child;
}

const decoder = new TextDecoder();

export async function remote(opts: RemoteOptions): Promise<number> {
  const namespace = opts.namespace;
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)) {
    console.error(
      `--namespace must be a Kubernetes namespace name, got ${JSON.stringify(namespace)}`,
    );
    return 2;
  }
  const appUnit = units.find((u) => u.name === "app")!;

  const kubectl = async (args: string[]): Promise<string> => {
    const { code, stdout, stderr } = await command("kubectl", {
      args: ["--context", opts.context, ...args],
      stdin: "null",
    }).output();
    if (code !== 0) {
      throw new Error(`kubectl ${args.join(" ")}: ${decoder.decode(stderr).trim()}`);
    }
    return decoder.decode(stdout);
  };

  /** The app Deployment's container env, as name/value pairs it sets literally. */
  const deployedEnv = async (): Promise<[string, string][]> => {
    const deployment = JSON.parse(
      await kubectl(["-n", namespace, "get", "deploy", "app", "-o", "json"]),
    );
    const env: { name: string; value?: string }[] =
      deployment.spec.template.spec.containers[0].env ?? [];
    // A `valueFrom` entry is a Secret's, and its value is not in this object. None of them is
    // wiring — see LOCAL_ONLY — so they are dropped rather than looked up.
    return env.filter((e) => typeof e.value === "string").map((e) => [e.name, e.value!]);
  };

  /** An in-cluster service URL, as every one of the app's upstream variables is written. */
  const serviceUrl = new RegExp(`^http://([a-z0-9-]+)\\.${namespace}\\.svc:(\\d+)/*$`);

  const forwards: Forward[] = [];
  const env: Record<string, string> = {};
  const taken = new Set<number>();
  for (const [name, value] of await deployedEnv()) {
    if (LOCAL_ONLY.includes(name)) continue;
    const match = serviceUrl.exec(value);
    if (!match) {
      env[name] = value;
      continue;
    }
    const [, service, port] = match;
    const remotePort = Number(port);
    // Two variables can name one service on one port (two links that are the same listener);
    // one forward serves both.
    const existing = forwards.find((f) => f.service === service && f.remotePort === remotePort);
    const localPort = existing?.localPort ?? await freePort(remotePort, taken);
    if (!existing) forwards.push({ service, remotePort, localPort });
    env[name] = `http://127.0.0.1:${localPort}`;
  }

  if (forwards.length === 0) {
    console.error(
      `the app Deployment in namespace ${namespace} names no service URLs — is --namespace right?`,
    );
    return 1;
  }

  // A variable set here beats packages/app/.env, because Vite lets the real environment win over
  // a file. One a deployment does NOT set is the exception, and it is worth saying out loud: the
  // local file then decides it, and a stale `RYPH_…_URL=http://localhost:7411` in there sends that
  // one link to a port with nothing behind it while every other link talks to the cluster.
  const shadowed = (await readFile(`${appUnit.cwd}/.env`, "utf8").catch(() => ""))
    .split("\n")
    .map((line) => line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/)?.[1])
    .filter((name): name is string =>
      !!name && /^(RYPH_|PUBLIC_)/.test(name) && !(name in env) && !LOCAL_ONLY.includes(name)
    );
  if (shadowed.length > 0) {
    console.warn(
      yellow(
        `packages/app/.env sets ${shadowed.join(", ")}, which the deployment does not — ` +
          `those values are the local file's, not the cluster's.`,
      ),
    );
  }

  let shuttingDown = false;
  /** The dev server, once it is started; a signal can arrive before it is. */
  let app: Child | undefined = undefined;

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // The dev server as well as the forwards: a terminal's Ctrl-C reaches every child on its
    // own, but a SIGTERM from anywhere else does not, and a Vite left running against forwards
    // that are gone is worse than no dev server at all.
    for (const child of [...forwards.map((f) => f.process), app]) {
      try {
        child?.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
  };

  /**
   * Keeps one service forwarded for as long as this process runs. `kubectl port-forward` does
   * give up on its own — it has been seen exiting with code 1 seconds after the first requests
   * arrived, and a pod replaced by a rollout takes its forward with it — and a dev session
   * outliving a pod is the normal case, so an exit that is not ours is a reason to start again
   * rather than to stop. The restart is immediate: the gap is when an SSR fetch gets
   * ECONNREFUSED and the page 500s.
   *
   * Whatever kubectl said on the way out is printed. Suppressing it is how an exit becomes a
   * mystery — the message naming a deleted pod, an expired credential or a missing permission is
   * the whole diagnosis.
   */
  const forward = (f: Forward): Promise<void> => {
    // A forward that dies the moment it starts is not a hiccup — a wrong context, an expired
    // credential, a service that is not there — and restarting it instantly would spin. So an
    // exit within a few seconds of the last one backs off, and a forward that lived clears the
    // penalty.
    let backoff = 0;
    const spawn = async () => {
      const startedAt = Date.now();
      const child = await command("kubectl", {
        args: [
          "--context",
          opts.context,
          "-n",
          namespace,
          "port-forward",
          `svc/${f.service}`,
          `${f.localPort}:${f.remotePort}`,
        ],
        stdin: "null",
        stdout: "null",
        stderr: "piped",
      }).spawn();
      f.process = child;
      (async () => {
        for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) {
          for (const line of chunk.split("\n").map((l) => l.trim())) {
            if (line && !FORWARD_NOISE.test(line)) console.error(`  ${f.service}: ${line}`);
          }
        }
      })();
      child.status.then((status) => {
        if (shuttingDown) return;
        backoff = Date.now() - startedAt < 3000
          ? Math.min(backoff === 0 ? 500 : backoff * 2, 10_000)
          : 0;
        console.error(
          `  ${f.service}: forward exited (${status.code}), restarting` +
            (backoff > 0 ? ` in ${backoff}ms` : ""),
        );
        if (backoff === 0) void spawn();
        else setTimeout(spawn, backoff);
      });
    };
    return spawn();
  };

  console.log(
    `Forwarding ${forwards.length} services from ${namespace}` +
      ` on ${opts.context}:`,
  );
  for (const f of forwards) {
    await forward(f);
    console.log(`  ${f.service}:${f.remotePort} → 127.0.0.1:${f.localPort}`);
  }

  process.on("SIGINT", () => {
    shutdown();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(143);
  });

  try {
    await Promise.all(forwards.map((f) => awaitPort(f.localPort, f.service)));
  } catch (error) {
    shutdown();
    console.error(`${error instanceof Error ? error.message : error}`);
    return 1;
  }

  if (!opts.app) {
    // The forwards alone, for a dev server started by hand (`./dev up app`) or any other
    // client. Printed as an env file, because that is what packages/app/.env is.
    console.log(`\nReady. Paste into packages/app/.env, or export them:\n`);
    for (const [name, value] of Object.entries(env)) console.log(`${name}=${value}`);
    console.log(`\nCtrl-C to stop the forwards.`);
    await new Promise(() => {});
  }

  // The stack's own app, if it is up, holds Vite's default port; Vite steps to the next free one
  // and says which, but a tab left on :5173 is then looking at the LOCAL stack, which is the one
  // mistake this mode makes easy.
  if (opts.port === undefined && appUnit.port && (await probe(appUnit.port))) {
    console.log(
      yellow(
        `:${appUnit.port} is taken (\`./dev up app\`?) — Vite will pick the next free port; `,
      ) +
        dim("read its URL below, or pass --port"),
    );
  }

  // Vite over the forwards. The env goes to the child, not to a file: nothing is left behind to
  // be found later pointing at a deployment, and packages/app/.env keeps describing the local
  // stack. A variable set here wins over that file — Vite lets the real environment take
  // precedence. Through mise when it is installed, as the board's panes are (toolchain.ts).
  console.log(`\nStarting the app's dev server against ${namespace}. Ctrl-C to stop everything.\n`);
  const [bin, ...args] = await taskArgv(appUnit.task);
  app = await command(bin, {
    args: [...args, ...(opts.port === undefined ? [] : ["--port", String(opts.port)])],
    cwd: appUnit.cwd,
    env,
  }).spawn();
  const status = await app.status;
  shutdown();
  return status.code;
}

/**
 * A free loopback port for a service, offset from the port it serves in the cluster: the
 * historian's 7413 becomes 17413, so a forward is recognisable at a glance and a local stack on
 * the real ports (`./dev up`) is never in the way. Taken ports step up by one until one binds.
 */
async function freePort(remotePort: number, taken: Set<number>): Promise<number> {
  for (let port = remotePort + 10_000; port < 65_536; port++) {
    if (taken.has(port)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const listener = createServer();
      listener.once("error", () => resolve(false));
      listener.listen(port, "127.0.0.1", () => listener.close(() => resolve(true)));
    });
    if (free) {
      taken.add(port);
      return port;
    }
    // In use by something else on this machine; try the next.
  }
  throw new Error(`no free port for :${remotePort}`);
}

/** Waits until something accepts on a forwarded port, so the app never starts to a closed door. */
async function awaitPort(port: number, service: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await probe(port, 500)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${service} did not answer on 127.0.0.1:${port} within 30s`);
}
