// Publishes a release of the `ryph` binary to files.ryph.ai, where install.sh fetches it.
//
//   bun run release                    # build, check, sign, upload, move the pointers
//   bun run release --version 0.1.0    # the same, refused unless HEAD is tagged v0.1.0
//   bun run release --dry-run          # everything but the upload (--no-image-check: before
//                                      # publishing the images)
//
// A release is this commit's four binaries (macOS and Linux, arm64 and x86_64), named by its
// version (scripts/version.ts): `0.1.0` at a commit tagged `v0.1.0`, else the edge name
// `sha-<12>`. That is also the tag of the images it pulls (packages/host/src/images.ts), and what
// `ryph --version` prints. So this refuses a dirty tree, a commit not on origin/main and a name
// already released, and refuses unless every image the binary can pull is already on quay.io
// at that tag for both linux platforms (`bun run images:publish` pushes them).
//
// Pointers: a tagged release moves `releases/latest` (what install.sh installs by default) and
// `releases/edge`, and uploads install.sh; an edge release moves `releases/edge` only. The Linux x86_64
// build is Bun's baseline one, for CPUs without AVX2. Each binary is built by compile.ts's
// `compileBinary`; this machine's own is run through `refusesHostileStart`, and the Linux ones
// print their version in a Debian container under docker (`--no-smoke` skips that).
//
// SHA256SUMS starts with a `release <tag>` line and is signed with an SSH key (`ssh-keygen -Y
// sign`, namespace `ryph-release`): install.sh verifies it with `ssh-keygen -Y verify`, which every
// Mac and current Linux already has, against the public key it carries, and checks the line names
// the release it asked for. The private key is RYPH_RELEASE_KEY, default ~/.ryph-release-key.
//
// Uploads go to the `ryph-files` R2 bucket (files.ryph.ai) with wrangler, logged in to the
// account that holds ryph.ai: releases/<tag>/{ryph-<os>-<arch>,SHA256SUMS,SHA256SUMS.sig}, then
// install.sh at the root, then the pointers, last, so nothing points at a half-uploaded release.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { command } from "@ryph/process";
import { SEMVER } from "../../host/src/images.ts";
import { compileBinary, refusesHostileStart } from "./compile.ts";
import { isReleaseName, releaseVersion } from "./version.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
const BUCKET = "ryph-files";
const WRANGLER = "wrangler@4.142.0";
const NAMESPACE = "ryph-release";
/** Every image a binary can pull by its baked tag. */
const IMAGES = ["agent", "browser", "tool-guard", "run-gate", "harness", "universal"];

const TARGETS = [
  { name: "darwin-arm64", target: "bun-darwin-arm64" },
  { name: "darwin-x64", target: "bun-darwin-x64" },
  { name: "linux-arm64", target: "bun-linux-arm64" },
  { name: "linux-x64", target: "bun-linux-x64-baseline" },
];

const { values: flags } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    "no-smoke": { type: "boolean", default: false },
    // For trying the build before the images are published; a dry run only.
    "no-image-check": { type: "boolean", default: false },
    // The version this must be: refused unless HEAD is tagged v<version>.
    version: { type: "string" },
  },
});

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

