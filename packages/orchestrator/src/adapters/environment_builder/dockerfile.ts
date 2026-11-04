// What every environment builder builds, whatever it builds WITH: the generated outer Dockerfile,
// the script that clones the checkouts OUTSIDE the build, and the names and limits the adapters
// share.
//
// The outer Dockerfile is a constant. Everything that varies between builds rides a build
// argument or a named context, so the file the control plane hands to BuildKit is the same bytes
// for every repo on every deployment, and the only thing a test has to pin is this one string:
//   RYPH_MACHINE   the machine — the repo's `.ryph/Dockerfile` built on its own first, or the
//                  deployment's universal image when the repo declares none
//   RYPH_HARNESS   the harness layer, whose /opt/ryph is copied on LAST
//   `checkout`     a named context: one clone per repo, with its .git, plus `.order`
// Its `baked` stage (1–3, no harness) is kept as an image of its own, and a RE-LAYER is a second
// constant file that starts from it: stage 4 alone, with RYPH_BAKED in place of the rest.
//
// Invariants:
// - the harness is the last thing copied, and nothing above it reads the harness image except
//   through a COPY of one small file — COPY is content-addressed, so a harness upgrade changes
//   the cache key of the final stage and of nothing below it. A `RUN --mount=from=harness`
//   would key the whole bake on the whole layer and throw every warm build away on each deploy
// - the base's three requirements (glibc, /bin/bash, git) are checked BEFORE the
//   bake, by name, with the harness's own checker; the full check (pi's Node included) runs once
//   the layer is on. A wrong base fails the build, never a run
// - the image runs `/opt/ryph/bin/ryph-runner` under the layer's tini (`-s`, never `-g`, with
//   RYPH_INIT=tini set for the runner) as uid 1994 whatever the repo's Dockerfile said, and a
//   base with no home for that uid gets one
// - no credential enters the build: the clone happens outside it, and the only secret-bearing
//   inputs are the predefined proxy build arguments, which BuildKit keeps out of the history
// - every value is validated here first (`assertBuildable`). The clone takes its values as
//   arguments, never as script text; one the build script splices in is single-quoted, so a ref,
//   a path or a URL is always one word

import { digestOf } from "../../helpers/digest.ts";
import { shellBody, shellConstants } from "../../helpers/shell.ts";
import CLONE_SH from "./sh/clone.sh" with { type: "text" };
import type { BuildSpec } from "../../ports/environment_builder.ts";
import {
  type SetupWarning,
  setupWarningsFrom,
  unreadableSetupWarning,
} from "../../core/setup_warnings.ts";

/** The public name a `.ryph/Dockerfile` writes in `FROM`; builders map it to the pinned copy. */
export const UNIVERSAL_IMAGE_NAME = "quay.io/ryph/ryph-universal";

/**
 * The spellings of the universal image a builder redirects. BuildKit matches a named context by
 * the `FROM` reference with `:latest` trimmed, so the bare name covers `FROM …` and `FROM …:latest`,
 * and `:1` is the tag the image publishes as (images/env/universal/Dockerfile).
 */
export const UNIVERSAL_IMAGE_REFS = [UNIVERSAL_IMAGE_NAME, `${UNIVERSAL_IMAGE_NAME}:1`] as const;

/** The same spellings as tags, for a builder that maps them by tagging a local image instead. */
export const UNIVERSAL_IMAGE_TAGS = [
  `${UNIVERSAL_IMAGE_NAME}:latest`,
  `${UNIVERSAL_IMAGE_NAME}:1`,
] as const;

/**
 * The build stage a run launches, the one below the harness layer (what a re-layer builds FROM),
 * and the one that only carries the toolchain record out.
 */
export const ENVIRONMENT_TARGET = "environment";
export const BAKED_TARGET = "baked";
export const TOOLCHAINS_TARGET = "toolchains";

/**
 * Where a build records the digest of the machine it was built on — root's, outside anything
 * setup.yml may write — and the warm file's target that carries it out. An incremental build
 * compares it with the machine as it builds now, and builds cold when they differ: the machine's
 * context is the whole repo (a Dockerfile that `COPY`s `rust-toolchain.toml`), so a change there
 * never shows in the `.ryph/` tree the warm source was chosen by.
 */
