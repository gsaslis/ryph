// The version a release is published as: one number for the binary (release.ts), the images
// (images/publish.ts) and the Helm chart (deploy/helm/ryph/Chart.yaml).
//
// A commit tagged `vX.Y.Z` (a prerelease like `v0.2.0-rc.1` too) releases as `X.Y.Z`. Any other
// commit is an edge build, named `sha-<12>` as before. The tag is the only input: there is no
// version file to bump, so nothing can disagree with it but the chart, which has to carry the
// number in a commit and is checked against it here.
//
// A tagged release refuses a dirty tree, two version tags on one commit, a `--version` that is not
// the tag on HEAD, and a Chart.yaml that does not say the version.
//
//   bun run release:version                  # the version this checkout releases as, or why not
//   bun run release:version --stamp 0.1.0    # write it into Chart.yaml, before tagging

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { command } from "@ryph/process";
import { EDGE_TAG, SEMVER } from "../../host/src/images.ts";

const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
export const CHART = join(REPO_ROOT, "deploy", "helm", "ryph", "Chart.yaml");

export interface Version {
  /** What everything is published as: `0.1.0`, or `sha-<12>` (`-dirty` with local changes). */
  version: string;
  /** Whether `version` is a tagged release's semver. */
  semver: boolean;
  /** `sha-<12>`, the commit's edge tag, which a tagged release's images carry too. */
  shaTag: string;
  revision: string;
  dirty: boolean;
}

/** What git says about HEAD. */
export interface Checkout {
  revision: string;
  dirty: boolean;
  /** Every tag that points at HEAD. */
  tagsAtHead: string[];
}

/** `0.1.0` from `v0.1.0` or `0.1.0`, or null when it is not a semver. */
export function normalizeVersion(given: string): string | null {
  const bare = given.startsWith("v") ? given.slice(1) : given;
  return SEMVER.test(bare) ? bare : null;
}

/**
 * The version a checkout releases as. `expect` is a `--version` the person passed: the release
 * must then be exactly that tag. Throws on anything a release must refuse.
 */
export function resolveVersion(checkout: Checkout, expect?: string): Version {
  const shaTag = `sha-${checkout.revision.slice(0, 12)}`;
  const tagged = checkout.tagsAtHead
    .filter((tag) => tag.startsWith("v"))
    .map(normalizeVersion)
    .filter((v): v is string => v !== null);
  if (tagged.length > 1) {
    throw new Error(`HEAD carries several version tags (${tagged.map((v) => `v${v}`).join(", ")})`);
  }
  if (expect !== undefined) {
    const wanted = normalizeVersion(expect);
    if (wanted === null) throw new Error(`--version ${expect} is not a semver like 0.1.0`);
    if (tagged[0] !== wanted) {
      throw new Error(
        `--version ${wanted}, but HEAD is not tagged v${wanted}` +
          (tagged[0] ? ` (it is v${tagged[0]})` : "") +
          `: tag the release commit (git tag -a v${wanted}) and check it out`,
      );
    }
  }
  const base = { shaTag, revision: checkout.revision, dirty: checkout.dirty };
  if (tagged.length === 0) {
    return { ...base, version: checkout.dirty ? `${shaTag}-dirty` : shaTag, semver: false };
  }
  if (checkout.dirty) {
    throw new Error(
      `HEAD is tagged v${tagged[0]}, but the tree has uncommitted changes: a release is built ` +
        "from the tagged commit as committed",
    );
  }
  return { ...base, version: tagged[0], semver: true };
}

/** Chart.yaml's `version` and `appVersion`. */
export function chartVersions(yaml: string): { version?: string; appVersion?: string } {
  const field = (name: string) => yaml.match(new RegExp(`^${name}:\\s*"?([^"\\s#]+)"?`, "m"))?.[1];
  return { version: field("version"), appVersion: field("appVersion") };
}

/** Chart.yaml with `version` and `appVersion` set to `version`. */
export function stampChart(yaml: string, version: string): string {
  for (const name of ["version", "appVersion"]) {
    if (!new RegExp(`^${name}:`, "m").test(yaml)) throw new Error(`Chart.yaml has no ${name}`);
  }
  return yaml
    .replace(/^version:.*$/m, `version: ${version}`)
    .replace(/^appVersion:.*$/m, `appVersion: "${version}"`);
}

/** Why the chart does not match a tagged release, or null when it does. */
export function chartProblem(yaml: string, version: string): string | null {
  const got = chartVersions(yaml);
  if (got.version === version && got.appVersion === version) return null;
  return `Chart.yaml says version ${got.version ?? "none"}, appVersion ${
    got.appVersion ?? "none"
  }` +
    `, not ${version}: \`bun run release:version --stamp ${version}\`, commit, and tag that commit`;
}

async function git(...args: string[]): Promise<string | null> {
  try {
    const out = await command("git", { args, cwd: REPO_ROOT, stdout: "piped", stderr: "null" })
      .output();
    return out.success ? new TextDecoder().decode(out.stdout).trim() : null;
  } catch {
    return null;
  }
}

/** HEAD's commit, cleanliness and tags, or null where there is no git to ask. */
export async function readCheckout(): Promise<Checkout | null> {
  const revision = await git("rev-parse", "HEAD");
  if (revision === null || !/^[0-9a-f]{40}$/.test(revision)) return null;
  const status = await git("status", "--porcelain");
  const tags = await git("tag", "--points-at", "HEAD");
  return {
    revision,
    dirty: status !== "",
    tagsAtHead: (tags ?? "").split("\n").filter((t) => t !== ""),
  };
}

/**
 * The version this checkout releases as, for release.ts and images/publish.ts: everything
 * `resolveVersion` refuses, plus a tagged release whose Chart.yaml does not say its version.
 */
export async function releaseVersion(expect?: string): Promise<Version> {
  const checkout = await readCheckout();
  if (checkout === null) throw new Error("not a git checkout: a release is named by its commit");
  const resolved = resolveVersion(checkout, expect);
  if (resolved.semver) {
    const problem = chartProblem(readFileSync(CHART, "utf8"), resolved.version);
    if (problem !== null) throw new Error(problem);
  }
  return resolved;
}

/**
 * The tag a plain build (compile.ts, `bun run build`) bakes in: the release's version where it
 * would release, else `sha-<12>` or `sha-<12>-dirty`, and "" with no git. Never throws: a local
 * build at a tagged commit with local changes is an edge build.
 */
export async function buildVersion(): Promise<string> {
  const checkout = await readCheckout();
  if (checkout === null) return "";
  try {
    return resolveVersion(checkout).version;
  } catch {
    const sha = `sha-${checkout.revision.slice(0, 12)}`;
    return checkout.dirty ? `${sha}-dirty` : sha;
  }
}

/** Whether `tag` is a release or edge name a published build carries. */
export function isReleaseName(tag: string): boolean {
  return SEMVER.test(tag) || EDGE_TAG.test(tag);
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: { stamp: { type: "string" }, version: { type: "string" } },
    strict: true,
  });
  try {
    if (values.stamp !== undefined) {
      const version = normalizeVersion(values.stamp);
      if (version === null) throw new Error(`${values.stamp} is not a semver like 0.1.0`);
      writeFileSync(CHART, stampChart(readFileSync(CHART, "utf8"), version));
      console.error(
        `Chart.yaml: version and appVersion ${version}. Commit it, then tag v${version}.`,
      );
    } else {
      const v = await releaseVersion(values.version);
      console.log(v.version);
      console.error(
        v.semver ? `release ${v.version} (${v.shaTag})` : "edge build: HEAD has no version tag",
      );
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
