#!/usr/bin/env -S bun --no-env-file
/**
 * Builds every ryph image and pushes it to Quay — `bun run images:publish`.
 *
 * What a self-hoster pulls: deploy/compose (the binary, the launcher and the run images), the networked compose
 * example in deploy/compose-networked, and the `ryph` binary's own defaults
 * (packages/host/src/images.ts) all name these. Every image is `quay.io/ryph/ryph-<name>`, but the
 * binary's, which is `quay.io/ryph/ryph`, with its Radicle variant under the same name at
 * `<tag>-radicle`.
 *
 * Tags: the build's version (packages/ryph/scripts/version.ts): `0.1.0` at a commit tagged
 * `v0.1.0`, else `sha-<12>` for the commit. Then, once EVERY image has built and pushed, a tagged
 * release's images get the commit's `sha-<12>` too, and `edge` moves to them all, in one pass (a
 * registry-side copy, nothing rebuilt), so a failed build never leaves `edge` half on the new
 * commit. A built universal image also moves `1`, the tag repositories' `.ryph/Dockerfile`s
 * start FROM. A dirty tree is refused; with `--allow-dirty` an untagged commit's tag is `sha-<12>-dirty`
 * and `edge` stays where it was. `--version 0.1.0` refuses unless HEAD is tagged `v0.1.0`.
 *
 * Multi-arch (`linux/amd64,linux/arm64`) by default, through a buildx builder of its own
 * (docker-container driver, which multi-platform builds and attestations need) on Docker Desktop.
 * On an arm64 Mac the amd64 half runs emulated, and the Rust builds (radicle-node, radicle, the
 * binary's radicle variant) take a very long time that way: `--platform linux/amd64` for a first
 * push, or `--only` without them.
 *
 * The universal image is not rebuilt. A publish reads the digest `ryph-universal:1` points at and
 * tags that same image with its own tag (and `edge`, and a release's `sha-<12>`), registry-side,
 * once everything else has pushed. A deployment rebuilds every environment it has when the
 * universal digest changes, so rebuilding it is deliberate: `--build-universal` (or naming it in
 * `--only`) builds and pushes it like the others and moves `1` to the new build. A registry with
 * no `ryph-universal:1` yet is refused until one is built that way.
 *
 * The agent image is built FROM the universal image (the reused digest, or the one this run built)
 * and the harness layer this same run pushed, named by digest, never by a local tag. Before it is
 * pushed, one platform of it is loaded into docker and its init checked as PID 1
 * (agent/check_init.ts).
 *
 * Logging in is yours: `docker login quay.io -u 'ryph+<robot>'`, a robot account with write access.
 * Every repository is created public first (ensureQuayRepos), so nothing pushed lands private.
 *
 *   bun run images:publish --dry-run
 *   bun run images:publish --version 0.1.0
 *   bun run images:publish --platform linux/amd64
 *   bun run images:publish --only control-plane,app
 *   bun run images:publish --build-universal                             # rebuilds every environment
 *   bun run images:publish --registry localhost:5000/ryph --allow-dirty   # a test registry
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { command } from "../packages/process/src/mod.ts";
import { releaseVersion } from "../packages/ryph/scripts/version.ts";
import { checkInit } from "./agent/check_init.ts";

export const DEFAULT_REGISTRY = "quay.io/ryph";
/** The builder for the registry, and the one for a local test registry (which needs plain http). */
const BUILDER = "ryph-publish";
const LOCAL_BUILDER = "ryph-publish-local";
const DEFAULT_PLATFORMS = "linux/amd64,linux/arm64";
/**
 * What the builder's cache is trimmed to after a publish. Its own default allows 10% of Docker's
 * disk, which on Docker Desktop is the whole Mac's (measured: 93 GiB on a 1 TB laptop).
 */
const BUILDER_CACHE_MAX = "40gb";