export const MACHINE_RECORD = "/usr/local/lib/ryph/machine";
export const MACHINE_RECORD_FILE = "machine";
export const MACHINE_RECORD_TARGET = "machine-record";

/** The warm Dockerfile's name beside the full one in the outer context. */
export const WARM_FILE = "Dockerfile.warm";

/** Where ryph-bake writes the toolchain record in the image, and where the toolchains target puts it. */
export const TOOLCHAINS_FILE = "toolchains.json";

/**
 * The setup warnings ryph-bake writes beside the toolchain record (@ryph/runner's bake.ts,
 * `SETUP_WARNINGS_OUT`): the repos whose setup.yml did not finish, which a build does not fail
 * over. Carried out by the toolchains target with the record. OPTIONAL there: a baked image from
 * before the file existed (what a re-layer starts from) has none, which means none.
 */
export const SETUP_WARNINGS_FILE = "setup-warnings.json";

/** The builder's record of member order, read by ryph-bake (`/ryph/work/.order`). */
export const ORDER_FILE = ".order";

/**
 * The proxy variables BuildKit predefines as build arguments: usable by every RUN step without an
 * `ARG` line, and kept out of the image's history — the one way to hand a step the egress claim
 * without writing it into a layer. Anything else in `proxyEnv` is not passed to the build.
 */
export const PROXY_BUILD_ARGS: ReadonlySet<string> = new Set(
  ["HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "NO_PROXY", "ALL_PROXY"].flatMap((k) => [
    k,
    k.toLowerCase(),
  ]),
);

/**
 * Stage 4 and what follows it, shared by the full file and the re-layer: the harness copied on,
 * the full check and the probe, the run user and the entrypoint, and the toolchain record carried
 * out. Starts in the `environment` stage, which each file opens FROM its own lower half — the
 * `baked` stage or image, whose user is already 1994, so the check runs as the run user.
 */
const HARNESS_LAYER =
  `# 4. the harness, last, so upgrading it never invalidates 1-3. Then the full check, and a probe
# that the runner and pi both start on this base.
COPY --from=harness /opt/ryph /opt/ryph
RUN /opt/ryph/lib/check-base.sh \\
 && /opt/ryph/bin/tini --version \\
 && out="$(/opt/ryph/bin/ryph-runner --ryph-build-probe 2>&1 || true)" \\
 && case "$out" in *"unexpected argument"*) ;; \\
      *) echo "ryph: the runner does not start on this base: $out" >&2; exit 1 ;; esac \\
 && if ! /opt/ryph/bin/pi --version >/dev/null 2>&1; then \\
      echo "ryph: pi does not start on this base" >&2; exit 1; \\
    fi
USER 1994:1994
WORKDIR /ryph/work
ENV RYPH_INIT=tini
ENTRYPOINT ["/opt/ryph/bin/tini", "-s", "--", "/opt/ryph/bin/ryph-runner"]

# The toolchain record ryph-bake wrote, on its own, so a builder can read it without the image,
# and its setup warnings beside it. The warnings are a wildcard, which COPY allows to match
# nothing: an image baked before ryph-bake wrote them has none.
FROM scratch AS ${TOOLCHAINS_TARGET}
COPY --from=${ENVIRONMENT_TARGET} /opt/ryph-env/${TOOLCHAINS_FILE} /opt/ryph-env/${
    SETUP_WARNINGS_FILE.slice(0, -1)
  }[${SETUP_WARNINGS_FILE.slice(-1)}] /
`;

