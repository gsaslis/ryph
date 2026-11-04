// The chart's invariants, asserted on what `helm template` renders: the namespace model (two
// releases share nothing namespaced and no cluster-scoped object but the PriorityClasses one of
// them owns), the network boundary (a run reaches no address, a thumbnail renderer nothing at all,
// each knob lands on the rules it names and no other), the Secret contract, string-typed env, and
// the migrations each workload runs before it starts.
//
// Needs `helm` on PATH; skipped without it, except under CI (`CI` set), where a missing helm
// fails instead of passing for a checked chart.
// Rendered manifests are asserted at runtime below, not trusted as typed API input.
/* oxlint-disable typescript/no-explicit-any */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
// The names the services put on their pods, from the code that puts them there: the chart must
// declare exactly these, or a run, a placeholder or a tool server is refused admission.
import {
  RESERVE_RUNGS,
  reservePriorityClass,
  WORKLOAD_PRIORITY_CLASS,
} from "../../packages/orchestrator/src/adapters/provisioner/kubernetes.ts";
import { TOOL_HOST_PRIORITY_CLASS } from "../../packages/mcp-gateway/src/adapters/tool_host/kubernetes.ts";

const CHART = new URL("./ryph", import.meta.url).pathname;
const DEV_VALUES = `${CHART}/values-dev.yaml`;
/** The tag every image defaults to: a release's `0.1.0`, or a commit's `sha-<12>` before one. */
const APP_VERSION =
  readFileSync(`${CHART}/Chart.yaml`, "utf8").match(/^appVersion:\s*"([^"]+)"/m)![1];
const hasHelm = spawnSync("helm", ["version", "--short"]).status === 0;

/**
 * `helm template` sees no cluster, so the chart refuses to mint an internal credential unless told
 * the render is throwaway. Every render below that is not about that refusal says so.
 */
const MINT = ["--set", "secrets.allowNewSealingKeys=true"];

/** A minimal production-shaped install: external Postgres and object store, nothing else. */
const PROD = [
  ...MINT,
  "--set",
  "postgres.host=db.example.internal",
  "--set",
  "postgres.user=ryph",
  "--set",
  "postgres.password=p@ss word",
  "--set",
  "postgres.params=sslmode=require",
  "--set",
  "objectStore.endpoint=https://s3.example.com",
  "--set",
  "objectStore.accessKeyId=AKIAEXAMPLE",
  "--set",
  "objectStore.secretAccessKey=secret",
];

function helm(args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("helm", ["template", "ryph", CHART, "--namespace", "ryph-system", ...args], {
    encoding: "utf8",
  });
  return { ok: r.status === 0, out: r.stdout, err: r.stderr };
}

function render(args: string[]): { text: string; objects: any[] } {
  const r = helm(args);
  if (!r.ok) throw new Error(`helm template failed: ${r.err}`);
  const parsed = Bun.YAML.parse(r.out) as any;
  const objects = (Array.isArray(parsed) ? parsed : [parsed]).filter((o: any) => o && o.kind);
  return { text: r.out, objects };
}

const find = (objects: any[], kind: string, name: string, namespace?: string) =>
  objects.find((o) =>
    o.kind === kind && o.metadata.name === name &&
    (namespace === undefined || o.metadata.namespace === namespace)
  );

const roles = ["", "-runs", "-tools", "-builds", "-egress"];
const nsOf = (prefix: string) => roles.map((r) => prefix + r);

/** Every namespace a rendered object names: its own, RoleBinding subjects, namespace selectors,
 * cluster-DNS URLs, and env values that ARE a namespace. */
function namespacesNamed(objects: any[]): Set<string> {
  const out = new Set<string>();
  const walk = (v: any): void => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x));
    if (v && typeof v === "object") {
      if (typeof v["kubernetes.io/metadata.name"] === "string") {
        out.add(v["kubernetes.io/metadata.name"]);
      }
      if (typeof v.name === "string" && typeof v.value === "string" && /NAMESPACE$/.test(v.name)) {
        out.add(v.value);
      }
      for (const x of Object.values(v)) walk(x);
      return;
    }
    if (typeof v === "string") {
      for (const m of v.matchAll(/\/\/[a-z0-9-]+\.([a-z0-9-]+)\.svc\b/g)) out.add(m[1]);
    }
  };
  for (const o of objects) {
    if (o.metadata?.namespace) out.add(o.metadata.namespace);
    if (o.kind === "Namespace") out.add(o.metadata.name);
    for (const s of o.subjects ?? []) if (s.namespace) out.add(s.namespace);
    walk(o.spec);
    walk(o.data);
  }
  return out;
}

const podSpecs = (objects: any[]) =>
  objects.filter((o) => ["Deployment", "StatefulSet", "Job"].includes(o.kind))
    .map((o) => ({ owner: o, spec: o.spec.template.spec }));

const PRIVATE = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "169.254.0.0/16",
];

if (!hasHelm && process.env.CI) {
  test("helm is on PATH", () => {
    throw new Error("helm is not on PATH, and CI is set: the chart would go unchecked");
  });
}