/** One image: its short name (what `--only` takes), where it is built from, and what it is. */
export interface ImageSpec {
  name: string;
  /** The repository under the registry. */
  repo: string;
  dockerfile: string;
  target?: string;
  /** Appended to every tag: the binary's Radicle variant shares the binary's repository. */
  suffix?: string;
  /** Images this one is built FROM, by name: built first, handed in by digest. */
  needs?: string[];
  /** Extra moving tags beside `edge`. */
  moving?: string[];
  description: string;
}

const service = (name: string, what: string): ImageSpec => ({
  name,
  repo: `ryph-${name}`,
  dockerfile: `images/${name}/Dockerfile`,
  description: `${what} — a service of ryph's networked deployment`,
});

/** Every published image, in build order. */
export const IMAGES: ImageSpec[] = [
  service("control-plane", "Orchestrator and auth: runs, agents, policy, identity"),
  service("historian", "Run history"),
  service("model-proxy", "Model proxy: provider keys and run credentials"),
  service("mcp-gateway", "MCP gateway: tool servers and tool credentials"),
  service("forge", "Forge: the GitHub boundary and the git gateway"),
  service("automations", "Automations: webhook and cron triggers"),
  service("memory", "Memory: what agents remember"),
  service("chat", "Chat: Telegram, Zulip and Slack bots"),
  service("web", "Web search and fetch tools for agents"),
  service("previews", "Hosted previews of agents' dev servers"),
  service("app", "The web UI"),
  {
    name: "launcher",
    repo: "ryph-launcher",
    dockerfile: "images/launcher/Dockerfile",
    description: "The docker launcher: the one container of a compose deployment that holds the " +
      "docker socket",
  },
  {
    name: "egress-proxy",
    repo: "ryph-egress-proxy",
    dockerfile: "images/egress-proxy/Dockerfile",
    description: "The egress proxy: a run's one way out, through its allowlist",
  },
  {
    name: "tool-guard",
    repo: "ryph-tool-guard",
    dockerfile: "images/tool-guard/Dockerfile",
    description: "The tool guard in front of hosted MCP servers",
  },
  {
    name: "run-gate",
    repo: "ryph-run-gate",
    dockerfile: "images/run-gate/Dockerfile",
    description: "The run gate: a confined docker run's one door to ryph",
  },
  {
    name: "browser",
    repo: "ryph-browser",
    dockerfile: "images/browser/Dockerfile",
    description: "The browser sidecar a browser-enabled agent's run gets",
  },
  {
    name: "universal",
    repo: "ryph-universal",
    dockerfile: "images/env/universal/Dockerfile",
    moving: ["1"],
    description: "The universal environment: the machine agents run on, every mainstream toolchain",
  },
  {
    name: "harness",
    repo: "ryph-harness",
    dockerfile: "images/harness/Dockerfile",
    description: "The harness layer: the runner and pi under /opt/ryph, copied onto environments",
  },
  {
    name: "agent",
    repo: "ryph-agent",
    dockerfile: "images/agent/Dockerfile",
    needs: ["universal", "harness"],
    description: "The default agent image: the universal environment with the harness layer",
  },
  {
    name: "ryph",
    repo: "ryph",
    dockerfile: "images/ryph/Dockerfile",
    target: "ryph",
    description: "ryph, the single-process binary, for the Docker Compose deployment",
  },
  {
    name: "ryph-radicle",
    repo: "ryph",
    dockerfile: "images/ryph/Dockerfile",
    target: "ryph-radicle",
    suffix: "-radicle",
    description: "ryph, the single-process binary, with Radicle's CLI",
  },
  {
    name: "radicle-node",
    repo: "ryph-radicle-node",
    dockerfile: "images/radicle-node/Dockerfile",
    description: "A Radicle node built from upstream source, for ryph's optional Radicle forge",
  },
  {
    name: "radicle",
    repo: "ryph-radicle",
    dockerfile: "images/radicle/Dockerfile",
    description: "The Radicle bridge: ryph's forge over a Radicle node",
  },
];

/** The images `only` asks for, in build order, with what they are built FROM brought along. */
export function selectImages(only: string[] | null, images: ImageSpec[] = IMAGES): ImageSpec[] {
  if (only === null) return images;
  const known = new Set(images.map((image) => image.name));
  const unknown = only.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `unknown image ${unknown.join(", ")}; one of: ${[...known].join(", ")}`,
    );
  }
  const wanted = new Set(only);
  for (const image of images) {
    if (wanted.has(image.name)) { for (const need of image.needs ?? []) wanted.add(need); }
  }
  return images.filter((image) => wanted.has(image.name));
}