/** The generated outer Dockerfile. See the header: it is the same for every build. */
export function environmentDockerfile(): string {
  return `# check=skip=InvalidDefaultArgInFrom
# Generated by ryph for an environment build. The repo never
# sees this file. Its inputs: RYPH_MACHINE (the repo's own image, or the universal image),
# RYPH_HARNESS (the harness layer) and the named context \`checkout\` (the clones, with .git).
ARG RYPH_MACHINE
ARG RYPH_HARNESS

FROM \${RYPH_HARNESS} AS harness

# 1. the machine: the repo's .ryph/Dockerfile, or the universal image
FROM \${RYPH_MACHINE} AS ${BAKED_TARGET}
USER root
# The base's three requirements, checked by name before anything runs on it, and a home for the
# run user when the base has none.
COPY --from=harness /opt/ryph/lib/check-base.sh /usr/local/lib/ryph/check-base.sh
RUN sh /usr/local/lib/ryph/check-base.sh --base-only \\
 && if ! grep -q '^[^:]*:[^:]*:1994:' /etc/passwd; then \\
      grep -q '^[^:]*:[^:]*:1994:' /etc/group || echo 'ryph:x:1994:' >> /etc/group; \\
      echo 'ryph:x:1994:1994:ryph run user:/home/runner:/bin/bash' >> /etc/passwd; \\
    fi \\
 && home="$(grep '^[^:]*:[^:]*:1994:' /etc/passwd | head -n 1 | cut -d: -f6)" \\
 && mkdir -p "\${home:-/home/runner}" /ryph/work /opt/ryph-env \\
 && chown 1994:1994 "\${home:-/home/runner}" /ryph/work /opt/ryph-env
# Which machine this is, for a later incremental build to check it still is (warmDockerfile).
# Root's, so nothing setup.yml runs can rewrite it.
ARG RYPH_MACHINE_DIGEST=
RUN printf '%s\\n' "\$RYPH_MACHINE_DIGEST" > ${MACHINE_RECORD}
# 2. the checkout(s), with .git, cloned outside the build
COPY --from=checkout --chown=1994:1994 / /ryph/work/
# 3. setup.yml at build time, as the run user, which also records the toolchain versions
COPY --from=harness /opt/ryph/bin/ryph-bake /usr/local/bin/ryph-bake
USER 1994:1994
RUN --network=default /usr/local/bin/ryph-bake --phase image /ryph/work

FROM ${BAKED_TARGET} AS ${ENVIRONMENT_TARGET}
${HARNESS_LAYER}`;
}

/**
 * The re-layer's Dockerfile: stage 4 alone, on the baked image of the environment it replaces
 * (RYPH_BAKED, pinned) — what "a harness upgrade re-layers every environment in seconds" means.
 * Nothing is cloned and nothing is baked, so the commit that image was built from does not have
 * to be on its branch any more. The old /opt/ryph was never in the baked image, so nothing is
 * layered over it and a re-layered image is no bigger than a fresh one.
 */
export function relayerDockerfile(): string {
  return `# check=skip=InvalidDefaultArgInFrom
# Generated by ryph to move an environment onto a new harness layer.
# Its inputs: RYPH_BAKED (the environment's own image below the harness) and RYPH_HARNESS.
ARG RYPH_BAKED
ARG RYPH_HARNESS

FROM \${RYPH_HARNESS} AS harness

FROM \${RYPH_BAKED} AS ${ENVIRONMENT_TARGET}
${HARNESS_LAYER}`;
}

/**
 * An INCREMENTAL build's Dockerfile: stages 2–3 again, on the baked image of an earlier build of
 * the same machine (RYPH_WARM, pinned), then stage 4. Its `machine-record` target reads out which
 * machine that image was built on; the builder builds this file only when that is the machine as
 * it builds now, and the full one otherwise (`MACHINE_RECORD`). Each checkout is moved to the commit this
 * build is of IN PLACE, from the fresh clone in the `checkout` context — bind-mounted, never
 * copied, so the clone costs no layer — and setup.yml reruns on the warm tree.
 *
 * The move is `fetch` plus `checkout --force`, which is what keeps it warm: git rewrites only the
 * files that differ between the two commits and deletes the ones the new commit dropped, so every
 * untouched file keeps its mtime and every ignored one (`target/`, `node_modules/`) is left alone
 * for the incremental rerun to find. A file setup left untracked but not ignored would survive
 * too, which is why the bake's clean-tree rule matters here as much as it does at run time.
 *
 * The commit and branch are read from the clone itself (the clone script leaves each at its
 * branch, reset to the built commit), so this file is a constant like the other two. The clone
 * was made by another uid, hence `safe.directory`, set in a throwaway global config: a `-c` on the
 * command line does not reach the `upload-pack` a local fetch spawns (measured, git 2.45). Its
 * progress lines are not `ryph:` lines, for the reason `failureLine` gives.
 */
