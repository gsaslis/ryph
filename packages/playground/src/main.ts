/**
 * `bun run playground` — a whole ryph, seeded, on this machine or in a run's pod, for working on
 * the UI. See this package's README.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { parseArgs } from "@std/cli/parse-args";
import { join, resolve as resolvePath } from "@std/path";
import { backdate } from "./backdate.ts";
import { Context, RunPool, type State } from "./context.ts";
import { FIXTURES, PASSWORD, PEOPLE } from "./fixtures.ts";
import { fingerprint, PRESETS, resolve, type Resolved } from "./resolve.ts";
import {
  type App,
  layoutFor,
  mintProxySecret,
  portsFor,
  startApp,
  startHost,
  startMockChat,
  startMockGitlab,
  startMockModel,
} from "./stack.ts";

const MANIFEST_VERSION = 1;

interface Manifest {
  version: number;
  fingerprint: string;
  /** The seed names ports (the mock model's address is in a provider row), so it is reused only
   * at the same offset. */
  portOffset: number;
  seededAt: string;
  state: State;
}

const HELP = `bun run playground [up|seed|list|reset] [options]

  up      seed if needed, then serve the app and keep live runs going (default)
  seed    seed if needed and exit: for baking a seeded database into an image
  list    the fixtures and presets
  reset   delete the playground's data

  --preset <name>      starting set of fixtures (default: ui)
  --with a,b=N         add fixtures, or set one's number (history=40)
  --without a,b        remove fixtures
  --fresh              reseed even if the existing data matches
  --port-offset <n>    add n to every port, to run beside ./dev (default: 0)
  --name <name>        keep several playgrounds apart (default: default)
  --no-app             don't start the app's dev server
`;

const args = parseArgs(process.argv.slice(2), {
  string: ["preset", "with", "without", "port-offset", "name"],
  boolean: ["fresh", "help", "app"],
  default: { preset: "ui", name: "default", "port-offset": "0", app: true },
  negatable: ["app"],
});
const command = String(args._[0] ?? "up");
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

