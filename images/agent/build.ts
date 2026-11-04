#!/usr/bin/env -S bun --no-env-file
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "../../packages/process/src/mod.ts";
import { checkInit } from "./check_init.ts";

/**
 * Builds every image a local backend launches — the default agent image, the tool guard and
 * egress proxy that sit beside runs, the gate a confined docker run reaches ryph through, and the
 * browser an agent can be given — into docker's store.
 *
 * The agent image is three builds, in order, each feeding the next by tag:
 *   1. ryph-universal — the machine (images/env/universal)
 *   2. ryph-harness   — /opt/ryph and nothing else (images/harness)
 *   3. ryph-agent     — the first with the second layered on (images/agent)
 * Only the third is launched; the first two are kept because an environment build reads both
 * (`RYPH_ENV_BASE_IMAGE`, `RYPH_HARNESS_IMAGE`). The universal build is by far the slowest, and
 * docker's cache makes every run after the first a matter of seconds.
 *
 * Built for this machine's own architecture — arm64 on Apple silicon — so docker runs them
 * natively. What a deployment runs is built multi-arch by `bun run images:publish` (images/publish.ts).
 *
 *   bun run agent-image          # tag `dev`
 *   bun run agent-image v2       # tag `v2`
 */

// fileURLToPath, not `.pathname`: on Windows a file URL's pathname is "/C:/…", which is not a path
// anything can open.
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TAG = process.argv.slice(2).find((a) => a !== "--") ?? "dev";

async function run(cmd: string, args: string[]): Promise<boolean> {
  const { success } = await command(cmd, { args, cwd: ROOT }).output();
  return success;
}

async function output(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { success, stdout } = await command(cmd, {
      args,
      cwd: ROOT,
      stdout: "piped",
      stderr: "null",
    }).output();
    return success ? new TextDecoder().decode(stdout).trim() : null;
  } catch {
    return null;
  }
}

// The runner version the harness layer records in harness.json: the commit, marked dirty when
// the tree is, so a layer is never mistaken for the commit it is not.
const commit = await output("git", ["rev-parse", "--short=12", "HEAD"]) ?? "unknown";
const dirty = (await output("git", ["status", "--porcelain"])) !== "";
const version = dirty ? `${commit}-dirty` : commit;

const universal = `ryph-universal:${TAG}`;
const harness = `ryph-harness:${TAG}`;

// Relative to cwd=ROOT; docker takes forward slashes on every platform, so each stays one string.
const images: Array<{ image: string; dockerfile: string; args?: string[] }> = [
  { image: universal, dockerfile: "images/env/universal/Dockerfile" },
  {
    image: harness,
    dockerfile: "images/harness/Dockerfile",
    args: ["--build-arg", `RYPH_VERSION=${version}`],
  },
  {
    image: `ryph-agent:${TAG}`,
    dockerfile: "images/agent/Dockerfile",
    args: [
      "--build-arg",
      `UNIVERSAL_IMAGE=${universal}`,
      "--build-arg",
      `HARNESS_IMAGE=${harness}`,
    ],
  },
  { image: `ryph-tool-guard:${TAG}`, dockerfile: "images/tool-guard/Dockerfile" },
  { image: `ryph-egress-proxy:${TAG}`, dockerfile: "images/egress-proxy/Dockerfile" },
  // The door a confined docker run reaches ryph through (RYPH_DOCKER_GATE_IMAGE).
  { image: `ryph-run-gate:${TAG}`, dockerfile: "images/run-gate/Dockerfile" },
  { image: `ryph-browser:${TAG}`, dockerfile: "images/browser/Dockerfile" },
];

const built: string[] = [];

for (const { image, dockerfile, args = [] } of images) {
  console.log(`\n▶ building ${image}`);
  // From the repo root, never the Dockerfile's directory: the images copy the lockfile and the
  // workspace manifests, and none of them lives beside a Dockerfile.
  if (!await run("docker", ["build", "-f", dockerfile, ...args, "-t", image, "."])) {
    console.error(`✗ docker build failed for ${image}`);
    process.exit(1);
  }
  built.push(image);
  if (dockerfile === "images/agent/Dockerfile") {
    console.log(`▶ checking ${image}'s init as PID 1`);
    if (!await checkInit(image)) process.exit(1);
  }
}

console.log(`\n✓ ${built.join(", ")}`);
console.log("  in docker's store.");
