// The checkout, described for the agent: which repositories the root holds, where each one
// lives, what it is, and each one's context file — the block the system prompt carries because
// the agent starts at the root and cannot see any of this otherwise.
//
// Two things a single-repo run used to get for free have to be restored here deliberately. The
// agent no longer starts inside a repository, so it has to be told the layout. And pi loads
// context files (AGENTS.md and friends) at startup from its working directory and that
// directory's ANCESTORS only — never from a subdirectory, and never later as tools touch one
// (verified against pi 0.85.1, in its resource loader and empirically) — so a clone's context
// file one level down is not loaded at all. This block carries it instead: the same content at
// the same trust level a single-repo run would have loaded, under that repo's heading.
//
// Invariants:
// - the block is the PLATFORM's: it is composed unconditionally from the frozen entries, and
//   nothing in any clone can suppress or rewrite it — a context file is quoted inside it
// - a context file is fenced with a fence longer than any backtick run inside it, so it cannot
//   close its own quote and write in the document's voice; and it is bounded, per file and in
//   total, because the whole block rides the system prompt of every turn
// - the descriptions a person wrote — a repo's and the workspace's — are fenced the same way,
//   for the same reason. They are shared configuration: a workspace admin edits them, and they
//   ride into EVERY run on that workspace, other people's tasks included. Rendered raw into
//   the platform's own voice, a description could forge a `### repo` section of its own and
//   issue durable instructions the agent reads as the platform's.
// - the pick per directory mirrors pi's own: the first of AGENTS.override.md, AGENTS.md,
//   AGENTS.MD, CLAUDE.md, CLAUDE.MD — so a repo's file is read the way a single-repo run read it
// - a candidate is read only as a REGULAR file, and only up to its cap: a committed symlink to
//   /dev/zero or /proc/self/environ is skipped, not followed (helpers/read_bounded.ts)

import type { RepoEntry, StaleBase, WorkItem } from "../core/types.ts";
import { DEFAULT_LINE, lineBranch } from "@ryph/shared/lines";
import { fence } from "@ryph/shared/markdown";
import { inCode, isPlainRef } from "./commands.ts";
import { readBounded } from "./read_bounded.ts";

/** pi's candidates, in pi's order. First hit wins, per directory. */
export const CONTEXT_FILE_CANDIDATES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

/** One repo's context file may contribute this much; the rest is cut and said so. */
const CONTEXT_FILE_MAX_BYTES = 16_384;
/** All context files together, across the checkout. */
const CONTEXT_TOTAL_MAX_BYTES = 65_536;

export const LAYOUT_HEADING = "## Your checkout";

/** A context file as found: which candidate matched, and its text (possibly cut). */
export interface ContextFile {
  file: string;
  text: string;
  truncated: boolean;
}

/**
 * Reads the context file of one clone, pi's way: the first candidate that exists as a regular
 * file. Null when the directory has none. Bounded to `maxBytes` — a file over it is cut, not
 * refused, because a repo's oversized AGENTS.md should cost it the tail of its advice, not its
 * agent — and never read past that: one byte more than the cap is all it takes to know.
 */
export async function readContextFile(
  dir: string,
  maxBytes = CONTEXT_FILE_MAX_BYTES,
): Promise<ContextFile | null> {
  for (const file of CONTEXT_FILE_CANDIDATES) {
    const bytes = await readBounded(`${dir}/${file}`, maxBytes + 1);
    if (bytes === null) continue;
    // Decoded leniently either way, so a multibyte character split at the edge becomes one
    // replacement character rather than a throw.
    if (bytes.length <= maxBytes) {
      return { file, text: new TextDecoder().decode(bytes), truncated: false };
    }
    return {
      file,
      text: new TextDecoder().decode(bytes.subarray(0, maxBytes)),
      truncated: true,
    };
  }
  return null;
}

/**
 * The layout block: one section per repo, in checkout order, each with its path, name, ref,
 * whether its base came from a cache the upstream could not refresh (`staleBases`, by path),
 * the branch it merges into when that is not its ref, the description a person wrote, and its
 * context file quoted. Pure over its inputs — the files are read by the caller
 * (`describeCheckout`), so the rendering is testable as text.
 */