// Every call this process and its children make is to loopback. A setup step (and a run) can
// carry an egress proxy in HTTP(S)_PROXY, which must not see them.
for (const name of ["NO_PROXY", "no_proxy"]) {
  const listed = (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  process.env[name] = [...new Set([...listed, "localhost", "127.0.0.1", "::1"])].join(",");
}

const root = resolvePath(new URL("../../..", import.meta.url).pathname);
const layout = layoutFor(root, args.name);
const ports = portsFor(Number(args["port-offset"]));
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (command === "list") {
  console.log("Fixtures:");
  for (const f of FIXTURES) {
    const param = f.param ? `=N (${f.param.what}, default ${f.param.default})` : "";
    const needs = f.needs.length ? `  [needs ${f.needs.join(", ")}]` : "";
    console.log(
      `  ${(f.name + param).padEnd(34)} ${f.phase === "live" ? "live " : ""}${f.summary}${needs}`,
    );
  }
  console.log("\nPresets:");
  for (const [name, p] of Object.entries(PRESETS)) {
    console.log(
      `  ${name.padEnd(10)} ${p.summary}\n  ${"".padEnd(10)} ${p.fixtures.join(", ") || "(none)"}`,
    );
  }
  process.exit(0);
}
if (command === "reset") {
  await rm(layout.dir, { recursive: true }).catch(() => {});
  console.log(`removed ${layout.dir}`);
  process.exit(0);
}
if (command !== "up" && command !== "seed") {
  console.error(HELP);
  process.exit(2);
}

let resolved: Resolved[];
try {
  resolved = resolve(FIXTURES, args.preset, list(args.with), list(args.without));
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
const wanted = fingerprint(resolved, FIXTURES);
const fixture = (name: string) => FIXTURES.find((f) => f.name === name)!;

await refuseTakenPorts();

const existing = await readManifest();
const reuse = !args.fresh && existing?.version === MANIFEST_VERSION &&
  existing.fingerprint === wanted && existing.portOffset === Number(args["port-offset"]);
if (!reuse) {
  await rm(layout.dir, { recursive: true }).catch(() => {});
}
await mkdir(layout.work, { recursive: true });

const mock = await startMockModel(ports);
const chat = await startMockChat(layout, ports);
const gitlab = await startMockGitlab(ports);
const pool = new RunPool();
// One for the host and the app's dev server alike, across the host's restarts.
const proxySecret = mintProxySecret();
let host = await startHost(
  layout,
  ports,
  proxySecret,
  (runId, token) => pool.feed(runId, token),
  chat.urls,
  gitlab.url,
);
let app: App | null = null;
const ctx = new Context(
  layout,
  ports,
  pool,
  reuse ? existing!.state : { people: {}, repos: {}, agents: {} },
  chat,
  gitlab,
);
pool.adopt = (runId, token) => void ctx.adopt(runId, token);
ctx.setupToken = () => host.setupToken();

// Every way out stops the children: the host would otherwise outlive this process.
let stopping = false;
const stop = async (code: number, quiet = false) => {
  if (stopping) return;
  stopping = true;
  if (!quiet) console.log("\nstopping…");
  await ctx.stopLive().catch(() => {});
  await app?.stop().catch(() => {});
  await host.stop().catch(() => {});
  await mock.stop().catch(() => {});
  await chat.stop().catch(() => {});
  await gitlab.stop().catch(() => {});
  process.exit(code);
};
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

try {
  if (reuse) {
    console.log(`reusing the playground seeded ${existing!.seededAt} (${wanted || "nothing"})`);
  } else {
    await seed();
  }
  if (command === "seed") await stop(0, true);

  for (const r of resolved.filter((r) => fixture(r.name).phase === "live")) {
    await fixture(r.name).apply(ctx, r.param);
    console.log(`  ✓ ${r.name}`);
  }
  app = args.app ? await startApp(layout, ports, proxySecret, gitlab.url) : null;
  await banner();
  // Stable output marker for background_run's readyWhen, after seeding, live fixtures and
  // the HTTP readiness checks (including Vite when enabled), never for seed/list/reset.
  console.log("RYPH_PLAYGROUND_READY");
  host.exited.then(() => {
    if (stopping) return;
    console.error(`the host exited; see ${join(layout.logs, "host.log")}`);
    void stop(1);
  });
} catch (err) {
  console.error(err);
  await stop(1);
}

async function seed(): Promise<void> {
  const t0 = Date.now();
  for (const r of resolved.filter((r) => fixture(r.name).phase === "seed")) {
    const started = Date.now();
    await fixture(r.name).apply(ctx, r.param);
    const took = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ✓ ${r.name}${r.param === null ? "" : `=${r.param}`} (${took} s)`);
  }
  if (ctx.timeline.length > 0) {
    // Approved patches land through the host's own sweep; let it finish before stopping.
    await new Promise((r) => setTimeout(r, 3_000));
    await host.stop();
    await backdate(join(layout.home, "data"), ctx.timeline);
    console.log(`  ✓ moved ${ctx.timeline.length} runs into the past`);
    host = await startHost(
      layout,
      ports,
      proxySecret,
      (runId, token) => pool.feed(runId, token),
      chat.urls,
      gitlab.url,
    );
  }
  await writeManifest({
    version: MANIFEST_VERSION,
    fingerprint: wanted,
    portOffset: Number(args["port-offset"]),
    seededAt: new Date().toISOString(),
    state: ctx.state,
  });
  console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

async function banner() {
  const people = (Object.keys(ctx.state.people) as Array<keyof typeof PEOPLE>)
    .map((role) => `    ${role.padEnd(9)} ${PEOPLE[role].email}`);
  console.log(`
  ryph playground
    app            ${app ? `http://localhost:${ports.app}` : "(not started: --no-app)"}
    control plane  http://localhost:${ports.control}
    chat           ${chat.urls.viewer}  (mock Telegram, Zulip, Slack and Discord)
    gitlab         ${gitlab.url}  (a fake GitLab; signing in there is always @olivia)
    logs           ${layout.logs}
  ${
    people.length
      ? `sign in (password ${PASSWORD}):\n${people.join("\n")}`
      : `no accounts yet: claim it at http://localhost:${ports.app}/register?setup=${await host
        .setupToken()}`
  }
  Tasks started in the app are played by a scripted runner. Ctrl-C stops everything.
`);
}

async function readManifest(): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(layout.manifest, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

async function writeManifest(m: Manifest): Promise<void> {
  await writeFile(layout.manifest, JSON.stringify(m, null, 2) + "\n");
}

/** Says which port is taken before anything starts, rather than after a confusing failure. */
async function refuseTakenPorts(): Promise<void> {
  const needed = Object.entries(ports).filter(([k]) => args.app || k !== "app");
  // Both loopbacks: Vite binds `localhost`, which may be ::1, and another dev server there would
  // otherwise pass the app's readiness check in place of the one that failed to start.
  for (const [what, port] of needed) {
    try {
      for (const host of ["127.0.0.1", "::1"]) {
        const l = createServer();
        await new Promise<void>((resolve, reject) => {
          l.once("error", (err: NodeJS.ErrnoException) =>
            // A machine without IPv6 has no ::1 to hold.
            host === "::1" && err.code === "EADDRNOTAVAIL" ? resolve() : reject(err));
          l.listen(port, host, resolve);
        });
        if (l.listening) await new Promise((r) => l.close(r));
      }
    } catch {
      console.error(
        `port ${port} (${what}) is taken — stop what holds it (./dev down?), or pass --port-offset`,
      );
      process.exit(1);
    }
  }
}