/** `quay.io/ryph/ryph-agent:sha-…`, with the image's suffix. */
export function refOf(registry: string, image: ImageSpec, tag: string): string {
  return `${registry}/${image.repo}:${tag}${image.suffix ?? ""}`;
}

/**
 * The tags an image gets once everything has pushed: `edge` and its own moving ones, and a tagged
 * release's commit tag (`sha` when the build is pushed under a version).
 */
export function movingTags(image: ImageSpec, sha?: string): string[] {
  return [...(sha ? [sha] : []), "edge", ...(image.moving ?? [])].map((tag) =>
    `${tag}${image.suffix ?? ""}`
  );
}

/** The universal image's short name: reused by digest unless a publish builds it on purpose. */
export const UNIVERSAL = "universal";
/** The tag a publish reads the reused universal image from, and moves when it builds a new one. */
export const UNIVERSAL_STABLE_TAG = "1";

/**
 * What a publish does with the universal image: `build` when asked to (`--build-universal`, or by
 * name in `--only`), `reuse` when the selection needs it anyway (everything, or `--only agent`),
 * `none` when nothing selected needs it.
 */
export function universalMode(
  only: string[] | null,
  buildUniversal: boolean,
  images: ImageSpec[] = IMAGES,
): "build" | "reuse" | "none" {
  if (buildUniversal || only?.includes(UNIVERSAL)) return "build";
  return selectImages(only, images).some((image) => image.name === UNIVERSAL) ? "reuse" : "none";
}

/**
 * The tags a reused image gets, registry-side, from the digest it already has: this publish's own
 * tag, then (unless the tree is dirty) the moving tags but its own, which already point there.
 */
export function reusedTags(image: ImageSpec, tag: string, dirty: boolean, sha?: string): string[] {
  const own = new Set((image.moving ?? []).map((t) => `${t}${image.suffix ?? ""}`));
  const moving = dirty ? [] : movingTags(image, sha).filter((t) => !own.has(t));
  return [`${tag}${image.suffix ?? ""}`, ...moving];
}

export interface BuildPlan {
  image: ImageSpec;
  ref: string;
  argv: string[];
}

/**
 * The `docker buildx build` argv for one image. `from` maps a needed image's name to the ref
 * (by digest) it is built FROM; `output` is `--push` for the real thing, `--load` for the agent's
 * pre-push check.
 */
export function buildArgv(opts: {
  image: ImageSpec;
  registry: string;
  tag: string;
  revision: string;
  created: string;
  platforms: string;
  from: Record<string, string>;
  output: "--push" | "--load";
  metadataFile?: string;
  builder?: string;
}): string[] {
  const { image, tag, output } = opts;
  const ref = refOf(opts.registry, image, tag);
  // Bare for now: no source, title or description, blanked so a base image's own labels don't
  // show through either.
  const labels: Record<string, string> = {
    "org.opencontainers.image.source": "",
    "org.opencontainers.image.revision": opts.revision,
    "org.opencontainers.image.created": opts.created,
    "org.opencontainers.image.version": `${tag}${image.suffix ?? ""}`,
    "org.opencontainers.image.title": "",
    "org.opencontainers.image.description": "",
  };
  const buildArgs: Record<string, string> = {};
  if (image.name === "harness") buildArgs.RYPH_VERSION = tag;
  if (image.repo === "ryph") buildArgs.RYPH_IMAGE_TAG = tag;
  if (image.name === "agent") {
    buildArgs.UNIVERSAL_IMAGE = opts.from.universal;
    buildArgs.HARNESS_IMAGE = opts.from.harness;
  }
  const argv = [
    "buildx",
    "build",
    "--builder",
    opts.builder ?? BUILDER,
    "--platform",
    opts.platforms,
    "-f",
    image.dockerfile,
    ...(image.target ? ["--target", image.target] : []),
    ...Object.entries(buildArgs).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]),
    ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
  ];
  if (output === "--push") {
    // On the index too, which is where registries read a multi-arch image's metadata.
    argv.push(
      "--annotation",
      `index:org.opencontainers.image.revision=${opts.revision}`,
      "--provenance=mode=max",
      "--sbom=true",
    );
    if (opts.metadataFile) argv.push("--metadata-file", opts.metadataFile);
  } else {
    // The docker exporter keeps no attestations, and the check needs none.
    argv.push("--provenance=false", "--sbom=false");
  }
  argv.push("-t", output === "--push" ? ref : checkRef(image, tag), output, ".");
  return argv;
}

