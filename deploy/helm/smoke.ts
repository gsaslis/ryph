#!/usr/bin/env -S bun --no-env-file
/**
 * The smoke check for a Helm install — `bun run k8s:smoke --kube-context <ctx>`.
 *
 * It needs no model key and no connected repository. Two parts:
 *
 * 1. Through the app, over a `kubectl port-forward` it opens itself: `/healthz` and `/readyz`,
 *    the first admin claimed with the setup token the control plane logged (or a login when the
 *    install is already claimed), and each service the app proxies answering (agents, automations,
 *    memory, MCP servers). The MCP catalogue must say hosting is available, and the tool guard
 *    must be Ready in the tools namespace: that is only true when the mcp-gateway's Role really
 *    lets it create a Deployment in a namespace it does not live in. The artifact thumbnail
 *    renderer, where the install has one, must be Ready.
 * 2. The network boundary, from the only place that can see it: pods in the runs namespace that
 *    carry a run's labels (and then a check suite's), its service account, runtime class and
 *    security context, so the NetworkPolicies select them exactly as they select a run. Each probe
 *    must be open or shut as the chart's networkpolicies.yaml says, and nothing else.
 *
 * Flags:
 *   --kube-context <ctx>     required; every kubectl call names it
 *   --namespace <ns>         the release's services namespace (default `ryph`, the chart's default
 *                            `namespaces.prefix`). The runs, tools and egress namespaces are read
 *                            off the control plane's and mcp-gateway's env, and the dev state's
 *                            (devState) off where its object store and database are.
 *   --unreachable host:port  repeatable: more addresses a run must NOT reach, e.g. your external
 *                            database or your API server's public address
 *   --probe-image <image>    what the probe pods run (default alpine:3.20; needs `nc`)
 *   --dev-credentials        claim or log in with the built-in placeholder admin below. They are
 *                            published in this repository, so only on a throwaway cluster.
 *
 * Otherwise RYPH_SMOKE_EMAIL and RYPH_SMOKE_PASSWORD (and RYPH_SMOKE_NAME) are required: the first
 * account registered on a fresh install becomes its only admin, and claiming it with a published
 * password would hand it to anyone who reads this file. RYPH_SMOKE_SETUP_TOKEN overrides the token
 * read from the log, for a log that has scrolled past it.
 */

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { parseArgs } from "@std/cli/parse-args";
import { parseSetupToken } from "../compose-networked/setup_token.ts";

const args = parseArgs(process.argv.slice(2).filter((a) => a !== "--"), {
  string: ["kube-context", "namespace", "unreachable", "probe-image"],
  boolean: ["dev-credentials"],
  collect: ["unreachable"],
  default: { namespace: "ryph", "probe-image": "alpine:3.20" },
});
const CONTEXT = args["kube-context"];
if (!CONTEXT) {
  console.error("--kube-context <ctx> is required: this check creates pods in that cluster");
  process.exit(2);
}
const NS = args.namespace;
const EXTRA_UNREACHABLE = (args.unreachable as string[]).filter(Boolean).map((hp): Probe => {
  const at = hp.lastIndexOf(":");
  const port = Number(hp.slice(at + 1));
  if (at <= 0 || !Number.isInteger(port)) {
    console.error(`--unreachable wants host:port, got ${JSON.stringify(hp)}`);
    process.exit(2);
  }
  return [hp.slice(0, at), port, false];
});

const smokeEmail = process.env.RYPH_SMOKE_EMAIL;
const smokePassword = process.env.RYPH_SMOKE_PASSWORD;
if (!args["dev-credentials"] && !(smokeEmail && smokePassword)) {
  console.error(
    "set RYPH_SMOKE_EMAIL and RYPH_SMOKE_PASSWORD (the admin to claim or log in as), or pass " +
      "--dev-credentials on a throwaway cluster: the built-in ones are published here.",
  );
  process.exit(2);
}
const ADMIN = {
  name: process.env.RYPH_SMOKE_NAME ?? "Chart Smoke",
  email: smokeEmail ?? "chart-smoke@ryph.local",
  password: smokePassword ?? "chart-smoke-password",
};

type Probe = [host: string, port: number, open: boolean];

