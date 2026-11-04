#!/usr/bin/env -S bun --no-env-file
/**
 * The chart's refusals that only a cluster can show — `bun run k8s:refusals --kube-context <ctx>
 * --throwaway=<ctx>`. `helm template` sees no cluster, so chart_test.ts cannot reach any of these:
 * each depends on what `lookup` finds. Against an installed release, with its own values, every
 * scenario is a `--dry-run=server` upgrade (or render) that must be refused, or pass, for the
 * right reason:
 *
 * 1. a supplied sealing key that differs from the one the cluster holds is refused;
 * 2. a chart Secret holding a sealing key that has gone missing makes the upgrade refuse to mint
 *    a new key (the Secret is deleted for the one render and put back straight after);
 * 3. a PriorityClass that another release owns is refused, naming it (its ownership annotation is
 *    changed for the one render and put back);
 * 4. a namespace-scoped installer — `admin` in the release's namespaces and nothing
 *    cluster-scoped — renders with `priorityClasses.create=false` and `namespaces.create=false`.
 *
 * Scenarios 2 and 3 change live objects for a moment, and 4 creates a ServiceAccount and
 * RoleBindings it deletes again. So the cluster must be a throwaway, and the script checks rather
 * than trusts it (throwaway.ts): a kind or k3d context whose API server is on loopback, named
 * twice (`--throwaway=<ctx>`), and a release on the dev state.
 *
 * Every change is undone from a backup on disk, never from memory alone: before an object is
 * changed, it is written to a 0600 file in a 0700 directory under $XDG_STATE_HOME/ryph/refusals
 * (~/.local/state/…), with the command that restores it printed. The backup is deleted only once
 * the object read back matches it. SIGINT, SIGTERM and SIGHUP restore before exiting; a restore
 * that keeps failing leaves its backup and command behind and exits non-zero, and the next run
 * refuses to start until that backup is gone.
 *
 * Flags:
 *   --kube-context <ctx>          required; every kubectl and helm call names it
 *   --throwaway=<ctx>             required, the same context again
 *   --release <name>              default `ryph`
 *   --release-namespace <ns>      default `ryph-system`
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseArgs } from "@std/cli/parse-args";
import { contextRefusal, releaseRefusal } from "./throwaway.ts";

const args = parseArgs(process.argv.slice(2).filter((a) => a !== "--"), {
  string: ["kube-context", "release", "release-namespace", "throwaway"],
  default: { release: "ryph", "release-namespace": "ryph-system" },
});
const CONTEXT = args["kube-context"];
const RELEASE = args.release;
const RELEASE_NS = args["release-namespace"];
const CHART = new URL("./ryph", import.meta.url).pathname;
const PROBE_SA = "ryph-refusals-probe";

/** Logging that survives a hangup: after SIGHUP a write to the terminal may throw. */
function say(line: string, err = false): void {
  try {
    (err ? console.error : console.log)(line);
  } catch {
    // The terminal is gone; the backups and the exit code still say what happened.
  }
}
function refuse(why: string): never {
  say(`refusing: ${why}`, true);
  process.exit(2);
}

if (!CONTEXT) refuse("--kube-context <ctx> is required");

interface Ran {
  ok: boolean;
  out: string;
  err: string;
}
/**
 * The children's environment: the operator's, minus every variable that could point kubectl or
 * helm somewhere other than `--context`/`--kube-context` says (HELM_KUBE*, HELM_NAMESPACE,
 * HELM_DRIVER*, KUBERNETES_*), with helm's release store pinned to Secrets and kuberc's aliases
 * and defaults off. As ryph-infra's scripts/lib/kube.ts `clusterEnv`.
 */
const childEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (/^(HELM_KUBE|HELM_DRIVER|KUBERNETES_)/.test(k) || k === "HELM_NAMESPACE") continue;
  childEnv[k] = v;
}
childEnv.HELM_DRIVER = "secret";
childEnv.KUBERC = "off";

/** A command, awaited, so a signal is handled while it runs. */
function run(cmd: string, argv: string[], input?: string): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ ok: false, out, err: `${err}${e.message}` }));
    child.on("close", (code) => resolve({ ok: code === 0, out, err }));
    child.stdin.end(input ?? "");
  });
}
const kubectlRaw = (argv: string[], input?: string) =>
  run("kubectl", ["--context", CONTEXT, ...argv], input);
async function kubectl(argv: string[], input?: string): Promise<string> {
  const r = await kubectlRaw(argv, input);
  if (!r.ok) throw new Error(`kubectl ${argv.join(" ")}: ${r.err.trim()}`);
  return r.out;
}
const helm = (argv: string[]) => run("helm", ["--kube-context", CONTEXT, ...argv]);