describe.skipIf(!hasHelm)("ryph chart", () => {
  test("renders with dev values and with production-shaped values", () => {
    expect(render(["-f", DEV_VALUES]).objects.length).toBeGreaterThan(90);
    expect(render(PROD).objects.length).toBeGreaterThan(80);
  });

  test("the laptop values fit a laptop, and thumbnails come on only with the kind profile", () => {
    const KIND_VALUES = `${CHART}/values-kind.yaml`;
    const { objects } = render(["-f", DEV_VALUES, "-f", KIND_VALUES]);
    const gib = (v = "0") => {
      const m = /^([0-9.]+)(Mi|Gi)?$/.exec(v)!;
      return Number(m[1]) / (m[2] === "Mi" ? 1024 : 1);
    };
    let memory = 0;
    for (const { owner, spec } of podSpecs(objects)) {
      const containers = [
        ...spec.containers,
        ...(spec.initContainers ?? []).filter((c: any) => c.restartPolicy === "Always"),
      ];
      memory += (owner.spec.replicas ?? 1) *
        containers.reduce((a: number, c: any) => a + gib(c.resources?.requests?.memory), 0);
    }
    // README.md, "Quick start on kind", says about 3 GiB; Docker Desktop's default is 8.
    expect(memory).toBeLessThan(3.5);
    const thumbs = find(objects, "Deployment", "artifact-thumbnails");
    expect(thumbs.spec.template.spec.securityContext.seccompProfile).toEqual({
      type: "Localhost",
      localhostProfile: "ryph/thumbnail.json",
    });
    expect(find(render(["-f", DEV_VALUES]).objects, "Deployment", "artifact-thumbnails"))
      .toBeUndefined();
  });

  test("helm lint --strict passes: the required values alone, the laptop values, everything on", () => {
    const MAX = [
      ...PROD,
      "--set",
      "previews.enabled=true",
      "--set",
      "previews.domain=preview.example.net",
      "--set",
      "radicle.enabled=true",
      "--set",
      "github.enabled=true",
      "--set",
      "github.appName=app",
      "--set",
      "github.clientId=cid",
      "--set",
      "github.privateKeySecret=gh-key",
      "--set",
      "gitlab.enabled=true",
      "--set",
      "gitlab.url=https://git.example.com/gitlab",
      "--set",
      "gitlab.tokenSecret=gl-token",
      "--set",
      "gitlab.webhookSecret=hook-master",
      "--set",
      "gitlab.clientId=gl-cid",
      "--set",
      "gitlab.clientSecret=gl-csecret",
      "--set",
      "gitlab.group=acme/eng",
      "--set",
      "environments.enabled=true",
      "--set",
      "runs.runtimeClassName=gvisor",
      "--set",
      "checks.enabled=true",
      "--set",
      "runs.services=true",
      "--set",
      "runs.browserSidecar=true",
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.host=ryph.example.com",
      "--set",
      "httpRoute.enabled=true",
      "--set-json",
      'httpRoute.parentRefs=[{"name":"gw","namespace":"gw"}]',
    ];
    for (const args of [PROD, ["-f", DEV_VALUES], MAX]) {
      const r = spawnSync("helm", [
        "lint",
        "--strict",
        CHART,
        "--namespace",
        "ryph-system",
        ...args,
      ], {
        encoding: "utf8",
      });
      expect(`${r.stdout}${r.stderr}`).toContain("0 chart(s) failed");
    }
  });

  test("refuses to render without a database or an object store", () => {
    const r = helm(MINT);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("postgres.host");
    const s3 = helm(PROD.filter((a) => !a.startsWith("objectStore.endpoint")).slice(0, 8));
    expect(s3.ok).toBe(false);
    expect(s3.err).toContain("objectStore.endpoint");
  });

  test("refuses a previews domain on the app's registrable domain", () => {
    const previews = (appUrl: string, domain: string, ...more: string[]) =>
      helm([
        ...PROD,
        "--set",
        `appUrl=${appUrl}`,
        "--set",
        "previews.enabled=true",
        "--set",
        `previews.domain=${domain}`,
        ...more,
      ]);
    // Same site as the app: a page an agent wrote could set cookies the app reads.
    for (
      const [appUrl, domain] of [
        ["https://ryph.example.com", "preview.ryph.example.com"],
        ["https://ryph.example.com", "preview.example.com"],
        ["https://example.com", "PREVIEW.Example.COM."],
        ["https://app.acme.co.uk", "preview.acme.co.uk"],
      ]
    ) {
      const r = previews(appUrl, domain);
      expect(r.ok, `${appUrl} ${domain}`).toBe(false);
      expect(r.err).toContain("is on the app's registrable domain");
    }
    // Where a cookieless link is sent counts as the app too.
    const sent = previews(
      "https://ryph.example.com",
      "preview.example.net",
      "--set",
      "previews.appUrl=https://ryph.example.net",
    );
    expect(sent.ok).toBe(false);
    expect(sent.err).toContain("from https://ryph.example.net");
    // A domain of its own renders, a known multi-label public suffix included.
    for (
      const [appUrl, domain] of [
        ["https://ryph.example.com", "preview.example.net"],
        ["https://app.acme.co.uk", "preview.other.co.uk"],
        ["http://localhost:3000", "preview.localhost"],
      ]
    ) {
      expect(previews(appUrl, domain).ok, `${appUrl} ${domain}`).toBe(true);
    }
  });

  test("refuses a release namespace the chart would create", () => {
    const r = spawnSync("helm", ["template", "ryph", CHART, "-n", "ryph", ...PROD], {
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("namespaces.services");
    // Created or not: the release records hold every chart-created Secret, and must not sit in a
    // namespace a run, a tool server or a build lives in.
    for (
      const [ns, role] of [["ryph-runs", "runs"], ["ryph-tools", "tools"], ["ryph", "services"]]
    ) {
      const r = helm(["-n", ns, ...PROD, "--set", "namespaces.create=false"]);
      expect(r.ok).toBe(false);
      expect(r.err).toContain(`(namespaces.${role})`);
    }
  });

  test("every namespace follows the prefix, and only its own are named", () => {
    const { objects, text } = render([
      ...PROD,
      "--set",
      "namespaces.prefix=acme",
      "--set",
      "previews.enabled=true",
      "--set",
      "previews.domain=preview.acme.example",
      "--set",
      "radicle.enabled=true",
      "--set",
      "github.enabled=true",
    ]);
    const named = namespacesNamed(objects);
    for (const ns of named) {
      expect([...nsOf("acme"), "acme-state", "kube-system"]).toContain(ns);
    }
    // And nothing left pointing at the default prefix.
    expect(text).not.toMatch(/\.ryph(-[a-z]+)?\.svc/);
    expect(text).not.toMatch(/: ryph-(runs|tools|builds|egress|state)$/m);
    const cp = find(objects, "Deployment", "control-plane", "acme");
    const env = Object.fromEntries(
      cp.spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value]),
    );
    expect(env.RYPH_K8S_NAMESPACE).toBe("acme-runs");
    expect(env.RYPH_ENV_BUILD_NAMESPACE).toBe("acme-builds");
    expect(env.RYPH_EGRESS_PROXY_URL).toBe("http://egress-proxy.acme-egress.svc:7460");
    expect(env.RYPH_PREVIEWS_URL).toBe("http://previews.acme.svc:7493");
    expect(env.RYPH_RUN_PREVIEWS_URL).toBe("http://previews.acme.svc:7491");
    expect(env.RYPH_ARTIFACT_THUMBNAIL_URL).toBe("http://artifact-thumbnails.acme.svc:7491");
    const gw = find(objects, "Deployment", "mcp-gateway", "acme");
    const gwEnv = Object.fromEntries(
      gw.spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value]),
    );
    expect(gwEnv.RYPH_TOOL_HOST_NAMESPACE).toBe("acme-tools");
    // Plain env derived from the namespace, never a Secret value a prefix change cannot see: a
    // stale one would send this release's gateway to another release's forge.
    expect(gwEnv.RYPH_FORGE_TOOLS_URL).toBe("http://forge.acme.svc:7412");
    const bridge = find(objects, "StatefulSet", "radicle", "acme").spec.template.spec.containers
      .find((c: any) => c.name === "radicle");
    expect(bridge.env.find((e: any) => e.name === "RYPH_RADICLE_EVENTS_URL").value)
      .toBe("http://forge.acme.svc:7412/v1/hooks/radicle");
    const binding = find(objects, "RoleBinding", "ryph-provisioner", "acme-runs");
    expect(binding.subjects).toEqual([{
      kind: "ServiceAccount",
      name: "control-plane",
      namespace: "acme",
    }]);
  });

  test("two releases collide on nothing", () => {
    const a = render([...PROD, "--set", "namespaces.prefix=ryph"]).objects;
    const b = render([
      ...PROD,
      "--set",
      "namespaces.prefix=radicle",
      "--set",
      "priorityClasses.create=false",
    ]).objects;
    const ids = (objs: any[]) =>
      new Set(objs.map((o) => `${o.kind}/${o.metadata.namespace ?? "-"}/${o.metadata.name}`));
    const shared = [...ids(a)].filter((id) => ids(b).has(id));
    expect(shared).toEqual([]);
  });

  test("the only cluster-scoped objects are the namespaces and the shared PriorityClasses", () => {
    const clusterScoped = (objs: any[]) =>
      objs.filter((o) => !o.metadata.namespace).map((o) => `${o.kind}/${o.metadata.name}`).sort();
    const owner = clusterScoped(render(PROD).objects);
    expect(owner).toEqual([
      ...nsOf("ryph").map((n) => `Namespace/${n}`),
      ...Array.from({ length: 10 }, (_, i) => `PriorityClass/ryph-reserved-capacity-${i}`),
      "PriorityClass/ryph-tool-host",
      "PriorityClass/ryph-workload",
    ].sort());
    const other = clusterScoped(
      render([...PROD, "--set", "namespaces.prefix=b", "--set", "priorityClasses.create=false"])
        .objects,
    );
    expect(other).toEqual(nsOf("b").map((n) => `Namespace/${n}`).sort());
    const none = clusterScoped(
      render([...PROD, "--set", "namespaces.create=false", "--set", "priorityClasses.create=false"])
        .objects,
    );
    expect(none).toEqual([]);
  });

  test("the PriorityClasses are exactly the rungs placeholders name, from -10 to -1, then real work at 0", () => {
    const classes = render([...PROD, "--show-only", "templates/priorityclasses.yaml"]).objects
      .filter((o) => o.kind === "PriorityClass");
    const rungs = classes.filter((c) => c.metadata.name.startsWith("ryph-reserved-capacity-"));
    expect(rungs.map((c) => [c.metadata.name, c.value, c.preemptionPolicy, c.globalDefault]))
      .toEqual(
        Array.from({ length: RESERVE_RUNGS }, (_, rung) => [
          reservePriorityClass(rung),
          -10 + rung,
          "Never",
          false,
        ]),
      );
    const workload = find(classes, "PriorityClass", WORKLOAD_PRIORITY_CLASS);
    expect([workload.value, workload.preemptionPolicy]).toEqual([0, "PreemptLowerPriority"]);
    // Hosted MCP servers sit level with real work but evict nothing, a warm slot least of all.
    const toolHost = find(classes, "PriorityClass", TOOL_HOST_PRIORITY_CLASS);
    expect([toolHost.value, toolHost.preemptionPolicy]).toEqual([0, "Never"]);
    expect(classes.length).toBe(RESERVE_RUNGS + 2);
  });

  test("namespaces carry their Pod Security levels, and only the services one the Gateway label", () => {
    const { objects } = render(PROD);
    const labels = (n: string) => find(objects, "Namespace", n).metadata.labels;
    expect(labels("ryph")["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect(labels("ryph")["ryph.dev/services"]).toBe("true");
    expect(labels("ryph-runs")["pod-security.kubernetes.io/enforce"]).toBe("baseline");
    expect(labels("ryph-tools")["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect(labels("ryph-egress")["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect(labels("ryph-builds")["pod-security.kubernetes.io/enforce"]).toBe("privileged");
    for (const n of ["ryph-runs", "ryph-tools", "ryph-egress", "ryph-builds"]) {
      expect(labels(n)["ryph.dev/services"]).toBeUndefined();
    }
  });

  test("every namespace the chart creates is kept on uninstall unless told otherwise", () => {
    const keep = (args: string[]) =>
      render(args).objects.filter((o) => o.kind === "Namespace").map((o) =>
        `${o.metadata.name}:${o.metadata.annotations?.["helm.sh/resource-policy"] ?? "-"}`
      ).sort();
    expect(keep(["-f", DEV_VALUES])).toEqual(
      [...nsOf("ryph"), "ryph-state"].map((n) => `${n}:keep`).sort(),
    );
    // Decoupled from the Secrets: dropping their keep leaves the namespaces kept.
    expect(keep([...PROD, "--set", "secrets.keepOnUninstall=false"])).toEqual(
      nsOf("ryph").map((n) => `${n}:keep`).sort(),
    );
    expect(keep([...PROD, "--set", "namespaces.keepOnUninstall=false"])).toEqual(
      nsOf("ryph").map((n) => `${n}:-`).sort(),
    );
  });

  test("namespace names are the release's own, one per role", () => {
    const dup = helm([...PROD, "--set", "namespaces.runs=ryph-tools"]);
    expect(dup.ok).toBe(false);
    expect(dup.err).toContain('both resolve to "ryph-tools"');
    const state = helm(["-f", DEV_VALUES, "--set", "namespaces.state=ryph"]);
    expect(state.ok).toBe(false);
    expect(state.err).toContain('both resolve to "ryph"');
    for (const name of ["default", "kube-system", "kube-public", "kube-node-lease"]) {
      expect(helm([...PROD, "--set", `namespaces.egress=${name}`]).ok).toBe(false);
    }
    expect(helm([...PROD, "--set", "namespaces.prefix=default"]).ok).toBe(false);
  });

  test("namespaces.labels adds labels and never touches Pod Security or the Gateway label", () => {
    const { objects } = render([
      ...PROD,
      "--set-json",
      'namespaces.labels={"team":"infra"}',
    ]);
    const labels = (n: string) => find(objects, "Namespace", n).metadata.labels;
    expect(labels("ryph")["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect(labels("ryph-runs")["pod-security.kubernetes.io/enforce"]).toBe("baseline");
    expect(labels("ryph-runs").team).toBe("infra");
    // A level, and a version that would pin `restricted` to an older, weaker definition.
    for (const key of ["enforce", "enforce-version", "warn", "audit-version"]) {
      const r = helm([
        ...PROD,
        "--set-json",
        `namespaces.labels={"pod-security.kubernetes.io/${key}":"v1.0"}`,
      ]);
      expect(r.ok).toBe(false);
      expect(r.err).toContain(`may not set pod-security.kubernetes.io/${key}`);
    }
    const gateway = helm([
      ...PROD,
      "--set-json",
      'namespaces.labels={"ryph.dev/services":"true"}',
    ]);
    expect(gateway.ok).toBe(false);
    expect(gateway.err).toContain("ryph.dev/services");
  });

  test("string env stays a string: no YAML 1.1 boolean or number is left unquoted", () => {
    for (
      const args of [["-f", DEV_VALUES], [
        ...PROD,
        "--set",
        "runs.services=true",
        "--set",
        "checks.enabled=true",
        "--set",
        "environments.enabled=true",
        "--set",
        "environments.allowUnsandboxed=true",
        "--set",
        "environments.concurrency=2",
        "--set",
        "app.xffDepth=2",
      ]]
    ) {
      const { text, objects } = render(args);
      expect(text).not.toMatch(/^\s+value: (on|off|yes|no|true|false|y|n|[0-9][0-9.]*)\s*$/im);
      for (const { spec } of podSpecs(objects)) {
        for (const c of [...spec.containers, ...(spec.initContainers ?? [])]) {
          for (const e of c.env ?? []) {
            if ("value" in e) expect(typeof e.value).toBe("string");
          }
        }
      }
    }
    expect(render(PROD).text).toContain('value: "on"');
  });

  test("thumbnail renderer: no credentials, no egress at all, and only the control plane in", () => {
    const { objects } = render([...PROD, "--set", "artifactThumbnails.runtimeClassName=gvisor"]);
    const d = find(objects, "Deployment", "artifact-thumbnails", "ryph");
    const pod = d.spec.template.spec;
    const c = pod.containers[0];
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.enableServiceLinks).toBe(false);
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    // An outer sandbox does not turn the inner one off.
    expect(pod.runtimeClassName).toBe("gvisor");
    expect(c.envFrom).toBeUndefined();
    expect(c.env).toEqual([{ name: "HOME", value: "/tmp" }, {
      name: "RYPH_THUMBNAIL_SANDBOX",
      value: "required",
    }]);
    expect(c.command).toEqual(["bun", "run", "src/thumbnail.ts"]);
    expect(c.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(c.resources.limits).toEqual({ cpu: "1", memory: "1Gi", "ephemeral-storage": "256Mi" });
    expect(pod.volumes.map((v: any) => v.emptyDir)).toEqual([
      { medium: "Memory", sizeLimit: "256Mi" },
      { medium: "Memory", sizeLimit: "128Mi" },
    ]);
    const policy = find(objects, "NetworkPolicy", "artifact-thumbnails", "ryph");
    expect(policy.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(policy.spec.egress).toEqual([]);
    expect(policy.spec.ingress).toEqual([{
      from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "control-plane" } } }],
      ports: [{ protocol: "TCP", port: 7491 }],
    }]);
  });

  test("the thumbnail sandbox cannot be switched off quietly", () => {
    const off = helm([...PROD, "--set", "artifactThumbnails.sandbox=off"]);
    expect(off.ok).toBe(false);
    expect(off.err).toContain("runtimeClassName");
    expect(
      helm([
        ...PROD,
        "--set",
        "artifactThumbnails.sandbox=off",
        "--set",
        "artifactThumbnails.runtimeClassName=gvisor",
      ]).ok,
    ).toBe(true);
    expect(helm([...PROD, "--set", "artifactThumbnails.sandbox=no"]).ok).toBe(false);
    expect(helm([...PROD, "--set", "artifactThumbnails.seccompProfile.type=Unconfined"]).ok)
      .toBe(false);
    expect(helm([...PROD, "--set", "artifactThumbnails.seccompProfile.type=Localhost"]).ok)
      .toBe(false);
  });

  test("in-cluster builds need a runtime class, or an opt-in the control plane hears too", () => {
    const BUILDS = [...PROD, "--set", "environments.enabled=true"];
    const bare = helm(BUILDS);
    expect(bare.ok).toBe(false);
    expect(bare.err).toContain("environments.allowUnsandboxed");
    // `kubernetes` named, or left to the default, is the same builder.
    expect(helm([...BUILDS, "--set", "environments.builder=kubernetes"]).ok).toBe(false);
    const cpEnv = (args: string[]) =>
      Object.fromEntries(
        find(render(args).objects, "Deployment", "control-plane", "ryph").spec.template.spec
          .containers[0].env.map((e: any) => [e.name, e.value]),
      );
    // Either runtime class contains the builds; the opt-in stays off.
    for (const set of ["runs.runtimeClassName=gvisor", "environments.runtimeClassName=gvisor"]) {
      const env = cpEnv([...BUILDS, "--set", set]);
      expect(env.RYPH_ENV_BUILD_ALLOW_UNSANDBOXED).toBeUndefined();
    }
    // The opt-in renders, and reaches the builder, which refuses at boot without it.
    expect(
      cpEnv([...BUILDS, "--set", "environments.allowUnsandboxed=true"])
        .RYPH_ENV_BUILD_ALLOW_UNSANDBOXED,
    ).toBe("on");
    // Builds off, or on Cloud Build, run no pod in the cluster to contain.
    expect(helm(PROD).ok).toBe(true);
    expect(helm([...BUILDS, "--set", "environments.builder=cloud-build"]).ok).toBe(true);
    // The laptop values carry the opt-in, so builds turned on there still render.
    expect(helm(["-f", DEV_VALUES, "--set", "environments.enabled=true"]).ok).toBe(true);
  });

  describe("the run network boundary", () => {
    const KNOBS = [
      ...PROD,
      "--set",
      "previews.enabled=true",
      "--set",
      "previews.domain=preview.example.net",
      "--set",
      "radicle.enabled=true",
      "--set-json",
      'networkPolicy.dns.extraCidrs=["169.254.20.10/32"]',
      "--set-json",
      'networkPolicy.internet.extraExcept=["203.0.113.7/32"]',
      "--set-json",
      'networkPolicy.database.extraCidrs=["10.20.0.3/32"]',
    ];
    const policies = () => render(KNOBS).objects.filter((o) => o.kind === "NetworkPolicy");
    const rulesOf = (p: any) => [...(p.spec.egress ?? [])];
    const isDns = (r: any) => r.ports?.some((p: any) => p.port === 53);
    const isDb = (r: any) => r.ports?.some((p: any) => p.port === 5432);
    const isInternet = (r: any) => r.to?.some((t: any) => t.ipBlock?.cidr === "0.0.0.0/0");

    test("runs, checks and builds have no ipBlock beyond the DNS cache, and no internet rule", () => {
      for (
        const name of [
          "agent-run-egress",
          "check-run-egress",
          "agent-run-to-previews",
          "environment-build-egress",
        ]
      ) {
        const p = policies().find((x) => x.metadata.name === name)!;
        for (const r of rulesOf(p)) {
          for (const t of r.to ?? []) {
            if (t.ipBlock) {
              expect(isDns(r)).toBe(true);
              expect(t.ipBlock.cidr).toBe("169.254.20.10/32");
            }
          }
          expect(isInternet(r)).toBe(false);
          expect(isDb(r)).toBe(false);
        }
      }
      // No ingress rule anywhere in the runs namespace: a run's sidecars share its pod.
      for (const p of policies().filter((x) => x.metadata.namespace === "ryph-runs")) {
        expect(p.spec.ingress ?? []).toEqual([]);
      }
    });

    test("a run reaches exactly its contract: the five services, previews' tunnel, the egress proxy, DNS", () => {
      const run = policies().filter((p) =>
        p.metadata.namespace === "ryph-runs" &&
        p.spec.podSelector.matchLabels?.["app.kubernetes.io/component"] === "agent-run"
      );
      const reach = run.flatMap(rulesOf).filter((r) => !isDns(r)).map((r) =>
        `${r.to[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"]}/${
          r.to[0].podSelector.matchLabels["app.kubernetes.io/name"]
        }:${r.ports.map((p: any) => p.port).join(",")}`
      ).sort();
      expect(reach).toEqual([
        "ryph-egress/egress-proxy:7460",
        "ryph/control-plane:7411",
        "ryph/forge:7412",
        "ryph/historian:7413",
        "ryph/mcp-gateway:7430",
        "ryph/model-proxy:7420",
        "ryph/previews:7491",
      ]);
    });

    test("every DNS rule names the resolver and gets the extra address, and nothing else does", () => {
      for (const p of policies()) {
        for (const r of rulesOf(p)) {
          const hasCache = r.to?.some((t: any) => t.ipBlock?.cidr === "169.254.20.10/32");
          expect(hasCache ?? false).toBe(isDns(r) ?? false);
          if (isDns(r)) {
            expect(r.to[0]).toEqual({
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            });
            expect(r.ports).toEqual([{ port: 53, protocol: "UDP" }, { port: 53, protocol: "TCP" }]);
          }
        }
      }
    });

    test("every internet rule excepts every private range and the extra address", () => {
      const holders: string[] = [];
      for (const p of policies()) {
        for (const r of rulesOf(p).filter(isInternet)) {
          holders.push(p.metadata.name);
          const except = r.to[0].ipBlock.except;
          for (const c of [...PRIVATE, "203.0.113.7/32"]) expect(except).toContain(c);
          expect(r.to.length).toBe(1);
        }
      }
      expect(holders.sort()).toEqual([
        "chat",
        "egress-proxy",
        "memory",
        "model-proxy",
        "radicle",
        "tool-server",
        "web",
      ]);
    });

    test("the database address lands on the database rules alone", () => {
      const holders: string[] = [];
      for (const p of policies()) {
        for (const r of rulesOf(p)) {
          const has = r.to?.some((t: any) => t.ipBlock?.cidr === "10.20.0.3/32");
          expect(has ?? false).toBe(isDb(r) ?? false);
          if (has) holders.push(p.metadata.name);
        }
      }
      expect(holders.sort()).toEqual(["chat", "memory", "model-proxy", "radicle"]);
    });

    test("the dev Postgres is a database peer only with devState, and operator peers land on every database rule", () => {
      const peer = {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "databases" } },
        podSelector: { matchLabels: { "cnpg.io/cluster": "ryph" } },
      };
      const prod = render([
        ...PROD,
        "--set",
        "radicle.enabled=true",
        "--set-json",
        `networkPolicy.database.peers=[${JSON.stringify(peer)}]`,
      ]).objects.filter((o) => o.kind === "NetworkPolicy");
      const dbRules = prod.flatMap((p) =>
        rulesOf(p).filter(isDb).map((r) => ({ name: p.metadata.name, to: r.to }))
      );
      expect(dbRules.map((r) => r.name).sort()).toEqual([
        "chat",
        "memory",
        "model-proxy",
        "radicle",
      ]);
      for (const r of dbRules) expect(r.to).toEqual([peer]);
      // Without any peer there is no database rule at all: an empty `to:` would admit everything.
      const none = render(PROD).objects.filter((o) => o.kind === "NetworkPolicy");
      expect(none.flatMap(rulesOf).filter(isDb)).toEqual([]);
      for (const p of none) {
        for (const r of rulesOf(p)) expect(r.to?.length ?? 1).toBeGreaterThan(0);
      }
      const dev = render(["-f", DEV_VALUES]).objects.filter((o) => o.kind === "NetworkPolicy");
      const memoryDb = rulesOf(dev.find((p) => p.metadata.name === "memory")!).find(isDb);
      expect(memoryDb.to).toEqual([{
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ryph-state" } },
        podSelector: { matchLabels: { "app.kubernetes.io/name": "postgres" } },
      }]);
    });

    test("the dev state admits the services namespace alone", () => {
      const ps = render(["-f", DEV_VALUES]).objects.filter((o) =>
        o.kind === "NetworkPolicy" && o.metadata.namespace === "ryph-state"
      );
      expect(ps.map((p) => p.metadata.name).sort()).toEqual([
        "default-deny-ingress",
        "from-services",
      ]);
      const allow = ps.find((p) => p.metadata.name === "from-services")!;
      expect(allow.spec.ingress).toEqual([{
        from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ryph" } } }],
        ports: [{ port: 5432 }, { port: 9000 }],
      }]);
    });

    test("an extra rule without its peers, or a database peer that is every pod, is refused", () => {
      for (
        const [key, json] of [
          ["networkPolicy.extraEgress", '{"web":[{"ports":[{"port":80}]}]}'],
          ["networkPolicy.extraEgress", '{"web":[{"to":[],"ports":[{"port":80}]}]}'],
          ["networkPolicy.extraIngress", '{"app":[{"ports":[{"port":3000}]}]}'],
          ["networkPolicy.database.peers", '[{"namespaceSelector":{}}]'],
          ["networkPolicy.database.peers", '[{"namespaceSelector":{"matchLabels":{}}}]'],
          ["networkPolicy.database.peers", '[{"podSelector":{},"namespaceSelector":{}}]'],
        ]
      ) {
        expect(helm([...PROD, "--set-json", `${key}=${json}`]).ok).toBe(false);
      }
      expect(
        helm([
          ...PROD,
          "--set-json",
          'networkPolicy.database.peers=[{"namespaceSelector":{},"podSelector":{"matchLabels":{"cnpg.io/cluster":"ryph"}}}]',
        ]).ok,
      ).toBe(true);
    });

    test("an extra rule's peer that is every pod is refused; a named one lands", () => {
      for (
        const [knob, side, policy] of [["extraIngress", "from", "app"], [
          "extraEgress",
          "to",
          "web",
        ]]
      ) {
        for (
          const peer of [
            '{"namespaceSelector":{}}',
            '{"namespaceSelector":{"matchLabels":{}}}',
            '{"podSelector":{}}',
            '{"podSelector":{"matchExpressions":[]},"namespaceSelector":{}}',
            '{"ports":[]}',
          ]
        ) {
          const json = `{"${policy}":[{"${side}":[${peer}]}]}`;
          expect(helm([...PROD, "--set-json", `networkPolicy.${knob}=${json}`]).ok).toBe(false);
        }
        const named = {
          namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "monitoring" } },
          podSelector: {},
        };
        const rule = { [side]: [named], ports: [{ port: 9090 }] };
        const policies = render([
          ...PROD,
          "--set-json",
          `networkPolicy.${knob}=${JSON.stringify({ [policy]: [rule] })}`,
        ]).objects.filter((o) => o.kind === "NetworkPolicy" && o.metadata.name === policy);
        const rules = policies.flatMap((p) =>
          side === "from" ? p.spec.ingress ?? [] : p.spec.egress ?? []
        );
        expect(rules).toContainEqual(rule);
      }
    });

    test("an extra rule keyed by no policy is refused, not ignored", () => {
      for (const [knob, side] of [["extraIngress", "from"], ["extraEgress", "to"]]) {
        const rule = `{"${side}":[{"ipBlock":{"cidr":"192.0.2.1/32"}}]}`;
        const r = helm([...PROD, "--set-json", `networkPolicy.${knob}={"forge-typo":[${rule}]}`]);
        expect(r.ok).toBe(false);
        expect(r.err).toContain(`networkPolicy.${knob}.forge-typo names no policy`);
      }
      expect(
        helm([
          ...PROD,
          "--set-json",
          'networkPolicy.extraEgress={"radicle":[{"to":[{"ipBlock":{"cidr":"192.0.2.1/32"}}]}]}',
        ]).ok,
      ).toBe(true);
    });

    test("the DNS rule cannot lose its pod selector", async () => {
      // A values file's null deletes the default; the rule would select every pod in kube-system.
      const file = `${tmpdir()}/ryph-chart-null-dns-${process.pid}.yaml`;
      await Bun.write(file, "networkPolicy:\n  dns:\n    podLabels: null\n");
      const r = helm([...PROD, "-f", file]);
      expect(r.ok).toBe(false);
      expect(r.err).toContain("podLabels");
    });

    test("service ports open to exactly their callers", () => {
      const ps = policies();
      const web = ps.find((p) => p.metadata.name === "web")!;
      expect(web.spec.ingress).toEqual([{
        from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "mcp-gateway" } } }],
        ports: [{ port: 7480 }],
      }]);
      const mp = ps.find((p) => p.metadata.name === "model-proxy")!;
      expect(mp.spec.ingress[1].ports).toEqual([{ port: 7421 }]);
      expect(JSON.stringify(mp.spec.ingress[1])).not.toContain("agent-run");
      const gw = ps.find((p) => p.metadata.name === "mcp-gateway")!;
      expect(JSON.stringify(gw.spec.ingress[1])).not.toContain("agent-run");
      const app = ps.find((p) => p.metadata.name === "app")!;
      expect(app.spec.ingress).toEqual([{ ports: [{ port: 3000 }] }]);
      const guard = ps.find((p) => p.metadata.name === "tool-guard")!;
      expect(guard.spec.ingress[0].from).toEqual([{
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ryph" } },
        podSelector: { matchLabels: { "app.kubernetes.io/name": "mcp-gateway" } },
      }]);
      // Default-deny where the base had it.
      for (
        const [ns, types] of [
          ["ryph", ["Ingress"]],
          ["ryph-runs", ["Ingress", "Egress"]],
          ["ryph-tools", ["Ingress", "Egress"]],
          ["ryph-builds", ["Ingress", "Egress"]],
          ["ryph-egress", ["Ingress", "Egress"]],
        ] as const
      ) {
        const deny = ps.find((p) =>
          p.metadata.namespace === ns && p.spec.podSelector &&
          Object.keys(p.spec.podSelector).length === 0
        )!;
        expect(deny.spec.policyTypes).toEqual([...types]);
        expect(deny.spec.ingress).toBeUndefined();
        expect(deny.spec.egress).toBeUndefined();
      }
    });

    test("the front door narrows the app and opens the hooks only when routed", () => {
      const from = '[{"ipBlock":{"cidr":"198.51.100.0/24"}}]';
      const routed = render([
        ...PROD,
        "--set-json",
        `networkPolicy.frontDoor.from=${from}`,
        "--set",
        "ingress.enabled=true",
        "--set",
        "ingress.host=ryph.example.com",
      ]).objects;
      expect(find(routed, "NetworkPolicy", "app").spec.ingress).toEqual([{
        ports: [{ port: 3000 }],
        from: JSON.parse(from),
      }]);
      expect(find(routed, "NetworkPolicy", "forge").spec.ingress[1]).toEqual({
        from: JSON.parse(from),
        ports: [{ port: 7412 }],
      });
      expect(find(routed, "NetworkPolicy", "automations").spec.ingress[1]).toEqual({
        from: JSON.parse(from),
        ports: [{ port: 7414 }],
      });
      const unrouted =
        render([...PROD, "--set-json", `networkPolicy.frontDoor.from=${from}`]).objects;
      expect(find(unrouted, "NetworkPolicy", "forge").spec.ingress.length).toBe(1);
      expect(find(unrouted, "NetworkPolicy", "automations").spec.ingress.length).toBe(1);
    });
  });

  describe("secrets", () => {
    const secretData = (objects: any[], name: string, ns = "ryph") => {
      const s = find(objects, "Secret", name, ns);
      return s &&
        Object.fromEntries(Object.entries(s.data).map(([k, v]) => [k, atob(v as string)]));
    };

    test("generated internal credentials are 64 hex characters and the same in every holder", () => {
      const { objects } = render([
        ...PROD,
        "--set",
        "previews.enabled=true",
        "--set",
        "previews.domain=p.example.net",
        "--set",
        "radicle.enabled=true",
      ]);
      const cp = secretData(objects, "control-plane")!;
      const pairs: Array<[string, string, string]> = [
        ["RYPH_FORGE_TOKEN", "control-plane", "forge"],
        ["RYPH_HISTORY_TOKEN", "control-plane", "historian"],
        ["RYPH_MODEL_PROXY_TOKEN", "control-plane", "model-proxy"],
        ["RYPH_MCP_GATEWAY_TOKEN", "control-plane", "mcp-gateway"],
        ["RYPH_AUTOMATIONS_TOKEN", "control-plane", "automations"],
        ["RYPH_MEMORY_TOKEN", "control-plane", "memory"],
        ["RYPH_CHAT_TOKEN", "control-plane", "chat"],
        ["RYPH_PLATFORM_TOKEN", "control-plane", "model-proxy"],
        ["RYPH_PLATFORM_TOKEN", "control-plane", "memory"],
        ["RYPH_PROXY_SECRET", "control-plane", "app"],
        ["RYPH_MEMORY_GATEWAY_TOKEN", "mcp-gateway", "memory"],
        ["RYPH_CHAT_GATEWAY_TOKEN", "mcp-gateway", "chat"],
        ["RYPH_WEB_GATEWAY_TOKEN", "mcp-gateway", "web"],
        ["RYPH_FORGE_GATEWAY_TOKEN", "mcp-gateway", "forge"],
      ];
      for (const [key, a, b] of pairs) {
        const va = secretData(objects, a)![key];
        expect(va).toMatch(/^[0-9a-f]{64}$/);
        expect(secretData(objects, b)![key]).toBe(va);
      }
      expect(secretData(objects, "egress-proxy", "ryph-egress")!.RYPH_EGRESS_KEY).toBe(
        cp.RYPH_EGRESS_KEY,
      );
      for (
        const [key, holder] of [
          ["RYPH_SECRETS_KEY", "model-proxy"],
          ["RYPH_MCP_KEY", "mcp-gateway"],
          ["RYPH_CHAT_KEY", "chat"],
          ["RYPH_PREVIEWS_TOKEN", "previews"],
          ["RYPH_RADICLE_TOKEN", "radicle"],
        ]
      ) {
        expect(secretData(objects, holder)![key]).toMatch(/^[0-9a-f]{64}$/);
      }
      // A URL-encoded password, as postgres.js decodes it (decodeURIComponent: a space is %20,
      // never "+"), and the query string.
      expect(cp.RYPH_DB).toBe(
        "postgres://ryph:p%40ss%20word@db.example.internal:5432/ryph?sslmode=require",
      );
      expect(decodeURIComponent(new URL(cp.RYPH_DB).password)).toBe("p@ss word");
      const plus = render([...PROD, "--set", "postgres.password=a+b c"]).objects;
      expect(decodeURIComponent(new URL(secretData(plus, "control-plane")!.RYPH_DB).password))
        .toBe("a+b c");
      expect(secretData(objects, "historian")!.RYPH_HISTORY_DB).toContain("/ryph_history?");
      // Production never carries the dev escape hatch.
      for (const s of objects.filter((o) => o.kind === "Secret")) {
        expect(s.data.RYPH_ALLOW_DEV_SECRETS).toBeUndefined();
      }
    });

    test("dev values carry the escape hatch, and a previews token long enough to boot", () => {
      const { objects } = render(["-f", DEV_VALUES]);
      expect(secretData(objects, "control-plane")!.RYPH_ALLOW_DEV_SECRETS).toBe("1");
      expect(secretData(objects, "previews")!.RYPH_PREVIEWS_TOKEN.length).toBeGreaterThanOrEqual(
        32,
      );
      // Radicle turns forge tools on, and the file's placeholders cover it offline too.
      const radicle = render(["-f", DEV_VALUES, "--set", "radicle.enabled=true"]).objects;
      expect(secretData(radicle, "mcp-gateway")!.RYPH_FORGE_GATEWAY_TOKEN).toBe(
        "dev-forge-gateway-token",
      );
      // The app and the egress proxy never ran the dev-secret check, and never got the flag.
      expect(secretData(objects, "app")!.RYPH_ALLOW_DEV_SECRETS).toBeUndefined();
    });

    test("the dev escape hatch is refused outside a laptop install", () => {
      const r = helm([...PROD, "--set", "secrets.allowDevSecrets=true"]);
      expect(r.ok).toBe(false);
      expect(r.err).toContain("refused without devState.enabled");
    });

    test("an existingSecret replaces the chart's Secret and is what the pod reads", () => {
      const { objects } = render([...PROD, "--set", "historian.existingSecret=my-historian"]);
      expect(find(objects, "Secret", "historian")).toBeUndefined();
      const pod = find(objects, "Deployment", "historian").spec.template.spec;
      expect(pod.containers[0].envFrom).toEqual([{ secretRef: { name: "my-historian" } }]);
      expect(pod.initContainers[0].env[0].valueFrom.secretKeyRef).toEqual({
        name: "my-historian",
        key: "RYPH_HISTORY_DB",
      });
    });

    test("secrets.generate=false refuses to invent a credential", () => {
      const r = helm([...PROD, "--set", "secrets.generate=false"]);
      expect(r.ok).toBe(false);
      expect(r.err).toContain("secrets.generate is false");
    });

    const BARE = PROD.slice(MINT.length);
    const SEALING = ["RYPH_SECRETS_KEY", "RYPH_MCP_KEY", "RYPH_CHAT_KEY"];
    const INTERNAL = [
      "RYPH_FORGE_TOKEN",
      "RYPH_HISTORY_TOKEN",
      "RYPH_MODEL_PROXY_TOKEN",
      "RYPH_MCP_GATEWAY_TOKEN",
      "RYPH_AUTOMATIONS_TOKEN",
      "RYPH_MEMORY_TOKEN",
      "RYPH_CHAT_TOKEN",
      "RYPH_PLATFORM_TOKEN",
      "RYPH_MEMORY_GATEWAY_TOKEN",
      "RYPH_CHAT_GATEWAY_TOKEN",
      "RYPH_WEB_GATEWAY_TOKEN",
      "RYPH_EGRESS_KEY",
      "RYPH_PROXY_SECRET",
      ...SEALING,
    ];
    const supplied = (keys: string[]) =>
      keys.flatMap((k, i) => ["--set", `secrets.internal.${k}=${i.toString(16).repeat(64)}`]);

    test("without cluster access it mints nothing, and names every credential it would have", () => {
      const r = helm(BARE);
      expect(r.ok).toBe(false);
      expect(r.err).toContain("cannot see the cluster");
      for (const k of INTERNAL) expect(r.err).toContain(k);
      // A missing sealing key alone is still refused, by name.
      const one = helm([...BARE, ...supplied(INTERNAL.filter((k) => k !== "RYPH_MCP_KEY"))]);
      expect(one.ok).toBe(false);
      expect(one.err).toContain("RYPH_MCP_KEY");
      expect(one.err).not.toContain("RYPH_SECRETS_KEY");
    });

    test("a render without a cluster needs every credential supplied, or every holder's own Secret", () => {
      const { objects } = render([...BARE, ...supplied(INTERNAL)]);
      expect(secretData(objects, "model-proxy")!.RYPH_SECRETS_KEY).toBe(
        INTERNAL.indexOf("RYPH_SECRETS_KEY").toString(16).repeat(64),
      );
      const holders = [
        "controlPlane",
        "app",
        "historian",
        "memory",
        "chat",
        "web",
        "modelProxy",
        "mcpGateway",
        "forge",
        "automations",
        "egressProxy",
      ];
      const own = render([
        ...BARE,
        ...holders.flatMap((h) => ["--set", `${h}.existingSecret=${h}-managed`]),
      ]).objects;
      expect(own.filter((o) => o.kind === "Secret")).toEqual([]);
    });

    test("the credential cache cannot be set from values, which would skip every check", () => {
      const r = helm([
        ...BARE,
        "--set",
        "__ryphInternal.RYPH_SECRETS_KEY=x",
      ]);
      expect(r.ok).toBe(false);
      expect(r.err).toContain("__ryphInternal");
    });

    test("an internal credential shorter than 32 characters is refused outside dev", () => {
      const r = helm([...PROD, "--set", "secrets.internal.RYPH_FORGE_TOKEN=short"]);
      expect(r.ok).toBe(false);
      expect(r.err).toContain("secrets.internal.RYPH_FORGE_TOKEN is 5 characters");
    });
  });

  test("every workload with a database migrates it first, from the URL it reads", () => {
    const { objects } = render([
      ...PROD,
      "--set",
      "radicle.enabled=true",
      "--set",
      "postgres.urlSecrets.memory.name=db-urls",
      "--set",
      "postgres.urlSecrets.memory.key=memory",
    ]);
    const expected: Record<string, [string, string, string]> = {
      "control-plane": ["/app/packages/orchestrator", "RYPH_DB", "control-plane"],
      historian: ["/app/packages/historian", "RYPH_HISTORY_DB", "historian"],
      "model-proxy": ["/app/packages/model-proxy", "RYPH_DB", "model-proxy"],
      "mcp-gateway": ["/app/packages/mcp-gateway", "RYPH_DB", "mcp-gateway"],
      memory: ["/app/packages/memory", "RYPH_MEMORY_DB", "db-urls"],
      chat: ["/app/packages/chat", "RYPH_CHAT_DB", "chat"],
      forge: ["/app/packages/webhooks", "RYPH_WEBHOOKS_DB", "forge"],
      automations: ["/app/packages/automations", "RYPH_AUTOMATIONS_DB", "automations"],
      radicle: ["/app/packages/radicle", "RYPH_RADICLE_DB", "radicle"],
    };
    for (const [name, [dir, variable, secret]] of Object.entries(expected)) {
      const owner = objects.find((o) =>
        ["Deployment", "StatefulSet"].includes(o.kind) && o.metadata.name === name
      );
      const init = owner.spec.template.spec.initContainers[0];
      expect(init.name.startsWith("migrate")).toBe(true);
      expect(init.workingDir).toBe(dir);
      // Its owner's URL, and nothing else that is a credential.
      expect(init.env.map((e: any) => e.name)).toEqual([variable, "RYPH_MIGRATE_LOCK_TIMEOUT"]);
      expect(init.env[0].name).toBe(variable);
      expect(init.env[0].valueFrom.secretKeyRef.name).toBe(secret);
      expect(init.command.join(" ")).toContain(
        `/ryph-migrate/locked.ts ${variable} bun --no-env-file node_modules/drizzle-kit/bin.cjs migrate`,
      );
      expect(init.image).toBe(
        owner.spec.template.spec.containers.find((c: any) => c.name === name)?.image ?? init.image,
      );
    }
    // The memory URL from a Secret you manage reaches the service too, as its own env entry.
    const memory = find(objects, "Deployment", "memory").spec.template.spec.containers[0];
    expect(memory.env.find((e: any) => e.name === "RYPH_MEMORY_DB").valueFrom.secretKeyRef).toEqual(
      { name: "db-urls", key: "memory" },
    );
    expect(find(objects, "Secret", "memory").data.RYPH_MEMORY_DB).toBeUndefined();
    // No Jobs: nothing immutable to delete before an upgrade.
    expect(objects.filter((o) => o.kind === "Job")).toEqual([]);
    const off = render([...PROD, "--set", "migrations.enabled=false"]).objects;
    for (const { spec } of podSpecs(off)) {
      for (const c of spec.initContainers ?? []) expect(c.name.startsWith("migrate")).toBe(false);
    }
  });

  test("every migration gives up on the lock after migrations.lockTimeoutSeconds", () => {
    const timeouts = (args: string[]) =>
      podSpecs(render([...PROD, ...args]).objects).flatMap(({ spec }) =>
        (spec.initContainers ?? []).filter((c: any) => c.name.startsWith("migrate"))
          .map((c: any) => c.env.find((e: any) => e.name === "RYPH_MIGRATE_LOCK_TIMEOUT")?.value)
      );
    const byDefault = timeouts([]);
    expect(byDefault.length).toBeGreaterThan(5);
    expect(new Set(byDefault)).toEqual(new Set(["600"]));
    expect(new Set(timeouts(["--set", "migrations.lockTimeoutSeconds=1800"]))).toEqual(
      new Set(["1800"]),
    );
  });

  test("an IPv6 database host is bracketed in every URL the chart builds", () => {
    const { objects } = render([...PROD, "--set", "postgres.host=fd00::5"]);
    const s = find(objects, "Secret", "control-plane", "ryph");
    const url = atob(s.data.RYPH_DB);
    expect(url).toContain("@[fd00::5]:5432/ryph?");
    expect(new URL(url).hostname).toBe("[fd00::5]");
  });

  test("every service pod is credential-light, non-root and tolerates a dead node for 30s", () => {
    // Previews on, at one replica and at several: every ordinal is a Deployment like the rest.
    const objects = [1, 3].flatMap((n) =>
      render([
        ...PROD,
        "--set",
        "previews.enabled=true",
        "--set",
        "previews.domain=preview.example.net",
        "--set",
        `previews.replicas=${n}`,
      ]).objects
    );
    const previews = objects.filter((o) =>
      o.kind === "Deployment" && /^previews(-\d+)?$/.test(o.metadata.name)
    );
    expect(previews.map((o) => o.metadata.name)).toEqual([
      "previews",
      "previews-0",
      "previews-1",
      "previews-2",
    ]);
    for (const { owner, spec } of podSpecs(objects)) {
      // No pod has its token mounted everywhere. The two services that talk to the Kubernetes API
      // get it in their main container alone — never the migrate or sanitizer containers.
      expect(spec.automountServiceAccountToken).toBe(false);
      const holders = [...spec.containers, ...(spec.initContainers ?? [])].filter((c: any) =>
        (c.volumeMounts ?? []).some((m: any) =>
          m.mountPath === "/var/run/secrets/kubernetes.io/serviceaccount"
        )
      ).map((c: any) => c.name);
      expect(holders).toEqual(
        ["control-plane", "mcp-gateway"].includes(owner.metadata.name) ? [owner.metadata.name] : [],
      );
      expect(spec.securityContext.runAsNonRoot).toBe(true);
      expect(spec.securityContext.seccompProfile).toEqual({ type: "RuntimeDefault" });
      for (const c of [...spec.containers, ...(spec.initContainers ?? [])]) {
        expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
        expect(c.securityContext.capabilities).toEqual({ drop: ["ALL"] });
      }
      if (owner.kind === "Deployment") {
        expect(spec.tolerations.slice(0, 2).map((t: any) => t.tolerationSeconds)).toEqual([30, 30]);
      }
    }
  });

  describe("previews replicas", () => {
    const withReplicas = (n: number, extra: string[] = []) =>
      render([
        ...PROD,
        "--set",
        "previews.enabled=true",
        "--set",
        "previews.domain=preview.example.net",
        "--set",
        `previews.replicas=${n}`,
        "--set-json",
        'networkPolicy.dns.extraCidrs=["169.254.20.10/32"]',
        ...extra,
      ]).objects;
    const deployments = (objects: any[]) =>
      objects.filter((o) => o.kind === "Deployment" && o.metadata.name.startsWith("previews"));
    const envOf = (deployment: any) =>
      Object.fromEntries(
        deployment.spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value]),
      );
    const previewsPeer = {
      podSelector: { matchLabels: { "app.kubernetes.io/name": "previews" } },
    };

    test("one replica is the one Deployment it always was: same name, selector, Recreate", () => {
      const objects = withReplicas(1);
      const [d] = deployments(objects);
      expect(deployments(objects).length).toBe(1);
      expect(d.metadata.name).toBe("previews");
      expect(d.spec.replicas).toBe(1);
      expect(d.spec.strategy).toEqual({ type: "Recreate" });
      // Under Recreate it would protect nothing, and only hold up a rollout's `--wait`.
      expect(d.spec.minReadySeconds).toBeUndefined();
      // Socket buffers capped, so a page that never reads cannot grow the kernel's share of the
      // memory limit to megabytes a socket.
      expect(d.spec.template.spec.securityContext.sysctls).toEqual([
        { name: "net.ipv4.tcp_rmem", value: "4096 32768 131072" },
        { name: "net.ipv4.tcp_wmem", value: "4096 16384 131072" },
      ]);
      // The selector a Deployment can never change: as before, so an install upgrades in place.
      expect(d.spec.selector).toEqual({ matchLabels: { "app.kubernetes.io/name": "previews" } });
      expect(d.spec.template.spec.topologySpreadConstraints).toBeUndefined();
      // The dead-node tolerations every one-replica service has.
      expect(d.spec.template.spec.tolerations.slice(0, 2).map((t: any) => t.tolerationSeconds))
        .toEqual([30, 30]);
      const env = envOf(d);
      expect(env.RYPH_PREVIEWS_REPLICAS).toBe("1");
      expect(env.RYPH_PREVIEWS_TUNNEL_PORT).toBe("7491");
      expect(env.RYPH_PREVIEWS_API_PORT).toBe("7493");
      // The memory the guard measures against is the container's limit (its cgroup's
      // memory.max): no estimate to configure beside it.
      expect(env.RYPH_PREVIEWS_MEMORY_LIMIT_MIB).toBeUndefined();
      expect(d.spec.template.spec.containers[0].resources).toEqual({
        requests: { cpu: "250m", memory: "768Mi" },
        limits: { memory: "768Mi" },
      });
      for (const name of ["RYPH_PREVIEWS_ORDINAL", "RYPH_PREVIEWS_PEER_HOST"]) {
        expect(env[name]).toBeUndefined();
      }
      const container = d.spec.template.spec.containers[0];
      expect(container.ports.map((p: any) => [p.name, p.containerPort])).toEqual([
        ["public", 7490],
        ["tunnel", 7491],
        ["api", 7493],
      ]);
      // Restarted some 30 s after its memory guard says it is stuck; a probe answered slowly while
      // a full collection runs (every 10 s past HIGH) is not a failure.
      expect(container.livenessProbe).toMatchObject({
        periodSeconds: 10,
        failureThreshold: 3,
        timeoutSeconds: 5,
      });
      // No Service but the shared one, no PodDisruptionBudget, no peer rule.
      expect(
        objects.filter((o) => o.kind === "Service" && o.metadata.name.startsWith("previews"))
          .map((o) => o.metadata.name),
      ).toEqual(["previews"]);
      expect(find(objects, "PodDisruptionBudget", "previews")).toBeUndefined();
      const shared = find(objects, "Service", "previews", "ryph");
      expect(shared.spec.ports.map((p: any) => [p.port, p.targetPort])).toEqual([
        [7490, "public"],
        [7491, "tunnel"],
        [7493, "api"],
      ]);
      // The control plane on the API port alone, runs on the tunnel port alone.
      const policy = find(objects, "NetworkPolicy", "previews", "ryph");
      expect(policy.spec.egress ?? []).toEqual([]);
      expect(policy.spec.ingress).toEqual([
        {
          from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "control-plane" } } }],
          ports: [{ port: 7493 }],
        },
        {
          from: [{
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ryph-runs" } },
            podSelector: { matchLabels: { "app.kubernetes.io/component": "agent-run" } },
          }],
          ports: [{ port: 7491 }],
        },
      ]);
      // The control plane calls the API port, and hands runs the tunnel port.
      const cp = envOf(find(objects, "Deployment", "control-plane", "ryph"));
      expect(cp.RYPH_PREVIEWS_URL).toBe("http://previews.ryph.svc:7493");
      expect(cp.RYPH_RUN_PREVIEWS_URL).toBe("http://previews.ryph.svc:7491");
    });

    test("several replicas: a Deployment and a Service per ordinal, its ordinal in its env", () => {
      const objects = withReplicas(3);
      const ds = deployments(objects);
      expect(ds.map((d) => d.metadata.name)).toEqual(["previews-0", "previews-1", "previews-2"]);
      ds.forEach((d, k) => {
        expect(d.spec.replicas).toBe(1);
        expect(d.spec.strategy).toEqual({ type: "Recreate" });
        expect(d.spec.minReadySeconds).toBeUndefined();
        expect(d.spec.template.spec.securityContext.sysctls.map((x: any) => x.name)).toEqual([
          "net.ipv4.tcp_rmem",
          "net.ipv4.tcp_wmem",
        ]);
        const own = { "app.kubernetes.io/name": "previews", "ryph.dev/previews-ordinal": `${k}` };
        expect(d.spec.selector).toEqual({ matchLabels: own });
        expect(d.spec.template.metadata.labels).toMatchObject(own);
        // Spread across zones and nodes where it can be, never refused for it.
        expect(d.spec.template.spec.topologySpreadConstraints).toEqual(
          ["topology.kubernetes.io/zone", "kubernetes.io/hostname"].map((topologyKey) => ({
            maxSkew: 1,
            topologyKey,
            whenUnsatisfiable: "ScheduleAnyway",
            labelSelector: { matchLabels: { "app.kubernetes.io/name": "previews" } },
          })),
        );
        const env = envOf(d);
        expect(env.RYPH_PREVIEWS_REPLICAS).toBe("3");
        expect(env.RYPH_PREVIEWS_ORDINAL).toBe(`${k}`);
        expect(env.RYPH_PREVIEWS_PEER_HOST).toBe("previews-{ordinal}.ryph.svc");
        expect(env.RYPH_PREVIEWS_PEER_PORT).toBe("7492");
        expect(env.RYPH_PREVIEWS_POD_NAME).toBeUndefined();
        expect(d.spec.template.spec.containers[0].ports.map((p: any) => p.containerPort))
          .toEqual([7490, 7491, 7492, 7493]);
        // Each ordinal's own address, the one its peers and its runs' runners dial.
        const svc = find(objects, "Service", `previews-${k}`, "ryph");
        expect(svc.spec.selector).toEqual(own);
        expect(svc.spec.clusterIP).toBeUndefined();
        // Ready addresses only: an evicted pod on a dead node is never an endpoint beside its
        // replacement.
        expect(svc.spec.publishNotReadyAddresses).toBeUndefined();
        expect(svc.spec.ports.map((p: any) => [p.port, p.targetPort])).toEqual([
          [7491, "tunnel"],
          [7492, "peer"],
          [7493, "api"],
        ]);
      });
      // The Service the control plane, the front door and runs' first dial reach selects them all.
      const shared = find(objects, "Service", "previews", "ryph");
      expect(shared.spec.selector).toEqual({ "app.kubernetes.io/name": "previews" });
      expect(shared.spec.ports.map((p: any) => p.port)).toEqual([7490, 7491, 7493]);
      // One disruption at a time across the ordinals.
      const pdb = find(objects, "PodDisruptionBudget", "previews", "ryph");
      // A pod that is not ready never holds up a drain of another's node.
      expect(pdb.spec).toEqual({
        maxUnavailable: 1,
        unhealthyPodEvictionPolicy: "AlwaysAllow",
        selector: { matchLabels: { "app.kubernetes.io/name": "previews" } },
      });
      // The control plane takes a runner's tunnel address only from the replicas' own Services.
      const cp = find(objects, "Deployment", "control-plane", "ryph");
      expect(envOf(cp).RYPH_PREVIEWS_PEER_HOST).toBe("previews-{ordinal}.ryph.svc");
      expect(envOf(cp).RYPH_PREVIEWS_URL).toBe("http://previews.ryph.svc:7493");
      expect(envOf(cp).RYPH_RUN_PREVIEWS_URL).toBe("http://previews.ryph.svc:7491");
      expect(
        envOf(find(withReplicas(1), "Deployment", "control-plane", "ryph"))
          .RYPH_PREVIEWS_PEER_HOST,
      ).toBeUndefined();
      // The socket buffers' cap is a knob, for a cluster older than 1.32.
      for (const d of deployments(withReplicas(3, ["--set", "previews.capSocketBuffers=false"]))) {
        expect(d.spec.template.spec.securityContext.sysctls).toBeUndefined();
      }
      // A prefix moves the peer names with it.
      const acme = render([
        ...PROD,
        "--set",
        "namespaces.prefix=acme",
        "--set",
        "previews.enabled=true",
        "--set",
        "previews.domain=preview.example.net",
        "--set",
        "previews.replicas=2",
      ]).objects;
      expect(envOf(find(acme, "Deployment", "previews-1", "acme")).RYPH_PREVIEWS_PEER_HOST).toBe(
        "previews-{ordinal}.acme.svc",
      );
    });

    test("several replicas: peers reach each other's peer and API ports, and nothing else does", () => {
      const objects = withReplicas(3);
      const policies = objects.filter((o) => o.kind === "NetworkPolicy");
      const policy = find(objects, "NetworkPolicy", "previews", "ryph");
      // Ingress: the control plane on :7493, runs on :7491 (a run's direct dial to its owner
      // included: the rule selects every previews pod), and peers on :7492 and :7493.
      expect(policy.spec.podSelector).toEqual(previewsPeer.podSelector);
      expect(policy.spec.ingress).toEqual([
        {
          from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "control-plane" } } }],
          ports: [{ port: 7493 }],
        },
        {
          from: [{
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ryph-runs" } },
            podSelector: { matchLabels: { "app.kubernetes.io/component": "agent-run" } },
          }],
          ports: [{ port: 7491 }],
        },
        { from: [previewsPeer], ports: [{ port: 7492 }, { port: 7493 }] },
      ]);
      // Egress: the resolver (named, with the cache address) and its peers. Nothing else.
      expect(policy.spec.egress).toEqual([
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
            { ipBlock: { cidr: "169.254.20.10/32" } },
          ],
          ports: [{ port: 53, protocol: "UDP" }, { port: 53, protocol: "TCP" }],
        },
        { to: [previewsPeer], ports: [{ port: 7492 }, { port: 7493 }] },
      ]);
      // The public port is still the front door's alone, and a run reaches :7491 only, on every
      // previews pod.
      expect(
        policies.flatMap((p) => p.spec.ingress ?? []).filter((r: any) =>
          r.ports?.some((p: any) => p.port === 7490)
        ),
      ).toEqual([]);
      const runs = find(objects, "NetworkPolicy", "agent-run-to-previews", "ryph-runs");
      expect(runs.spec.egress).toEqual([{
        to: [{
          namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ryph" } },
          podSelector: { matchLabels: { "app.kubernetes.io/name": "previews" } },
        }],
        ports: [{ port: 7491 }],
      }]);
      // :7492 appears in no rule but the peers' own, and :7493 in none but theirs and the control
      // plane's: never a run's.
      for (const p of policies) {
        for (const r of [...(p.spec.ingress ?? []), ...(p.spec.egress ?? [])]) {
          if (r.ports?.some((port: any) => port.port === 7492)) {
            expect(p.metadata.name).toBe("previews");
            expect(r.from ?? r.to).toEqual([previewsPeer]);
          }
          if (r.ports?.some((port: any) => port.port === 7493)) {
            expect(p.metadata.name).toBe("previews");
            expect(JSON.stringify(r.from ?? r.to)).not.toContain("agent-run");
          }
        }
      }
    });

    test("the replica count is held to what the service accepts", () => {
      for (const n of ["0", "65", "1.5", '"3"']) {
        const r = helm([
          ...PROD,
          "--set",
          "previews.enabled=true",
          "--set",
          "previews.domain=preview.example.net",
          "--set-json",
          `previews.replicas=${n}`,
        ]);
        expect(r.ok).toBe(false);
      }
      for (const n of ["1", "64"]) {
        expect(
          helm([
            ...PROD,
            "--set",
            "previews.enabled=true",
            "--set",
            "previews.domain=preview.example.net",
            "--set-json",
            `previews.replicas=${n}`,
          ]).ok,
        ).toBe(true);
      }
    });
  });

  test("images default to the registry and appVersion, and a digest pins one", () => {
    const { objects } = render([
      ...PROD,
      "--set",
      "images.browser.digest=sha256:" + "a".repeat(64),
      "--set",
      "runs.browserSidecar=true",
    ]);
    const cp = find(objects, "Deployment", "control-plane").spec.template.spec.containers[0];
    expect(APP_VERSION).toMatch(/^(sha-[0-9a-f]{12}|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/);
    expect(cp.image).toBe(`quay.io/ryph/ryph-control-plane:${APP_VERSION}`);
    const browser = cp.env.find((e: any) => e.name === "RYPH_BROWSER_IMAGE").value;
    expect(browser).toBe(`quay.io/ryph/ryph-browser:${APP_VERSION}@sha256:${"a".repeat(64)}`);
    expect(
      find(objects, "Deployment", "artifact-thumbnails").spec.template.spec.containers[0].image,
    ).toBe(browser);
  });

  describe("gitlab", () => {
    const GITLAB = [
      ...PROD,
      "--set",
      "gitlab.enabled=true",
      "--set",
      "gitlab.url=https://git.example.com/gitlab",
      "--set",
      "gitlab.token=glpat-bot",
      "--set",
      "gitlab.webhookSecret=hook-master",
      "--set",
      "gitlab.clientId=gl-cid",
      "--set",
      "gitlab.clientSecret=gl-csecret",
      "--set",
      "gitlab.group=acme/eng",
    ];
    const secretData = (objects: any[], name: string) => {
      const s = find(objects, "Secret", name, "ryph");
      return Object.fromEntries(
        Object.entries(s.data).map(([k, v]) => [k, atob(v as string)]),
      ) as Record<string, string>;
    };
    const containerEnv = (objects: any[], name: string) =>
      find(objects, "Deployment", name).spec.template.spec.containers[0].env as any[];
    const plain = (env: any[]) =>
      Object.fromEntries(env.filter((e) => "value" in e).map((e) => [e.name, e.value]));

    test("off by default: no GitLab variable anywhere, the app's left empty", () => {
      const { objects } = render(PROD);
      expect(Object.keys(secretData(objects, "forge")).filter((k) => k.includes("GITLAB")))
        .toEqual([]);
      expect(containerEnv(objects, "forge").filter((e) => e.name.includes("GITLAB"))).toEqual([]);
      const app = plain(containerEnv(objects, "app"));
      expect(app.PUBLIC_GITLAB_URL).toBe("");
      expect(app.PUBLIC_GITLAB_CLIENT_ID).toBe("");
      // GitLab on alone turns forge tools on, as a GitHub App or Radicle does.
      const auto = (args: string[]) =>
        plain(containerEnv(render(args).objects, "control-plane")).RYPH_FORGE_TOOLS;
      expect(auto(PROD)).toBeUndefined();
      expect(auto(GITLAB)).toBe("on");
    });

    test("credentials go into the forge's Secret, the rest into plain env, the app's into the browser", () => {
      const { objects } = render(GITLAB);
      const forge = secretData(objects, "forge");
      expect(forge.RYPH_GITLAB_TOKEN).toBe("glpat-bot");
      expect(forge.RYPH_GITLAB_WEBHOOK_SECRET).toBe("hook-master");
      expect(forge.RYPH_GITLAB_CLIENT_ID).toBe("gl-cid");
      expect(forge.RYPH_GITLAB_CLIENT_SECRET).toBe("gl-csecret");
      const env = plain(containerEnv(objects, "forge"));
      expect(env.RYPH_GITLAB_URL).toBe("https://git.example.com/gitlab");
      expect(env.RYPH_GITLAB_MODE).toBe("bot");
      expect(env.RYPH_GITLAB_GROUP).toBe("acme/eng");
      const app = plain(containerEnv(objects, "app"));
      expect(app.PUBLIC_GITLAB_URL).toBe("https://git.example.com/gitlab");
      expect(app.PUBLIC_GITLAB_CLIENT_ID).toBe("gl-cid");
      // Nothing secret reaches the app's own Secret.
      expect(Object.keys(secretData(objects, "app")).filter((k) => k.includes("GITLAB")))
        .toEqual([]);
    });

    test("a token in a Secret you manage is read from it, and kept out of the chart's", () => {
      const { objects } = render([...GITLAB, "--set", "gitlab.tokenSecret=gl-token"]);
      expect(secretData(objects, "forge").RYPH_GITLAB_TOKEN).toBeUndefined();
      expect(containerEnv(objects, "forge").find((e) => e.name === "RYPH_GITLAB_TOKEN"))
        .toEqual({
          name: "RYPH_GITLAB_TOKEN",
          valueFrom: { secretKeyRef: { name: "gl-token", key: "token" } },
        });
    });

    test("deliveries reach the forge on an exact path, ahead of the automations prefix", () => {
      const routed = render([
        ...GITLAB,
        "--set",
        "ingress.enabled=true",
        "--set",
        "ingress.host=ryph.example.com",
        "--set",
        "httpRoute.enabled=true",
        "--set-json",
        'httpRoute.parentRefs=[{"name":"gw","namespace":"gw"}]',
      ]).objects;
      const paths = find(routed, "Ingress", "ryph").spec.rules[0].http.paths;
      const ingressTo = (path: string) => paths.find((p: any) => p.path === path);
      expect(ingressTo("/v1/hooks/gitlab")).toEqual({
        path: "/v1/hooks/gitlab",
        pathType: "Exact",
        backend: { service: { name: "forge", port: { number: 7412 } } },
      });
      // Ingress controllers may resolve overlapping paths in listed order: exact ones first.
      expect(paths.findIndex((p: any) => p.path === "/v1/hooks/gitlab"))
        .toBeLessThan(paths.findIndex((p: any) => p.path === "/v1/hooks/"));
      const rules = find(routed, "HTTPRoute", "ryph").spec.rules;
      expect(rules.find((r: any) => r.matches[0].path.value === "/v1/hooks/gitlab")).toEqual({
        matches: [{ path: { type: "Exact", value: "/v1/hooks/gitlab" } }],
        backendRefs: [{ name: "forge", port: 7412 }],
      });
      // Routed whether or not GitLab is on, as GitHub's path is: the forge answers for itself.
      const plainProd = render([
        ...PROD,
        "--set",
        "ingress.enabled=true",
        "--set",
        "ingress.host=ryph.example.com",
      ]).objects;
      expect(
        find(plainProd, "Ingress", "ryph").spec.rules[0].http.paths.map((p: any) => p.path),
      ).toEqual(["/v1/hooks/github", "/v1/hooks/gitlab", "/v1/hooks/", "/"]);
    });

    test("a GitLab on a private address opens memory's egress to it alone, on its port", () => {
      const memoryEgress = (args: string[]) =>
        find(render(args).objects, "NetworkPolicy", "memory").spec.egress as any[];
      const gitlabRule = (rules: any[]) =>
        rules.find((r) => r.to?.some((t: any) => t.ipBlock?.cidr === "10.20.0.8/32"));
      // Without the knob a private GitLab is behind the internet rule's private exceptions.
      expect(gitlabRule(memoryEgress(GITLAB))).toBeUndefined();
      const cidrs = ["--set-json", 'gitlab.egressCidrs=["10.20.0.8/32"]'];
      expect(gitlabRule(memoryEgress([...GITLAB, ...cidrs]))).toEqual({
        to: [{ ipBlock: { cidr: "10.20.0.8/32" } }],
        ports: [{ port: 443 }],
      });
      const onPort = memoryEgress([
        ...GITLAB,
        ...cidrs,
        "--set",
        "gitlab.url=http://git.lan:8080/gl",
      ]);
      expect(gitlabRule(onPort).ports).toEqual([{ port: 8080 }]);
      expect(
        gitlabRule(memoryEgress([...GITLAB, ...cidrs, "--set", "gitlab.url=http://git.lan"])).ports,
      )
        .toEqual([{ port: 80 }]);
      // GitLab off: the addresses open nothing.
      expect(gitlabRule(memoryEgress([...PROD, ...cidrs]))).toBeUndefined();
      // A CIDR is a CIDR.
      expect(helm([...GITLAB, "--set-json", 'gitlab.egressCidrs=["git.lan"]']).ok).toBe(false);
    });

    test("a CA in a Secret you manage is trusted by the forge (API and git) and memory", () => {
      const CA = ["--set", "gitlab.caSecret.name=gitlab-ca", "--set", "gitlab.caSecret.key=ca.crt"];
      const pod = (objects: any[], name: string) =>
        find(objects, "Deployment", name).spec.template.spec;
      const { objects } = render([...GITLAB, ...CA]);
      const forge = pod(objects, "forge");
      const memory = pod(objects, "memory");
      // The PEM, read-only, the one key of the Secret, readable by the service user.
      for (const spec of [forge, memory]) {
        expect(spec.volumes.find((v: any) => v.name === "gitlab-ca")).toEqual({
          name: "gitlab-ca",
          secret: {
            secretName: "gitlab-ca",
            items: [{ key: "ca.crt", path: "ca.pem" }],
            defaultMode: 292,
          },
        });
        expect(spec.containers[0].volumeMounts).toContainEqual({
          name: "gitlab-ca",
          mountPath: "/etc/ryph/gitlab-ca",
          readOnly: true,
        });
        expect(plain(spec.containers[0].env).NODE_EXTRA_CA_CERTS).toBe(
          "/etc/ryph/gitlab-ca/ca.pem",
        );
      }
      // git takes one bundle, which replaces its own: the system's and the instance's together,
      // built before the forge starts from the image's own bundle.
      expect(plain(forge.containers[0].env).GIT_SSL_CAINFO).toBe(
        "/etc/ryph/ca-bundle/ca-certificates.crt",
      );
      expect(plain(memory.containers[0].env).GIT_SSL_CAINFO).toBeUndefined();
      const init = forge.initContainers.find((c: any) => c.name === "ca-bundle");
      expect(init.image).toBe(forge.containers[0].image);
      expect(init.command.join(" ")).toContain(
        "cat /etc/ssl/certs/ca-certificates.crt /etc/ryph/gitlab-ca/ca.pem",
      );
      expect(init.volumeMounts).toContainEqual({ name: "ca-bundle", mountPath: "/out" });
      expect(forge.containers[0].volumeMounts).toContainEqual({
        name: "ca-bundle",
        mountPath: "/etc/ryph/ca-bundle",
        readOnly: true,
      });
      // The bundle comes before the migrations, which are not what needs it, and with them off too.
      const noMigrations = pod(
        render([...GITLAB, ...CA, "--set", "migrations.enabled=false"]).objects,
        "forge",
      );
      expect(noMigrations.initContainers.map((c: any) => c.name)).toEqual(["ca-bundle"]);
      // Without it nothing changes; with GitLab off it mounts nothing.
      for (const args of [GITLAB, [...PROD, ...CA]]) {
        const rendered = render(args).objects;
        for (const name of ["forge", "memory"]) {
          const spec = pod(rendered, name);
          expect(spec.volumes.some((v: any) => v.name === "gitlab-ca")).toBe(false);
          expect(plain(spec.containers[0].env).NODE_EXTRA_CA_CERTS).toBeUndefined();
        }
        expect(plain(pod(rendered, "forge").containers[0].env).GIT_SSL_CAINFO).toBeUndefined();
      }
      // Refused: a name without a key, a name no Secret can have, and a CA for plain http.
      expect(
        helm([
          ...GITLAB,
          "--set",
          "gitlab.caSecret.name=gitlab-ca",
          "--set",
          "gitlab.caSecret.key=",
        ]).ok,
      )
        .toBe(false);
      expect(helm([...GITLAB, "--set", "gitlab.caSecret.name=Not_A_Name"]).ok).toBe(false);
      const http = helm([...GITLAB, ...CA, "--set", "gitlab.url=http://git.lan"]);
      expect(http.ok).toBe(false);
      expect(http.err).toContain("gitlab.caSecret is set, but gitlab.url is http");
    });

    test("refuses what the forge would refuse at boot", () => {
      const without = helm([...PROD, "--set", "gitlab.enabled=true"]);
      expect(without.ok).toBe(false);
      expect(without.err).toContain("gitlab.token or gitlab.tokenSecret");
      // …unless the forge's Secret is yours, and the token in it.
      expect(
        helm([...PROD, "--set", "gitlab.enabled=true", "--set", "forge.existingSecret=mine"]).ok,
      ).toBe(true);
      for (const key of ["webhookSecret", "clientId", "group"]) {
        const r = helm([
          ...PROD,
          "--set",
          "gitlab.enabled=true",
          "--set",
          "gitlab.token=glpat-me",
          "--set",
          "gitlab.mode=user",
          "--set",
          `gitlab.${key}=x`,
        ]);
        expect(r.ok).toBe(false);
        expect(r.err).toContain(`gitlab.${key} is set, but gitlab.mode is user`);
      }
      const half = helm([...GITLAB, "--set", "gitlab.clientSecret="]);
      expect(half.ok).toBe(false);
      expect(half.err).toContain("gitlab.clientId and gitlab.clientSecret");
      // The schema: a mode GitLab has no name for, a URL with a query, a group that is no path.
      for (
        const bad of ["gitlab.mode=app", "gitlab.url=https://x.example?y=1", "gitlab.group=/acme"]
      ) {
        expect(helm([...GITLAB, "--set", bad]).ok).toBe(false);
      }
      const user = render([
        ...PROD,
        "--set",
        "gitlab.enabled=true",
        "--set",
        "gitlab.token=glpat-me",
        "--set",
        "gitlab.mode=user",
      ]).objects;
      expect(plain(containerEnv(user, "forge")).RYPH_GITLAB_MODE).toBe("user");
    });
  });

  test("the size classes a check's own pod may ask for reach the control plane only when set", () => {
    const envOf = (objects: any[]) =>
      Object.fromEntries(
        (find(objects, "Deployment", "control-plane").spec.template.spec.containers[0].env as any[])
          .filter((e) => "value" in e).map((e) => [e.name, e.value]),
      );
    expect(envOf(render(PROD).objects).RYPH_CHECKS_OWN_SIZES).toBeUndefined();
    const set = render([...PROD, "--set", "checks.ownSizes=large\\,standard"]).objects;
    expect(envOf(set).RYPH_CHECKS_OWN_SIZES).toBe("large,standard");
  });
});
