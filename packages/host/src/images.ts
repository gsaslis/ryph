// The images a docker deployment launches when nothing names them: the agent, the browser beside
// it, the tool guard in front of hosted MCP servers, and the gate a confined run reaches ryph
// through. And the two an environment build reads: the universal image it builds on and the
// harness layer it copies /opt/ryph from.
//
// The compiled `ryph` binary defaults to the published ones (images/publish.ts), pinned to the
// release it was built as: packages/ryph/scripts/compile.ts bakes RYPH_IMAGE_TAG in as the tag the
// publish script gives that build's images (a release's `0.1.0`, an edge build's `sha-<12>`; see
// packages/ryph/scripts/version.ts), so a downloaded binary runs agents on the runner it was
// released beside. A binary built from a dirty tree, or where the commit was not known, has no
// matching tag and falls back to `edge`, saying so in its status block.
//
// Run from source (`bun run up`, ./dev) RYPH_IMAGE_TAG is not defined at all, and the defaults are
// the `:dev` tags `bun run agent-image` builds into docker's store, as before; there is no browser
// unless RYPH_BROWSER_IMAGE names one.

/**
 * Defined by the binary's build (scripts/compile.ts): `0.1.0`, `sha-<12>`, `sha-<12>-dirty` or "".
 */
declare const RYPH_IMAGE_TAG: string | undefined;

/** A release's version, `0.1.0` or `0.2.0-rc.1`: semver without the `v` its git tag carries. */
export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** An edge build's tag: the commit it was built from. */
export const EDGE_TAG = /^sha-[0-9a-f]{12}$/;

/** Where ryph's images are published. */
export const IMAGE_REGISTRY = "quay.io/ryph";

/** The images ryph launches or builds from by itself under docker, by their short names. */
export type LaunchedImage =
  | "agent"
  | "browser"
  | "tool-guard"
  | "run-gate"
  | "harness"
  | "universal";

/** What the build baked in: undefined from source, a string (maybe empty) in the binary. */
export function bakedImageTag(): string | undefined {
  return typeof RYPH_IMAGE_TAG === "undefined" ? undefined : RYPH_IMAGE_TAG;
}

/** The published tag a binary built with `baked` pulls, and why it is not pinned when it is not. */
export function publishedTag(baked: string): { tag: string; pinned: true } | {
  tag: "edge";
  pinned: false;
  why: string;
} {
  if (SEMVER.test(baked) || EDGE_TAG.test(baked)) return { tag: baked, pinned: true };
  return {
    tag: "edge",
    pinned: false,
    why: /^sha-[0-9a-f]{12}-dirty$/.test(baked)
      ? `this binary was built from uncommitted changes (${baked}), which have no published images`
      : "this binary was built without a known commit",
  };
}

/**
 * The version a build reports (`ryph --version`): the release's `0.1.0`, an edge build's
 * `sha-<12>` (`-dirty` too), or `dev` from source and where the build knew no commit.
 */
export function ryphVersion(baked: string | undefined = bakedImageTag()): string {
  return baked ? baked : "dev";
}

/**
 * The image `name` defaults to: the published ref in the binary, the local `:dev` build from
 * source, and null for the browser from source (no browser unless one is named).
 */
export function defaultImage(
  name: LaunchedImage,
  baked: string | undefined = bakedImageTag(),
): string | null {
  if (baked === undefined) return name === "browser" ? null : `ryph-${name}:dev`;
  return `${IMAGE_REGISTRY}/ryph-${name}:${publishedTag(baked).tag}`;
}

/**
 * A line for the status block when the binary's defaults are not pinned to its own commit, or
 * null when they are (or when running from source, where they are local builds).
 */
export function imageDefaultsNote(baked: string | undefined = bakedImageTag()): string | null {
  if (baked === undefined) return null;
  const published = publishedTag(baked);
  if (published.pinned) return null;
  return `default images follow ${IMAGE_REGISTRY}'s \`edge\` tag: ${published.why}.`;
}

/**
 * The image an environment build reads (`RYPH_HARNESS_IMAGE`, `RYPH_ENV_BASE_IMAGE`) when nothing
 * names it: the agent image's sibling, same registry and tag, when the agent image is a
 * `ryph-agent` one, so the build matches the runs it replaces; else the default.
 */
export function environmentImage(
  name: "harness" | "universal",
  agentImage: string | null,
  baked: string | undefined = bakedImageTag(),
): string {
  const sibling = agentImage?.match(/^(.*\/)?ryph-agent(:[\w][\w.-]*)?$/);
  if (sibling) return `${sibling[1] ?? ""}ryph-${name}${sibling[2] ?? ""}`;
  return defaultImage(name, baked)!;
}