// ── is this a throwaway? Everything from the kubeconfig first: nothing is contacted until then.

const server = await run("kubectl", [
  "config",
  "view",
  "--minify",
  "--context",
  CONTEXT,
  "-o",
  "jsonpath={.clusters[0].cluster.server}",
]);
if (!server.ok) refuse(`no context ${CONTEXT} in the kubeconfig: ${server.err.trim()}`);
const notLocal = contextRefusal({
  context: CONTEXT,
  throwaway: args.throwaway,
  server: server.out,
});
if (notLocal) refuse(notLocal);

const computed = await helm(["get", "values", RELEASE, "-n", RELEASE_NS, "--all", "-o", "json"]);
if (!computed.ok) refuse(`helm get values ${RELEASE} -n ${RELEASE_NS}: ${computed.err.trim()}`);
const notDev = releaseRefusal(JSON.parse(computed.out));
if (notDev) refuse(notDev);

// ── backups: on disk before anything changes, gone only once the cluster matches them again.

const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
const backupRoot = join(stateHome, "ryph", "refusals", CONTEXT);
if (existsSync(backupRoot) && readdirSync(backupRoot).length > 0) {
  refuse(
    `an earlier run left backups in ${backupRoot}: restore them with the command each ` +
      "names (restore.txt beside it), then delete the directory",
  );
}
mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
for (const d of [join(stateHome, "ryph"), join(stateHome, "ryph", "refusals"), backupRoot]) {
  chmodSync(d, 0o700);
}

interface Restore {
  /** What is restored, for the log. */
  what: string;
  /** The backup file, and the command that restores by hand. */
  file: string;
  command: string;
  /** Puts it back; idempotent. */
  apply(): Promise<void>;
  /** Whether the cluster matches the backup again. */
  verify(): Promise<boolean>;
}
const pending: Restore[] = [];

/** Writes the backup (0600), prints how to restore it, and registers the restore. */
function backup(name: string, content: unknown, r: Omit<Restore, "file">): void {
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const file = join(backupRoot, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  writeFileSync(join(backupRoot, `${name}.restore.txt`), `${r.command}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  say(`    backup of ${r.what}: ${file}\n    restore by hand: ${r.command}`);
  pending.push({ ...r, file });
}

/** Sticky: once any restore has failed, the run exits 3, however it ends. */
let anyRestoreFailed = false;
let restoring: Promise<boolean> | null = null;
/** Every pending restore, retried; true when all came back. One run at a time. */
function restoreAll(): Promise<boolean> {
  restoring ??= (async () => {
    let allOk = true;
    while (pending.length > 0) {
      const r = pending[pending.length - 1]; // last changed, first restored
      let ok = false;
      let last = "";
      for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
        try {
          await r.apply();
          ok = await r.verify();
          if (!ok) last = "read back, it does not match the backup";
        } catch (e) {
          last = (e as Error).message;
        }
        if (!ok && attempt < 5) await Bun.sleep(2000);
      }
      pending.pop();
      if (ok) {
        rmSync(r.file, { force: true });
        rmSync(r.file.replace(/\.json$/, ".restore.txt"), { force: true });
        say(`    restored ${r.what}`);
      } else {
        allOk = false;
        anyRestoreFailed = true;
        say(
          `RESTORE FAILED for ${r.what} (${last.trim().slice(0, 300)}).\n` +
            `  The backup is ${r.file}\n  Restore it with: ${r.command}`,
          true,
        );
      }
    }
    // The directory itself goes when it is empty: a failed restore keeps its backup in it.
    if (allOk && existsSync(backupRoot) && readdirSync(backupRoot).length === 0) {
      rmSync(backupRoot, { recursive: true });
    }
    restoring = null;
    return allOk;
  })();
  return restoring;
}

// Changes to the cluster go one at a time, and the signal's restore queues behind the one in
// flight, so it never races a delete still on its way.
let interrupted = false;
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}
function change<T>(fn: () => Promise<T>): Promise<T> {
  return serial(() => {
    if (interrupted) throw new Error("interrupted: no further changes");
    if (anyRestoreFailed) throw new Error("a restore failed: no further changes");
    return fn();
  });
}

/** The temporary directory holding the release's values (secrets among them), once made. */
let tempDir: string | null = null;
function removeTempDir(): void {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    if (interrupted) {
      say(`${sig} again: still restoring, so as not to lose the backups' objects`, true);
      return;
    }
    interrupted = true;
    say(`\n${sig}: restoring what this run changed…`, true);
    void serial(restoreAll).then(() => {
      removeTempDir();
      process.exit(anyRestoreFailed ? 3 : 130);
    });
  });
}

// ── the scenarios