export function renderLayout(
  repos: readonly RepoEntry[],
  contextFiles: ReadonlyMap<string, ContextFile>,
  workspace: WorkItem["workspace"] = null,
  staleBases: readonly StaleBase[] = [],
  /** False: nothing ships, and the intro says so rather than promising a patch. */
  canOpenPatches = true,
): string {
  const several = repos.length > 1;
  // A fork pull request's head ships onto that pull request or nowhere — only the default line,
  // never a branch of its own (core/run.ts refuses one) — so the run is not told about lines.
  // Such a checkout is always alone (the control plane never puts a sibling beside it).
  const toldLines = !repos.some(isForkHead);
  const linesSentence = (repository: string) =>
    toldLines
      ? ` Unrelated changes${repository} go on separate branches started from ` +
        `${repository === "" ? "the" : "its"} base, as its section shows: each becomes its own ` +
        "change request, shipped with ryph__submit_patch naming the branch."
      : "";
  const intro = !canOpenPatches
    ? (several
      ? `Your working directory holds ${repos.length} repositories, each cloned into its own ` +
        "directory, listed below. Work inside them — the root itself is not a repository. " +
        "Each is checked out on its own branch, and nothing committed there leaves the run."
      : "Your working directory holds one repository, cloned into the directory below. Work " +
        "inside it — the root itself is not a repository. It is checked out on its own " +
        "branch, and nothing committed there leaves the run.")
    : several
    ? `Your working directory holds ${repos.length} repositories, each cloned into its own ` +
      "directory, listed below. Work inside them — the root itself is not a repository, and a " +
      "file left there is not part of any change. Each repository is checked out on its own " +
      "branch; whatever each one has committed on that branch when the run ends ships as a " +
      "separate patch, so a change that spans repositories becomes one patch per repository. " +
      "Say in each what the other parts are: they land independently." +
      linesSentence(" in one repository")
    : "Your working directory holds one repository, cloned into the directory below. Work " +
      "inside it — the root itself is not a repository, and a file left there is not part of " +
      "the change. It is checked out on its own branch; whatever is committed on that branch " +
      "when the run ends ships as the run's patch." + linesSentence("");

  const sections = repos.map((repo) => {
    const lines = [`### ${inCode(`${repo.path}/`)} — ${repo.name} @ ${inCode(repo.ref)}`, ""];
    // First under the heading: it changes what every step below can rely on, and the agent's
    // summary is asked to carry it.
    const stale = staleBases.find((base) => base.path === repo.path);
    if (stale !== undefined) {
      lines.push(
        `The upstream could not be reached when this run started, so ${inCode(stale.ref)} was ` +
          `served from Ryph's cache at \`${stale.commit.slice(0, 7)}\` and may be behind ` +
          `upstream: every attempt to refresh it since ${stale.since} has failed. Steps that ` +
          "need the upstream (ryph__update_from_base, ryph__checkout_change_request, the forge " +
          "tools) may fail until it is back. If the work depends on recent upstream changes, " +
          "say so in your summary.",
        "",
      );
    }
    if (repo.description !== null && repo.description.trim() !== "") {
      lines.push(
        "What it is, as the workspace describes it:",
        "",
        fence(repo.description.trim()),
        "",
      );
    }
    const work = lineBranch(repo.branchNamespace, DEFAULT_LINE, 1);
    const base = repo.targetRef ?? repo.ref;
    lines.push(
      canOpenPatches && !isForkHead(repo)
        ? `Branch: ${inCode(work)}. A separate change starts on its own branch` +
          (isPlainRef(base)
            ? `: \`git switch -c <name> origin/${base}\`.`
            : ` from ${
              inCode(`origin/${base}`)
            } (its name holds characters a shell reads: quote it).`)
        : `Branch: ${inCode(work)}.`,
    );
    if (repo.targetRef !== undefined && repo.targetRef !== repo.ref) {
      lines.push(
        `It merges into ${inCode(repo.targetRef)}, fetched as ${
          inCode(`origin/${repo.targetRef}`)
        }; ` +
          "ryph__update_from_base merges it in when the branch has to catch up.",
      );
    }
    const context = contextFiles.get(repo.path);
    if (context !== undefined) {
      lines.push(
        "",
        `This repository's ${inCode(context.file)} — read it as you would at the root of the ` +
          "repository, and take it as applying inside that directory only:",
        "",
        fence(context.text.trimEnd()),
      );
      if (context.truncated) {
        lines.push(
          "",
          `(${inCode(`${repo.path}/${context.file}`)} is longer than this — it is cut short here.)`,
        );
      }
    }
    return lines.join("\n");
  });

  const about = workspace === null ? [] : (
    workspace.description !== null && workspace.description.trim() !== ""
      ? [
        `This checkout is the workspace **${workspace.name}**, described by its admins as:`,
        fence(workspace.description.trim()),
      ]
      : [`This checkout is the workspace **${workspace.name}**.`]
  );

  return [LAYOUT_HEADING, "", intro, ...about, "", ...sections].join("\n\n").replace(
    /\n{3,}/g,
    "\n\n",
  );
}

/**
 * Whether a checkout entry is a pull request's head — a contributor's files, configured from
 * nothing in them. The control plane says so (`forkHead`), and the ref says so too: the gateway
 * serves `refs/pull/<n>/head` as the local branch `pull/<n>/head`, and no branch of a repository
 * is ever served under that name (the control plane refuses one as a base), so a spec that
 * somehow lost the flag is still read as what it holds.
 */
export function isForkHead(repo: Pick<RepoEntry, "ref" | "forkHead">): boolean {
  return repo.forkHead === true || repo.ref.startsWith("pull/");
}

/**
 * Reads every clone's context file under a shared budget and renders the block. Repos are
 * visited in checkout order, and once the total is spent the remaining files are left out
 * and said so — the first repos' advice survives whole rather than every repo's being cut.
 *
 * Called before any repo's setup steps have run (see core/run.ts): what is quoted under a
 * repo's heading is then what that repository committed, and no clone can write into another
 * clone's section.
 */
export async function describeCheckout(
  root: string,
  repos: readonly RepoEntry[],
  workspace: WorkItem["workspace"] = null,
  staleBases: readonly StaleBase[] = [],
  canOpenPatches = true,
): Promise<string> {
  const files = new Map<string, ContextFile>();
  let budget = CONTEXT_TOTAL_MAX_BYTES;
  for (const repo of repos) {
    if (budget <= 0) break;
    // A fork head's AGENTS.md is a contributor's text: quoted here it would sit in the system
    // prompt as the repository's own advice. The agent can still read it, as material.
    if (isForkHead(repo)) continue;
    const found = await readContextFile(
      `${root}/${repo.path}`,
      Math.min(
        CONTEXT_FILE_MAX_BYTES,
        budget,
      ),
    );
    if (found === null) continue;
    budget -= new TextEncoder().encode(found.text).length;
    files.set(repo.path, found);
  }
  return renderLayout(repos, files, workspace, staleBases, canOpenPatches);
}