export function warmDockerfile(): string {
  return `# check=skip=InvalidDefaultArgInFrom
# Generated by ryph for an incremental environment build. Its
# inputs: RYPH_WARM (an earlier build's baked image), RYPH_HARNESS and the named context
# \`checkout\` (fresh clones, with .git).
ARG RYPH_WARM
ARG RYPH_HARNESS

FROM \${RYPH_HARNESS} AS harness

# The machine the earlier build was made on, read out before this build commits to it.
FROM \${RYPH_WARM} AS warm-source
FROM scratch AS ${MACHINE_RECORD_TARGET}
COPY --from=warm-source ${MACHINE_RECORD} /${MACHINE_RECORD_FILE}

FROM \${RYPH_WARM} AS ${BAKED_TARGET}
USER 1994:1994
# 2. each checkout moved to the built commit in place: only the files that differ are rewritten
RUN --mount=type=bind,from=checkout,target=/ryph/incoming \\
    set -eu; \\
    export GIT_CONFIG_GLOBAL="$(mktemp)"; \\
    git config --global safe.directory '*'; \\
    g() { git "$@"; }; \\
    while IFS= read -r p; do \\
      src="/ryph/incoming/$p"; dst="/ryph/work/$p"; \\
      if [ ! -d "$dst/.git" ]; then \\
        echo "ryph: $p: the image this build starts from has no checkout there" >&2; exit 1; \\
      fi; \\
      ref="$(g -C "$src" symbolic-ref --short HEAD)"; commit="$(g -C "$src" rev-parse HEAD)"; \\
      g -C "$dst" fetch --quiet --no-tags "$src" HEAD; \\
      if [ "$(g -C "$dst" rev-parse FETCH_HEAD)" != "$commit" ]; then \\
        echo "ryph: $p: fetching $commit from the fresh clone did not arrive at it" >&2; exit 1; \\
      fi; \\
      g -C "$dst" update-index -q --refresh >/dev/null || true; \\
      g -C "$dst" checkout --quiet --force -B "$ref" "$commit"; \\
      g -C "$dst" update-ref "refs/remotes/origin/$ref" "$commit"; \\
      g -C "$dst" remote set-url origin "$(g -C "$src" remote get-url origin)"; \\
      echo "== $p at $commit"; \\
    done < /ryph/incoming/${ORDER_FILE}
# 3. setup.yml again, on the warm tree, with the current baker
COPY --from=harness /opt/ryph/bin/ryph-bake /usr/local/bin/ryph-bake
RUN --network=default /usr/local/bin/ryph-bake --phase image /ryph/work

FROM ${BAKED_TARGET} AS ${ENVIRONMENT_TARGET}
${HARNESS_LAYER}`;
}

/** The `sha256:…` a pinned reference names, or the reference itself when it pins none — how every
 * builder names a machine that is the base image itself. */
export function pinnedDigest(ref: string): string {
  return digestOf(ref) ?? ref;
}

export { shellQuote } from "../../helpers/shell.ts";

/** A checkout directory: one path segment, and never a dotfile (`.order` lives beside them). */
const CHECKOUT_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
/** A branch name, as git would accept it, minus anything a shell or git's argv could misread. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/+-]{1,200}(?<![./])$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** An image repository path component: what `<registry>/<subjectKey>` needs to be valid. */
const SUBJECT_KEY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * Refuses a spec no builder should run. Every one of these is the core's bug, not the repo's —
 * the values come from the store and the forge, never from a Dockerfile — so this throws, which
 * the port reserves for bugs.
 */