let failures = 0;
function check(what: string, ok: boolean, detail = ""): void {
  say(`  ${ok ? "✓" : "✗"} ${what}${ok ? "" : `  — ${detail.trim().slice(0, 400)}`}`);
  if (!ok) failures++;
}

// The release's own values, so every render below is the installed one plus one change.
const got = await helm(["get", "values", RELEASE, "-n", RELEASE_NS, "-o", "yaml"]);
if (!got.ok) refuse(`helm get values ${RELEASE} -n ${RELEASE_NS}: ${got.err.trim()}`);
const dir = mkdtempSync(join(tmpdir(), "ryph-refusals-"));
tempDir = dir;
const values = join(dir, "values.yaml");
writeFileSync(values, got.out, { mode: 0o600 });
const upgrade = (extra: string[]) =>
  helm([
    "upgrade",
    RELEASE,
    CHART,
    "-n",
    RELEASE_NS,
    "-f",
    values,
    "--dry-run=server",
    ...extra,
  ]);

// What the release has: its objects, to find the services namespace, the namespaces it uses and
// whether it owns the PriorityClasses.
const manifestText = (await helm(["get", "manifest", RELEASE, "-n", RELEASE_NS])).out;
// oxlint-disable-next-line typescript/no-explicit-any -- a parsed manifest, read field by field
const manifest = (Bun.YAML.parse(manifestText) as any[]).filter((o) => o?.kind);
const modelProxySecret = manifest.find((o) =>
  o.kind === "Secret" && o.metadata.name === "model-proxy"
);
const namespaces = [
  ...new Set([
    RELEASE_NS,
    ...manifest.map((o) => o.metadata.namespace).filter(Boolean),
    ...manifest.filter((o) => o.kind === "Namespace").map((o) => o.metadata.name),
  ]),
] as string[];
const ownsWorkloadClass = manifest.some((o) =>
  o.kind === "PriorityClass" && o.metadata.name === "ryph-workload"
);

// oxlint-disable-next-line typescript/no-explicit-any -- a Kubernetes object, compared by field
type Obj = any;
async function getJson(argv: string[]): Promise<Obj | null> {
  const r = await kubectlRaw([...argv, "-o", "json"]);
  if (r.ok) return JSON.parse(r.out);
  if (r.err.includes("NotFound")) return null;
  throw new Error(`kubectl ${argv.join(" ")}: ${r.err.trim()}`);
}
const meta = (o: Obj) => ({
  annotations: o?.metadata?.annotations ?? {},
  labels: o?.metadata?.labels ?? {},
});