/** Where the agent's pre-push check loads it: a local name no registry serves. */
function checkRef(image: ImageSpec, tag: string): string {
  return `ryph-publish-check/${image.repo}:${tag}`;
}

// ── running it ────────────────────────────────────────────────────────────────────────────────

const ROOT = new URL("..", import.meta.url).pathname;
const decoder = new TextDecoder();

async function capture(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  const { code, stdout, stderr } = await command(cmd, {
    args,
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code, out: decoder.decode(code === 0 ? stdout : stderr).trim() };
}

async function stream(cmd: string, args: string[]): Promise<void> {
  const child = await command(cmd, { args, cwd: ROOT, stdout: "inherit", stderr: "inherit" })
    .spawn();
  const { code } = await child.status;
  if (code !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed (exit ${code})`);
}

/** A shell-pasteable rendering of an argv. */
function shell(cmd: string, args: string[]): string {
  return [cmd, ...args].map((a) =>
    /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`
  )
    .join(" ");
}

/** Whether docker holds credentials for `host`, read the way the docker CLI would. */
function loggedIn(host: string): boolean {
  const dir = process.env.DOCKER_CONFIG ?? join(homedir(), ".docker");
  let config: {
    auths?: Record<string, { auth?: string; identitytoken?: string }>;
    credsStore?: string;
    credHelpers?: Record<string, string>;
  };
  try {
    config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  } catch {
    return false;
  }
  const helper = config.credHelpers?.[host] ?? config.credsStore;
  if (helper) {
    const got = spawnSync(`docker-credential-${helper}`, ["get"], { input: host });
    if (got.status === 0) {
      try {
        return Boolean(JSON.parse(got.stdout.toString()).Secret);
      } catch {
        return false;
      }
    }
  }
  const entry = config.auths?.[host];
  return Boolean(entry?.auth || entry?.identitytoken);
}

/**
 * On Quay, makes sure every repository exists and is public BEFORE anything is pushed: a push
 * creates a missing repository private, and a run's container pulls with no credentials. Needs an
 * OAuth token with "Administer Repositories" for the namespace, read from RYPH_QUAY_TOKEN_FILE
 * (default ~/.ryph-quay-token) and only ever sent to quay.io as a bearer.
 */
async function ensureQuayRepos(registry: string, images: ImageSpec[], dryRun: boolean) {
  const namespace = registry.split("/").slice(1).join("/");
  const repos = [...new Set(images.map((image) => image.repo))];
  const tokenFile = process.env.RYPH_QUAY_TOKEN_FILE ?? join(homedir(), ".ryph-quay-token");
  if (dryRun) {
    console.log(`▸ quay: create or make public ${repos.length} repositories in ${namespace}\n`);
    return;
  }
  let token: string;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    throw new Error(
      `no Quay token at ${tokenFile}: a push would create private repositories. Generate an ` +
        `OAuth token with "Administer Repositories" for ${namespace} and save it there ` +
        "(or point RYPH_QUAY_TOKEN_FILE at it)",
    );
  }
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`https://quay.io/api/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  for (const repo of repos) {
    const got = await api(`/repository/${namespace}/${repo}`);
    if (got.status === 404) {
      const made = await api("/repository", {
        method: "POST",
        body: JSON.stringify({
          namespace,
          repository: repo,
          visibility: "public",
          description: "",
          repo_kind: "image",
        }),
      });
      if (!made.ok) throw new Error(`quay: creating ${repo} failed (${made.status})`);
      console.log(`  quay: created ${namespace}/${repo}, public`);
    } else if (got.ok) {
      if ((await got.json()).is_public !== true) {
        const changed = await api(`/repository/${namespace}/${repo}/changevisibility`, {
          method: "POST",
          body: JSON.stringify({ visibility: "public" }),
        });
        if (!changed.ok) throw new Error(`quay: making ${repo} public failed (${changed.status})`);
        console.log(`  quay: made ${namespace}/${repo} public`);
      }
    } else {
      throw new Error(`quay: reading ${repo} failed (${got.status})`);
    }
  }
  console.log();
}

/** Whether a registry is a local test one, reached over plain http with no login. */
function isLocalRegistry(host: string): boolean {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

/** The builder, created on Docker Desktop if missing; refuses one on another endpoint. */
async function ensureBuilder(
  builder: string,
  localRegistry: string | null,
  dryRun: boolean,
): Promise<void> {
  const found = await capture("docker", ["buildx", "inspect", builder]);
  if (found.code === 0) {
    const endpoint = found.out.match(/^Endpoint:\s*(\S+)/m)?.[1] ?? "";
    if (endpoint !== "desktop-linux") {
      throw new Error(
        `buildx builder ${builder} runs on ${endpoint || "an unknown endpoint"}, not Docker ` +
          `Desktop: docker buildx rm ${builder}, and run this again`,
      );
    }
    return;
  }
  // host networking, so a test registry on Docker Desktop's localhost is reachable from it.
  const args = [
    "buildx",
    "create",
    "--name",
    builder,
    "--driver",
    "docker-container",
    "--driver-opt",
    "network=host",
  ];
  let config: string | null = null;
  if (localRegistry !== null) {
    config = join(tmpdir(), `ryph-publish-buildkitd-${process.pid}.toml`);
    writeFileSync(
      config,
      `[registry."${localRegistry}"]\n  http = true\n  insecure = true\n`,
    );
    args.push("--buildkitd-config", config);
  }
  args.push("--bootstrap", "desktop-linux");
  console.log(`▸ ${shell("docker", args)}`);
  if (dryRun) return;
  try {
    await stream("docker", args);
  } finally {
    if (config) await rm(config, { force: true });
  }
}

/**
 * The digest `ref` points at on the registry: a multi-arch image's index digest, the one a retag
 * must keep. Refuses when it is missing, so a fresh registry never silently gets a new build.
 */
async function resolveDigest(ref: string): Promise<string> {
  const got = await capture("docker", [
    "buildx",
    "imagetools",
    "inspect",
    ref,
    "--format",
    "{{json .Manifest}}",
  ]);
  if (got.code !== 0) {
    throw new Error(
      `cannot read ${ref} (${got.out}). The universal image is reused from that tag, never ` +
        "rebuilt by default: pass --build-universal to build and push one (it moves " +
        `${UNIVERSAL_STABLE_TAG}, and every deployment then rebuilds its environments)`,
    );
  }
  const digest = JSON.parse(got.out).digest;
  if (typeof digest !== "string" || !digest.startsWith("sha256:")) {
    throw new Error(`no digest for ${ref} in: ${got.out}`);
  }
  return digest;
}

/** The digest a push recorded in its metadata file. */
async function digestFrom(metadataFile: string): Promise<string> {
  const meta = JSON.parse(await readFile(metadataFile, "utf8"));
  const digest = meta["containerimage.digest"];
  if (typeof digest !== "string") throw new Error(`no digest in ${metadataFile}`);
  return digest;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      platform: { type: "string" },
      only: { type: "string" },
      registry: { type: "string" },
      "dry-run": { type: "boolean" },
      "allow-dirty": { type: "boolean" },
      "build-universal": { type: "boolean" },
      version: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      "bun run images:publish [--dry-run] [--platform <list>] [--only <names>] " +
        "[--registry <host/namespace>] [--allow-dirty] [--version <x.y.z>] " +
        "[--build-universal]\n\nImages: " + IMAGES.map((image) => image.name).join(", ") +
        `\n\nThe universal image is reused from :${UNIVERSAL_STABLE_TAG} by digest unless ` +
        "--build-universal (or --only universal) asks for a new one, which every deployment " +
        "answers by rebuilding its environments.",
    );
    return;
  }
  const dryRun = values["dry-run"] ?? false;
  const registry = (values.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const host = registry.split("/")[0];
  const platforms = values.platform ?? DEFAULT_PLATFORMS;
  const only = values.only ? values.only.split(",").map((s) => s.trim()) : null;
  const buildUniversal = values["build-universal"] ?? false;
  const universal = universalMode(only, buildUniversal);
  // --build-universal beside an --only that leaves it out still builds it.
  const images = selectImages(
    only && universal === "build" && !only.includes(UNIVERSAL) ? [...only, UNIVERSAL] : only,
  );

  // Docker Desktop, never OrbStack: the builder and the login live there.
  const context = process.env.DOCKER_CONTEXT ?? "desktop-linux";
  if (context === "orbstack") {
    throw new Error("DOCKER_CONTEXT=orbstack: publish from Docker Desktop");
  }
  process.env.DOCKER_CONTEXT = context;

  // Refuses a tagged release from a dirty tree, or with a Chart.yaml that does not say it.
  const version = await releaseVersion(values.version);
  const { revision, dirty } = version;
  if (dirty && !values["allow-dirty"]) {
    throw new Error(
      "the tree has uncommitted changes: commit them, or pass --allow-dirty to publish " +
        "sha-<commit>-dirty without moving edge",
    );
  }
  const tag = version.version;
  // A tagged release's images carry the commit's edge name too.
  const sha = version.semver ? version.shaTag : undefined;
  const created = new Date().toISOString();
  const local = isLocalRegistry(host);
  const builder = local ? LOCAL_BUILDER : BUILDER;

  // The universal image to reuse, by the digest its stable tag points at now.
  const reused = new Map<string, string>();
  if (universal === "reuse") {
    const image = images.find((i) => i.name === UNIVERSAL)!;
    reused.set(UNIVERSAL, await resolveDigest(refOf(registry, image, UNIVERSAL_STABLE_TAG)));
  }

  console.log(`ryph images → ${registry}, ${tag}${dirty ? " (dirty: edge stays put)" : ""}`);
  console.log(`platforms ${platforms}, context ${context}, builder ${builder}\n`);
  for (const image of images) {
    const digest = reused.get(image.name);
    if (digest) {
      const tags = reusedTags(image, tag, dirty, sha).join(", ");
      console.log(
        `  ${image.name.padEnd(14)} not built: ${registry}/${image.repo}@${digest} ` +
          `(:${UNIVERSAL_STABLE_TAG}), then ${tags}`,
      );
      continue;
    }
    const after = image.needs?.length ? `  (FROM ${image.needs.join(" + ")} by digest)` : "";
    const moving = dirty ? "" : `, then ${movingTags(image, sha).join(", ")}`;
    console.log(`  ${image.name.padEnd(14)} ${refOf(registry, image, tag)}${moving}${after}`);
  }
  console.log();

  if (!dryRun && !local && !loggedIn(host)) {
    throw new Error(
      `docker is not logged in to ${host}: \`docker login ${host}\` with a robot account that ` +
        "can write to the namespace",
    );
  }
  if (host === "quay.io") await ensureQuayRepos(registry, images, dryRun);
  await ensureBuilder(builder, local ? host : null, dryRun);

  const digests = new Map<string, string>(reused);
  const pushed: { image: ImageSpec; ref: string; digest: string }[] = [];
  for (const image of images) {
    if (reused.has(image.name)) continue;
    const from: Record<string, string> = {};
    for (const need of image.needs ?? []) {
      const needed = images.find((i) => i.name === need)!;
      const digest = digests.get(need);
      from[need] = digest
        ? `${registry}/${needed.repo}@${digest}`
        : `${registry}/${needed.repo}@<digest of ${refOf(registry, needed, tag)}>`;
    }
    const metadataFile = join(tmpdir(), `ryph-publish-${process.pid}-${image.name}.json`);
    const common = { image, registry, tag, revision, created, platforms, from, builder };

    if (image.name === "agent") {
      // One platform into docker, its init run as a run runs it, before anything is pushed: the
      // machine's own when it is in the list (native), else the first (emulated).
      const native = `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`;
      const list = platforms.split(",");
      const checkPlatform = list.includes(native) ? native : list[0];
      const load = buildArgv({ ...common, platforms: checkPlatform, output: "--load" });
      console.log(
        `▸ ${image.name}: load ${checkPlatform} and check its init\n  ${shell("docker", load)}`,
      );
      if (!dryRun) {
        await stream("docker", load);
        const ok = await checkInit(checkRef(image, tag), { platform: checkPlatform });
        await capture("docker", ["image", "rm", checkRef(image, tag)]);
        if (!ok) throw new Error("the agent image failed its init check and was not pushed");
      }
    }

    const argv = buildArgv({ ...common, output: "--push", metadataFile });
    const ref = refOf(registry, image, tag);
    console.log(`▸ ${ref}\n  ${shell("docker", argv)}`);
    if (dryRun) continue;
    try {
      await stream("docker", argv);
      const digest = await digestFrom(metadataFile);
      digests.set(image.name, digest);
      pushed.push({ image, ref, digest });
    } finally {
      await rm(metadataFile, { force: true });
    }
  }

  // Everything built: only now do the moving tags follow, and a reused image gets this publish's
  // tag (even a dirty one's, which moves nothing else), copied from its digest so it stays the same.
  const moved: string[] = [];
  for (const image of images) {
    const digest = reused.get(image.name);
    if (dirty && !digest) continue;
    const source = digest ? `${registry}/${image.repo}@${digest}` : refOf(registry, image, tag);
    let targets = (digest ? reusedTags(image, tag, dirty, sha) : movingTags(image, sha))
      .map((t) => `${registry}/${image.repo}:${t}`);
    // A commit already published as an edge build keeps its `sha-` tag where it is: deployments
    // pin that tag's digest, and moving it would leave the old image untagged for the registry
    // to collect from under them.
    if (sha) {
      const shaRef = refOf(registry, image, sha);
      const { code } = await capture("docker", ["buildx", "imagetools", "inspect", shaRef]);
      if (code === 0) {
        console.log(`▸ ${shaRef} exists: left where it is`);
        targets = targets.filter((t) => t !== shaRef);
      }
    }
    const args = [
      "buildx",
      "imagetools",
      "create",
      "--builder",
      builder,
      ...targets.flatMap((t) => ["--tag", t]),
      source,
    ];
    console.log(`▸ ${targets.join(", ")} ← ${source}\n  ${shell("docker", args)}`);
    if (dryRun) continue;
    await stream("docker", args);
    moved.push(...targets);
  }

  if (dryRun) {
    console.log("\ndry run: nothing built, nothing pushed.");
    return;
  }
  console.log(`\npushed ${pushed.length} image${pushed.length === 1 ? "" : "s"} (${platforms}):`);
  for (const { image, ref, digest } of pushed) {
    const tags = dirty ? "" : `  (+ ${movingTags(image, sha).join(", ")})`;
    console.log(`  ${ref}@${digest}${tags}`);
  }
  for (const [name, digest] of reused) {
    const image = images.find((i) => i.name === name)!;
    console.log(
      `  ${refOf(registry, image, tag)}@${digest}  (reused from :${UNIVERSAL_STABLE_TAG})`,
    );
  }
  if (moved.length > 0) console.log(`\nmoved ${moved.length} tags to ${tag}.`);

  // Least recently used first. A failure only costs disk, so it never fails the publish.
  const pruned = await capture("docker", [
    "buildx",
    "prune",
    "--builder",
    builder,
    "--max-used-space",
    BUILDER_CACHE_MAX,
    "--force",
  ]);
  if (pruned.code !== 0) {
    console.warn(`\nwarning: trimming ${builder}'s cache failed: ${pruned.out}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\nerror: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