export function assertBuildable(spec: BuildSpec): void {
  if (!SUBJECT_KEY.test(spec.subjectKey) || spec.subjectKey.length > 100) {
    throw new Error(
      `environment build: subjectKey ${JSON.stringify(spec.subjectKey)} is not ` +
        "a lowercase image path component",
    );
  }
  if (spec.environmentId.trim() === "" || /[\r\n]/.test(spec.environmentId)) {
    throw new Error(`environment build: environmentId ${JSON.stringify(spec.environmentId)}`);
  }
  if (spec.checkouts.length === 0) throw new Error("environment build: no checkouts");
  const seen = new Set<string>();
  for (const checkout of spec.checkouts) {
    if (!CHECKOUT_PATH.test(checkout.path)) {
      throw new Error(`environment build: checkout path ${JSON.stringify(checkout.path)}`);
    }
    if (seen.has(checkout.path)) {
      throw new Error(`environment build: checkout path ${checkout.path} is listed twice`);
    }
    seen.add(checkout.path);
    if (!BRANCH.test(branchName(checkout.ref))) {
      throw new Error(`environment build: ${checkout.path}: ref ${JSON.stringify(checkout.ref)}`);
    }
    if (!COMMIT.test(checkout.commit)) {
      throw new Error(
        `environment build: ${checkout.path}: commit ${JSON.stringify(checkout.commit)}`,
      );
    }
    // A re-layer clones nothing: its checkouts are only the record of what it carries.
    if (spec.relayerFrom !== null) continue;
    const url = spec.clone.urls[checkout.path];
    if (url === undefined || /[\s]/.test(url) || url.startsWith("-")) {
      throw new Error(`environment build: ${checkout.path}: no usable clone URL`);
    }
  }
  if (spec.dockerfileFrom !== null && !seen.has(spec.dockerfileFrom)) {
    throw new Error(
      `environment build: dockerfileFrom ${spec.dockerfileFrom} is not one of the checkouts`,
    );
  }
  for (const [name, value] of Object.entries({ ...spec.clone.env, ...spec.proxyEnv })) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\r\n]/.test(value)) {
      throw new Error(`environment build: env ${JSON.stringify(name)} is not one line`);
    }
  }
  const images = [spec.baseImage, spec.harnessImage];
  if (spec.relayerFrom !== null) images.push(spec.relayerFrom);
  if (spec.warmFrom !== null) {
    if (spec.relayerFrom !== null) {
      throw new Error("environment build: a re-layer cannot also be an incremental build");
    }
    images.push(spec.warmFrom);
  }
  for (const image of images) {
    if (image.trim() === "" || /\s/.test(image)) {
      throw new Error(`environment build: image ${JSON.stringify(image)}`);
    }
  }
}

/** `refs/heads/main` → `main`: `git clone --branch` takes the short name. */
export function branchName(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/**
 * The bash script that clones every checkout into the current directory, in member order, and
 * writes `.order` (sh/clone.sh, which says how). The same text for every build: what to clone
 * reaches it as arguments (`cloneArgs`), never as script text.
 */
export function cloneScript(): string {
  return [shellConstants({ RYPH_ORDER_FILE: ORDER_FILE }), shellBody(CLONE_SH)].join("\n") + "\n";
}

/** `cloneScript`'s arguments: path, clone URL, branch and commit of every checkout, in order. */
export function cloneArgs(spec: Pick<BuildSpec, "checkouts" | "clone">): string[] {
  return spec.checkouts.flatMap((checkout) => [
    checkout.path,
    spec.clone.urls[checkout.path],
    branchName(checkout.ref),
    checkout.commit,
  ]);
}

/**
 * A name-safe rendering of an id, for a Job name, a label value or an image tag: lowercase
 * letters, digits and hyphens, at most `max` characters. An id that needed changing gets a short
 * hash of the original appended, so two ids that sanitise alike still get two names.
 */
export function safeName(id: string, max = 40): string {
  const lowered = id.toLowerCase();
  const cleaned = lowered.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned === lowered && cleaned.length <= max && cleaned !== "") return cleaned;
  // FNV-1a: synchronous, dependency-free, and only ever asked to tell two names apart.
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(id)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  const suffix = hash.toString(16).padStart(8, "0");
  const head = cleaned.slice(0, max - suffix.length - 1).replace(/-+$/, "");
  return head === "" ? suffix : `${head}-${suffix}`;
}