say(`chart refusals on ${CONTEXT}: release ${RELEASE_NS}/${RELEASE} (backups: ${backupRoot})`);
try {
  const baseline = await upgrade([]);
  check("the release's own values upgrade (dry run)", baseline.ok, baseline.err);

  if (!modelProxySecret) {
    say("  - model-proxy uses an existingSecret: the sealing-key scenarios do not apply");
  } else {
    const servicesNs = modelProxySecret.metadata.namespace as string;
    const other = await upgrade([
      "--set",
      `secrets.internal.RYPH_SECRETS_KEY=${crypto.randomUUID().replaceAll("-", "").repeat(2)}`,
    ]);
    check(
      "a supplied sealing key that differs from the cluster's is refused",
      !other.ok &&
        other.err.includes("differs from the RYPH_SECRETS_KEY the cluster already holds"),
      other.ok ? "it rendered" : other.err,
    );

    await change(async () => {
      const saved = await getJson(["-n", servicesNs, "get", "secret", "model-proxy"]);
      if (!saved) throw new Error(`secret ${servicesNs}/model-proxy is not there to delete`);
      for (const k of ["resourceVersion", "uid", "creationTimestamp", "managedFields"]) {
        delete saved.metadata[k];
      }
      const name = `secret.${servicesNs}.model-proxy`;
      const matches = (o: Obj) =>
        o !== null && o.type === saved.type && isDeepStrictEqual(o.data ?? {}, saved.data ?? {}) &&
        isDeepStrictEqual(meta(o), meta(saved));
      backup(name, saved, {
        what: `Secret ${servicesNs}/model-proxy`,
        command: `kubectl --context ${CONTEXT} create -f ${join(backupRoot, `${name}.json`)}`,
        async apply() {
          if (await getJson(["-n", servicesNs, "get", "secret", "model-proxy"])) return;
          await kubectl(["create", "-f", "-"], JSON.stringify(saved));
        },
        async verify() {
          return matches(await getJson(["-n", servicesNs, "get", "secret", "model-proxy"]));
        },
      });
      await kubectl(["-n", servicesNs, "delete", "secret", "model-proxy"]);
    });
    try {
      // Empty: taken from the cluster, as for a chart-generated key.
      const lost = await upgrade(["--set", "secrets.internal.RYPH_SECRETS_KEY="]);
      check(
        "a chart Secret holding a sealing key gone missing: the upgrade refuses to mint one",
        !lost.ok && lost.err.includes("this upgrade would mint a new one"),
        lost.ok ? "it rendered" : lost.err,
      );
    } finally {
      await serial(restoreAll);
    }
  }

  if (!ownsWorkloadClass) {
    say("  - the release does not own the PriorityClasses: that scenario does not apply");
  } else {
    const key = "meta.helm.sh/release-name";
    await change(async () => {
      const saved = await getJson(["get", "priorityclass", "ryph-workload"]);
      if (!saved) throw new Error("priorityclass ryph-workload is not there");
      const before = meta(saved);
      const owner = before.annotations[key] as string | undefined;
      const name = "priorityclass.ryph-workload";
      backup(name, saved, {
        what: "PriorityClass ryph-workload's ownership annotation",
        command: `kubectl --context ${CONTEXT} annotate --overwrite priorityclass ryph-workload ` +
          (owner === undefined ? `${key}-` : `${key}=${owner}`),
        async apply() {
          await kubectl([
            "annotate",
            "--overwrite",
            "priorityclass",
            "ryph-workload",
            owner === undefined ? `${key}-` : `${key}=${owner}`,
          ]);
        },
        async verify() {
          const now = await getJson(["get", "priorityclass", "ryph-workload"]);
          return now !== null && isDeepStrictEqual(meta(now), before);
        },
      });
      await kubectl([
        "annotate",
        "--overwrite",
        "priorityclass",
        "ryph-workload",
        `${key}=refusals-other`,
      ]);
    });
    try {
      const taken = await upgrade([]);
      check(
        "a PriorityClass another release owns is refused, naming that release",
        !taken.ok && taken.err.includes("belongs to release") &&
          taken.err.includes("refusals-other"),
        taken.ok ? "it rendered" : taken.err,
      );
    } finally {
      await serial(restoreAll);
    }
  }

  // An installer that is `admin` in each of the release's namespaces and holds nothing
  // cluster-scoped: no PriorityClasses, no Namespaces, not even a read of kube-system. What it
  // creates is recorded first, so an interrupted run still deletes it, or says how.
  await change(async () => {
    const created = [
      { ns: RELEASE_NS, kind: "serviceaccount" },
      ...namespaces.map((ns) => ({ ns, kind: "rolebinding" })),
    ];
    const deletes = created.map(({ ns, kind }) =>
      `kubectl --context ${CONTEXT} -n ${ns} delete ${kind} ${PROBE_SA} --ignore-not-found`
    );
    backup("probe-installer", created, {
      what: `the probe installer ${PROBE_SA} (a ServiceAccount and its RoleBindings)`,
      command: deletes.join(" && "),
      async apply() {
        // RoleBindings first, then the ServiceAccount they name.
        for (const { ns, kind } of [...created].reverse()) {
          await kubectl(["-n", ns, "delete", kind, PROBE_SA, "--ignore-not-found"]);
        }
      },
      async verify() {
        for (const { ns, kind } of created) {
          if (await getJson(["-n", ns, "get", kind, PROBE_SA])) return false;
        }
        return true;
      },
    });
    await kubectl(["-n", RELEASE_NS, "create", "serviceaccount", PROBE_SA]);
    for (const ns of namespaces) {
      await kubectl([
        "-n",
        ns,
        "create",
        "rolebinding",
        PROBE_SA,
        "--clusterrole=admin",
        `--serviceaccount=${RELEASE_NS}:${PROBE_SA}`,
      ]);
    }
  });
  try {
    const scoped = await helm([
      "template",
      RELEASE,
      CHART,
      "-n",
      RELEASE_NS,
      "-f",
      values,
      "--set",
      "priorityClasses.create=false",
      "--set",
      "namespaces.create=false",
      "--dry-run=server",
      "--kube-as-user",
      `system:serviceaccount:${RELEASE_NS}:${PROBE_SA}`,
    ]);
    check(
      `a namespace-scoped installer (admin in ${namespaces.join(", ")}) renders`,
      scoped.ok,
      scoped.err,
    );
  } finally {
    await serial(restoreAll);
  }
} catch (e) {
  if (!interrupted) check("the run itself", false, (e as Error).message);
} finally {
  if (!interrupted) await serial(restoreAll);
  removeTempDir();
}

if (interrupted) await new Promise(() => {}); // the signal's restore exits
if (anyRestoreFailed) {
  say(`\nsome restores failed: the backups and their commands are in ${backupRoot}`, true);
  process.exit(3);
}
say(failures === 0 ? "\nall refusals held" : `\n${failures} checks failed`);
process.exit(failures === 0 ? 0 : 1);