async function run(cmd: string, args: string[], opts: { cwd?: string; stdin?: string } = {}) {
  const child = await command(cmd, {
    args,
    cwd: opts.cwd ?? REPO_ROOT,
    stdin: opts.stdin === undefined ? "inherit" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (opts.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
  }
  const out = await child.output();
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  if (!out.success) {
    die(`${cmd} ${args.join(" ")} failed:\n${decode(out.stderr)}${decode(out.stdout)}`);
  }
  return decode(out.stdout);
}

/** The platforms quay.io has `ryph-<name>:<tag>` for, or null when it has no such tag. */
async function publishedPlatforms(name: string, tag: string): Promise<string[] | null> {
  const repo = `ryph/ryph-${name}`;
  const auth = await fetch(
    `https://quay.io/v2/auth?service=quay.io&scope=repository:${repo}:pull`,
  );
  if (!auth.ok) die(`quay.io refused a pull token for ${repo}: ${auth.status}`);
  const { token } = await auth.json() as { token: string };
  const res = await fetch(`https://quay.io/v2/${repo}/manifests/${tag}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.oci.image.index.v1+json, " +
        "application/vnd.docker.distribution.manifest.list.v2+json",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) die(`quay.io: ${repo}:${tag}: ${res.status}`);
  const index = await res.json() as {
    manifests?: { platform?: { os: string; architecture: string } }[];
  };
  return (index.manifests ?? []).flatMap((m) =>
    m.platform && m.platform.os !== "unknown" ? [`${m.platform.os}/${m.platform.architecture}`] : []
  );
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// RYPH_IMAGE_TAG would name the build whatever it says, skipping the clean-tree and tag checks:
// only a dry run may borrow another build's name.
let tag: string;
if (process.env.RYPH_IMAGE_TAG !== undefined) {
  if (!flags["dry-run"]) die("RYPH_IMAGE_TAG is set: a release is named by its own clean checkout");
  tag = process.env.RYPH_IMAGE_TAG;
  if (!isReleaseName(tag)) die(`RYPH_IMAGE_TAG=${tag} is neither a version nor sha-<12>`);
} else {
  const version = await releaseVersion(flags.version).catch((err: Error) => die(err.message));
  if (version.dirty) {
    die(`a release needs a clean checkout of a commit (this one would be ${version.version})`);
  }
  tag = version.version;
}
const tagged = SEMVER.test(tag);
console.error(`release ${tag}${tagged ? "" : " (edge: latest stays where it is)"}`);
if (!flags["dry-run"]) {
  // Only what was merged ships: the commit must be on origin/main.
  await run("git", ["fetch", "--quiet", "origin", "main"]);
  const merged = await command("git", {
    args: ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
    cwd: REPO_ROOT,
    stdout: "null",
    stderr: "null",
  }).output();
  if (!merged.success) die(`${tag} is not on origin/main: release only merged commits`);
  // Released files are cached as immutable: a second upload under the same tag would sit beside
  // the first one's cached copies.
  const existing = await fetch(`https://files.ryph.ai/releases/${tag}/SHA256SUMS`, {
    method: "HEAD",
  });
  if (existing.ok) die(`${tag} is already released`);
}
const key = process.env.RYPH_RELEASE_KEY ?? join(homedir(), ".ryph-release-key");
if (!existsSync(key)) die(`no release signing key at ${key}`);

if (flags["no-image-check"] && !flags["dry-run"]) die("--no-image-check is for a --dry-run");
if (!flags["no-image-check"]) {
  console.error(`release ${tag}: checking quay.io/ryph has its images…`);
}
for (const name of flags["no-image-check"] ? [] : IMAGES) {
  const platforms = await publishedPlatforms(name, tag);
  if (platforms === null) die(`quay.io/ryph/ryph-${name}:${tag} is not published`);
  for (const want of ["linux/amd64", "linux/arm64"]) {
    if (!platforms.includes(want)) die(`quay.io/ryph/ryph-${name}:${tag} has no ${want}`);
  }
}

const out = join(REPO_ROOT, "dist", "release", tag);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

console.error("building the UI…");
await run("bun", ["run", "build:app"], { cwd: PACKAGE_ROOT });

const sums: string[] = [];
for (const { name, target } of TARGETS) {
  const file = `ryph-${name}`;
  const output = join(out, file);
  console.error(`compiling ${file}…`);
  const { size } = await compileBinary({ output, target, imageTag: tag });
  console.error(`  ${(size / 1024 / 1024).toFixed(0)} MB`);
  sums.push(`${sha256(new Uint8Array(await readFile(output)))}  ${file}`);
}

const native = `ryph-${process.platform}-${process.arch}`;
if (existsSync(join(out, native))) {
  console.error(`checking ${native} refuses a hostile start…`);
  await refusesHostileStart(join(out, native));
}
if (!flags["no-smoke"]) {
  for (const arch of ["arm64", "x64"]) {
    console.error(`running ryph-linux-${arch} --version in a Debian container…`);
    const said = await run("docker", [
      "run",
      "--rm",
      "--platform",
      `linux/${arch === "x64" ? "amd64" : "arm64"}`,
      "-v",
      `${out}:/release:ro`,
      "debian:12-slim",
      `/release/ryph-linux-${arch}`,
      "--version",
    ]);
    if (!said.includes(tag)) die(`ryph-linux-${arch} --version said: ${said.trim()}`);
  }
}

const sumsPath = join(out, "SHA256SUMS");
// The first line names the release, inside what the key signs, so install.sh can tell one
// release's files from another's.
await writeFile(sumsPath, `release ${tag}\n${sums.join("\n")}\n`);
await run("ssh-keygen", ["-Y", "sign", "-q", "-f", key, "-n", NAMESPACE, sumsPath]);
const publicKey = (await readFile(`${key}.pub`, "utf8")).trim().split(/\s+/).slice(0, 2).join(" ");
const installer = await readFile(join(PACKAGE_ROOT, "install.sh"), "utf8");
if (!installer.includes(publicKey)) {
  die(`install.sh does not carry ${key}.pub: it would refuse this release`);
}
const signers = join(out, ".allowed_signers");
await writeFile(signers, `releases@ryph.ai ${publicKey}\n`);
await run("ssh-keygen", [
  "-Y",
  "verify",
  "-f",
  signers,
  "-I",
  "releases@ryph.ai",
  "-n",
  NAMESPACE,
  "-s",
  `${sumsPath}.sig`,
], { stdin: await readFile(sumsPath, "utf8") });
await rm(signers);
console.error(`signed SHA256SUMS:\n${sums.join("\n")}`);

if (flags["dry-run"]) {
  console.error(`dry run: not uploading. The release is in ${out}`);
  process.exit(0);
}

async function put(object: string, file: string, contentType: string, cacheControl: string) {
  console.error(`uploading ${object}…`);
  await run("bunx", [
    WRANGLER,
    "r2",
    "object",
    "put",
    `${BUCKET}/${object}`,
    "--remote",
    "--file",
    file,
    "--content-type",
    contentType,
    "--cache-control",
    cacheControl,
  ]);
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const FRESH = "no-cache";
for (const { name } of TARGETS) {
  await put(
    `releases/${tag}/ryph-${name}`,
    join(out, `ryph-${name}`),
    "application/octet-stream",
    IMMUTABLE,
  );
}
await put(`releases/${tag}/SHA256SUMS`, sumsPath, "text/plain; charset=utf-8", IMMUTABLE);
await put(
  `releases/${tag}/SHA256SUMS.sig`,
  `${sumsPath}.sig`,
  "text/plain; charset=utf-8",
  IMMUTABLE,
);
// The installer at the root is the supported one: only a tagged release replaces it.
if (tagged) {
  await put(
    "install.sh",
    join(PACKAGE_ROOT, "install.sh"),
    "text/x-shellscript; charset=utf-8",
    FRESH,
  );
}
const pointer = join(out, "pointer");
await writeFile(pointer, `${tag}\n`);
for (const name of tagged ? ["edge", "latest"] : ["edge"]) {
  await put(`releases/${name}`, pointer, "text/plain; charset=utf-8", FRESH);
}
console.error(
  tagged
    ? `released ${tag}: curl -fsSL https://ryph.ai/install.sh | sh`
    : `released ${tag} on edge: curl -fsSL https://ryph.ai/install.sh | RYPH_VERSION=edge sh`,
);