function kubectl(argv: string[], input?: string): string {
  const r = spawnSync("kubectl", ["--context", CONTEXT!, ...argv], { encoding: "utf8", input });
  if (r.status !== 0) throw new Error(`kubectl ${argv.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

let failures = 0;
function check(what: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${ok ? "" : `  — ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A container's env as a map, off a Deployment in the services namespace. */
function envOf(deployment: string): Record<string, string> {
  const d = JSON.parse(kubectl(["-n", NS, "get", "deploy", deployment, "-o", "json"]));
  const container =
    d.spec.template.spec.containers.find((c: { name: string }) => c.name === deployment) ??
      d.spec.template.spec.containers[0];
  return Object.fromEntries(
    (container.env ?? []).filter((e: { value?: string }) => typeof e.value === "string")
      .map((e: { name: string; value: string }) => [e.name, e.value]),
  );
}

const cp = envOf("control-plane");
const RUNS_NS = cp.RYPH_K8S_NAMESPACE;
const RUN_SA = cp.RYPH_K8S_SERVICE_ACCOUNT;
const RUNTIME_CLASS = cp.RYPH_K8S_RUNTIME_CLASS;
const EGRESS_NS = cp.RYPH_EGRESS_PROXY_URL
  ? new URL(cp.RYPH_EGRESS_PROXY_URL).hostname.split(".")[1]
  : undefined;
const TOOLS_NS = envOf("mcp-gateway").RYPH_TOOL_HOST_NAMESPACE;
if (!RUNS_NS || !TOOLS_NS || !EGRESS_NS) {
  console.error(
    `the control plane and mcp-gateway in ${NS} do not name the runs, tools and egress ` +
      "namespaces (RYPH_K8S_NAMESPACE, RYPH_TOOL_HOST_NAMESPACE, RYPH_EGRESS_PROXY_URL): is this a " +
      "chart install, and is --namespace its services namespace?",
  );
  process.exit(2);
}
console.log(
  `chart smoke on ${CONTEXT}: services ${NS}, runs ${RUNS_NS}, tools ${TOOLS_NS}, egress ` +
    EGRESS_NS,
);

/** `kubectl port-forward` to a free local port, resolved once it says where. */
async function portForward(): Promise<{ url: string; stop: () => void }> {
  const child = spawn(
    "kubectl",
    ["--context", CONTEXT!, "-n", NS, "port-forward", "svc/app", ":3000"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout! });
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("port-forward never came up")), 30_000);
    lines.on("line", (line) => {
      const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(line);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("exit", (code) => reject(new Error(`port-forward exited ${code}`)));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

console.log("\nthe app and the services behind it");
const forward = await portForward();
const APP = forward.url;
try {
  for (const path of ["/healthz", "/readyz"]) {
    const res = await fetch(APP + path);
    await res.body?.cancel();
    check(`${path} → ${res.status}`, res.status === 200);
  }
  const setupToken = process.env.RYPH_SMOKE_SETUP_TOKEN ||
    parseSetupToken(kubectl(["-n", NS, "logs", "deploy/control-plane", "-c", "control-plane"]));
  // The app's ORIGIN, not the port-forward's: a write must name it, and its protocol names the
  // session cookie.
  const origin = kubectl([
    "-n",
    NS,
    "get",
    "deploy/app",
    "-o",
    'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="ORIGIN")].value}',
  ]).trim();
  const accessCookie = origin.startsWith("https:")
    ? "__Host-ryph_access_token"
    : "ryph_access_token";
  const headers = { "content-type": "application/json", origin };
  let res = await fetch(`${APP}/auth/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...ADMIN, ...(setupToken ? { setupToken } : {}) }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    res = await fetch(`${APP}/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
  }
  const access = res.headers.getSetCookie().find((c) => c.startsWith(`${accessCookie}=`));
  check(
    `register or log in (${res.status})`,
    !!access,
    `${(await res.text()).slice(0, 200)}. If the install already has an admin, set ` +
      "RYPH_SMOKE_EMAIL and RYPH_SMOKE_PASSWORD to theirs.",
  );
  const cookie = access?.split(";")[0] ?? "";
  const api = (path: string) => fetch(`${APP}/api${path}`, { headers: { cookie } });
  for (
    const [path, key] of [
      ["/v1/agents", "agents"],
      ["/v1/automations", "automations"],
      ["/v1/memories?limit=1", "memories"],
      ["/v1/mcp-servers", "mcpServers"],
    ] as const
  ) {
    const r = await api(path);
    const j = r.ok ? await r.json() as Record<string, unknown> : {};
    check(`${path} → ${r.status}`, r.ok && Array.isArray(j[key]), JSON.stringify(j).slice(0, 200));
  }
  // Hosting comes up after the gateway is ready: its lease, then the guard's image pull.
  let hosting = false;
  let reason = "";
  for (let i = 0; i < 60 && !hosting; i++) {
    const r = await api("/v1/mcp-catalogue");
    const j = r.ok ? await r.json() as { hostingAvailable?: boolean; reason?: string } : {};
    hosting = j.hostingAvailable === true;
    reason = j.reason ?? String(r.status);
    if (!hosting) await sleep(3000);
  }
  check("the MCP catalogue says hosting is available", hosting, reason);
  const guard = JSON.parse(
    kubectl(["-n", TOOLS_NS, "get", "deploy", "ryph-tool-guard", "-o", "json"]),
  );
  // The thumbnail renderer, where this install has one: it is Ready only once Chromium started
  // with its sandbox, which needs gVisor or the seccomp profile on the node.
  const thumbs = spawnSync("kubectl", [
    "--context",
    CONTEXT!,
    "-n",
    NS,
    "get",
    "deploy",
    "artifact-thumbnails",
    "-o",
    "json",
  ], { encoding: "utf8" });
  if (thumbs.status === 0) {
    const d = JSON.parse(thumbs.stdout);
    check(
      "the artifact thumbnail renderer is Ready",
      (d.status?.readyReplicas ?? 0) >= 1,
      "see `kubectl -n " + NS + " describe pod -l app.kubernetes.io/name=artifact-thumbnails`: " +
        "without gVisor its seccomp profile must be on every node (README.md, Requirements)",
    );
  }
  check(
    `the tool guard is Ready in ${TOOLS_NS}, with no API token`,
    (guard.status?.readyReplicas ?? 0) >= 1 &&
      guard.spec.template.spec.automountServiceAccountToken === false,
  );
} catch (err) {
  check("reach the app", false, String(err));
} finally {
  forward.stop();
}

const services = new Set(
  kubectl(["-n", NS, "get", "svc", "-o", "jsonpath={.items[*].metadata.name}"]).split(/\s+/),
);
const svc = (name: string, ns = NS) => `${name}.${ns}.svc`;
/** Probes of a service in the services namespace, only where this install has it. */
const ifThere = (probes: Array<[string, number, boolean]>): Probe[] =>
  probes.filter(([name]) => services.has(name)).map((
    [name, port, open],
  ) => [svc(name), port, open]);

/**
 * The namespace of the bundled dev state (values-dev.yaml), when there is one: read off where the
 * control plane's object store and database are, so `namespaces.state` or a prefix of any name is
 * followed rather than guessed. Undefined when both are outside the cluster.
 */
function devStateNamespace(): string | undefined {
  const inCluster = (url: string | undefined) => {
    if (!url) return undefined;
    try {
      const ns = /^[a-z0-9-]+\.([a-z0-9-]+)\.svc(\.|$)/.exec(new URL(url).hostname)?.[1];
      return ns && ns !== NS ? ns : undefined;
    } catch {
      return undefined;
    }
  };
  const fromS3 = inCluster(cp.RYPH_S3_ENDPOINT);
  if (fromS3) return fromS3;
  // The database URL is in the control plane's Secret, which this kubeconfig may not read.
  const secret = spawnSync("kubectl", [
    "--context",
    CONTEXT!,
    "-n",
    NS,
    "get",
    "secret",
    "control-plane",
    "-o",
    "jsonpath={.data.RYPH_DB}",
  ], { encoding: "utf8" });
  return secret.status === 0 && secret.stdout
    ? inCluster(Buffer.from(secret.stdout, "base64").toString())
    : undefined;
}

// The bundled dev state, when there is one: the database and the object store.
const stateNs = devStateNamespace();
if (stateNs) console.log(`dev state in ${stateNs}`);
const state: Probe[] =
  stateNs && spawnSync("kubectl", ["--context", CONTEXT, "get", "ns", stateNs]).status === 0
    ? kubectl([
      "-n",
      stateNs,
      "get",
      "svc",
      "-o",
      'jsonpath={range .items[*]}{.metadata.name} {.spec.ports[0].port}{"\\n"}{end}',
    ])
      .trim().split("\n").filter(Boolean).map((line) => {
        const [name, port] = line.split(" ");
        return [svc(name, stateNs), Number(port), false];
      })
    : [];
const outside: Probe[] = [
  ["kubernetes.default.svc", 443, false],
  ["1.1.1.1", 443, false],
  ["example.com", 443, false],
  ["169.254.169.254", 80, false],
  ...EXTRA_UNREACHABLE,
];

const runProbes: Probe[] = [
  ...ifThere([
    ["control-plane", 7411, true],
    ["historian", 7413, true],
    ["forge", 7412, true],
    ["model-proxy", 7420, true],
    ["mcp-gateway", 7430, true],
    ["previews", 7491, true],
    ["automations", 7414, false],
    ["memory", 7440, false],
    ["chat", 7450, false],
    ["web", 7480, false],
    ["model-proxy", 7421, false],
    ["mcp-gateway", 7431, false],
    ["app", 3000, false],
    ["previews", 7490, false],
    // The control plane's port: a run flooding it could lock the control plane out.
    ["previews", 7493, false],
    ["artifact-thumbnails", 7491, false],
    ["radicle", 7470, false],
  ]),
  [svc("egress-proxy", EGRESS_NS), 7460, true],
  [svc("ryph-tool-guard", TOOLS_NS), 8080, false],
  // With several previews replicas, an ordinal's own Service: a run dials its owner's tunnel
  // there, and never reaches its peer or API listener.
  ...(services.has("previews-0")
    ? [
      [svc("previews-0"), 7491, true],
      [svc("previews-0"), 7492, false],
      [svc("previews-0"), 7493, false],
    ] as Probe[]
    : []),
  ...state,
  ...outside,
];
const checkProbes: Probe[] = [
  ...ifThere([
    ["forge", 7412, true],
    ["control-plane", 7411, false],
    ["historian", 7413, false],
    ["model-proxy", 7420, false],
    ["mcp-gateway", 7430, false],
    ["previews", 7491, false],
    ["previews", 7493, false],
  ]),
  [svc("egress-proxy", EGRESS_NS), 7460, true],
  ...state,
  ...outside,
];

function probe(component: string, probes: Probe[]): void {
  const name = `chart-smoke-${component}-${Math.random().toString(36).slice(2, 7)}`;
  // Settle first: a policy controller may program a new pod's rules a few seconds late (k3s's
  // kube-router does), and the verdict is about the rules, not that window. Then one attempt each.
  const script = "sleep 8; " +
    probes.map(([h, p]) =>
      `if nc -z -w 3 ${h} ${p} 2>/dev/null; then echo "OPEN ${h}:${p}"; else echo "SHUT ${h}:${p}"; fi`
    ).join("; ");
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: RUNS_NS,
      labels: { "app.kubernetes.io/component": component },
    },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...(RUN_SA ? { serviceAccountName: RUN_SA } : {}),
      ...(RUNTIME_CLASS ? { runtimeClassName: RUNTIME_CLASS } : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1994,
        runAsGroup: 1994,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [{
        name: "probe",
        image: args["probe-image"],
        command: ["sh", "-c", script],
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
      }],
    },
  };
  kubectl(["apply", "-f", "-"], JSON.stringify(pod));
  try {
    // A sandboxed runtime may wait for a node of its own first.
    for (let i = 0; i < 300; i++) {
      const phase = kubectl(["-n", RUNS_NS, "get", "pod", name, "-o", "jsonpath={.status.phase}"])
        .trim();
      if (phase === "Succeeded" || phase === "Failed") break;
      spawnSync("sleep", ["2"]);
    }
    const out = kubectl(["-n", RUNS_NS, "logs", name]);
    for (const [h, p, want] of probes) {
      const open = out.includes(`OPEN ${h}:${p}`);
      const shut = out.includes(`SHUT ${h}:${p}`);
      check(
        `${component} ${want ? "reaches" : "cannot reach"} ${h}:${p}`,
        (open || shut) && open === want,
        open ? "open" : shut ? "shut" : "no result",
      );
    }
  } finally {
    kubectl(["-n", RUNS_NS, "delete", "pod", name, "--wait=false"]);
  }
}

console.log(`\nthe network boundary, from a pod with a run's labels in ${RUNS_NS}`);
probe("agent-run", runProbes);
console.log("\nfrom a pod with a check suite's labels");
probe("check-run", checkProbes);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} checks failed`);
process.exit(failures === 0 ? 0 : 1);