/**
 * The build log, kept in memory and capped: a build that prints gigabytes (a chatty `cargo
 * build`) must not take the control plane with it. Past the cap the HEAD is dropped, because the
 * end of a log is where a failure is.
 */
export class BuildLog {
  #chunks: string[] = [];
  #size = 0;
  #dropped = 0;
  constructor(private readonly cap = 8 * 1024 * 1024) {}

  append(text: string): void {
    if (text === "") return;
    this.#chunks.push(text.endsWith("\n") ? text : `${text}\n`);
    this.#size += text.length;
    while (this.#size > this.cap && this.#chunks.length > 1) {
      const head = this.#chunks.shift()!;
      this.#size -= head.length;
      this.#dropped += head.length;
    }
  }

  /** A line of the builder's own, set apart from BuildKit's output. */
  say(line: string): void {
    this.append(`ryph: ${line}`);
  }

  text(): string {
    const body = this.#chunks.join("");
    return this.#dropped > 0 ? `[… ${this.#dropped} earlier characters dropped]\n${body}` : body;
  }

  tail(lines = 40): string {
    return logTail(this.text(), lines);
  }
}

/** Our lines that say what a build is doing, and so are never the reason it failed. */
const PROGRESS_LINES = ["ryph: cloning ", "ryph: building", "ryph: re-layering "];

/**
 * The line that says WHY a build failed, when a step said so: the last thing ryph-bake or one of
 * the generated checks printed inside the build (BuildKit prefixes step output with its timing),
 * or the clone script's own complaint. Null when nothing of ours spoke — then BuildKit's error,
 * in the log tail, is the explanation.
 */
export function failureLine(log: string): string | null {
  let ours: string | null = null;
  let buildkit: string | null = null;
  for (const line of log.split("\n")) {
    const match = line.match(/^(?:#\d+ )?(?:[0-9.]+ )?(ryph(?:-bake)?: .+)$/);
    if (match && !PROGRESS_LINES.some((prefix) => match[1].startsWith(prefix))) {
      ours = match[1];
    }
    // BuildKit's own summary of a failed solve (a missing COPY source), or git's (a clone).
    const error = line.match(
      /^(?:error: |ERROR: |fatal: )(?:failed to build: )?(?:failed to solve: )?(.+)$/,
    );
    if (error) buildkit = error[1];
  }
  return ours ?? buildkit;
}

/** The last `lines` lines of a log, for a waiting run to show. */
export function logTail(log: string, lines = 40): string {
  const all = log.trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

/** The proxy build arguments for a spec, as `KEY=VALUE` pairs, in a stable order. */
export function proxyBuildArgs(proxyEnv: Record<string, string>): Array<[string, string]> {
  return Object.entries(proxyEnv)
    .filter(([key]) => PROXY_BUILD_ARGS.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Parses the setup warnings ryph-bake wrote, cleaned and bounded (core/setup_warnings.ts). No
 * record at all (null: an image baked before ryph-bake wrote one) is no warnings; a record that
 * is there but cannot be read — cut short, not JSON, or entries none of which is a warning — is
 * one `unreadable` warning, never a clean bill: whether setup.yml finished is unknown.
 */
export function parseSetupWarnings(text: string | null): SetupWarning[] {
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [unreadableSetupWarning()];
  }
  if (!Array.isArray(raw)) return [unreadableSetupWarning()];
  const warnings = setupWarningsFrom(raw);
  return raw.length > 0 && warnings.length === 0 ? [unreadableSetupWarning()] : warnings;
}

/** Parses the toolchain record ryph-bake wrote; anything malformed is an empty record. */
export function parseToolchains(text: string): Record<string, string> {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"
      ),
    );
  } catch {
    return {};
  }
}
