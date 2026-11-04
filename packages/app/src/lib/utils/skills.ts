// How the skills screens say what the control plane answers: versions, commits, sync outcomes and
// failures in a person's words, and a skill's files in the order someone reads them.

import { isWebLink } from "$lib/api/forge";
import type {
  ForgeProvider,
  RunEvent,
  RunSkills,
  SkillFile,
  SkillSyncAnswer,
  SkillSyncFailure,
  SkillSyncTrigger,
} from "$lib/api/types";

/** Where a skill lives in a repo, and the one file every skill has. */
export const SKILLS_DIR = ".agents/skills";
export const SKILL_FILE = "SKILL.md";

/**
 * A version as it fits on a line: the first eight hex digits of the content digest. Two versions
 * of one skill are told apart at a glance, and the whole digest is a hover away.
 */
export function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, "").slice(0, 8);
}

type RepoLink = { provider: ForgeProvider; url: string };

/** A commit's page on its forge, or null where the forge has none to link: Radicle without an
 * explorer, or any repo whose address is not a web page. */
export function commitUrl(repo: RepoLink, commit: string): string | null {
  const base = webPages(repo);
  return base === null ? null : `${base}/commit/${encodeURIComponent(commit)}`;
}

/** Where a repo's commit and tree pages hang off: the repository on GitHub, its `/-` on GitLab,
 * nothing on a forge (or an address) with no web pages. */
function webPages(repo: RepoLink): string | null {
  if (!isWebLink(repo.url)) return null;
  if (repo.provider === "github") return webBase(repo.url);
  if (repo.provider === "gitlab") return `${webBase(repo.url)}/-`;
  return null;
}

// A connected repo's address can be its clone URL. GitHub (and GitLab) send a bare `…/repo.git`
// on to the repository, but not a path under it, so a link into the tree drops the suffix.
function webBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/\.git$/, "");
}

/** A skill's directory on its forge at a branch or commit, for the same forges `commitUrl`
 * links. */
export function skillDirUrl(repo: RepoLink, at: string, name: string): string | null {
  const base = webPages(repo);
  if (base === null) return null;
  const ref = at.split("/").map(encodeURIComponent).join("/");
  return `${base}/tree/${ref}/${SKILLS_DIR}/${encodeURIComponent(name)}`;
}

/** Why a read of the org skills repo failed, as a heading. */
export const SYNC_FAILURE_TITLE: Record<SkillSyncFailure, string> = {
  "missing-ref": "Branch no longer exists",
  unavailable: "Couldn't reach the repository",
  invalid: "Couldn't read the skills",
  error: "Sync failed",
};

export function syncFailureTitle(kind: SkillSyncFailure | null): string {
  return kind === null ? SYNC_FAILURE_TITLE.error : SYNC_FAILURE_TITLE[kind];
}

/** What started a read, as the history names it. */
export const SYNC_TRIGGER_LABEL: Record<SkillSyncTrigger, string> = {
  connect: "Connected",
  push: "Push",
  manual: "Sync now",
  reconcile: "Hourly",
};

/** "1 skill", "3 skills". */
export function skillCount(n: number): string {
  return `${n} skill${n === 1 ? "" : "s"}`;
}

/** What a connect or a Sync now did, as the toast after it says it. */
export function syncAnswerMessage(
  answer: SkillSyncAnswer,
): { tone: "success" | "info" | "error"; message: string } {
  switch (answer.outcome) {
    case "synced":
      return { tone: "success", message: `Synced ${skillCount(answer.sync?.skillCount ?? 0)}` };
    case "up-to-date":
      return { tone: "info", message: "Already up to date" };
    case "failed":
      return {
        tone: "error",
        message: answer.sync === null
          ? SYNC_FAILURE_TITLE.error
          : `${syncFailureTitle(answer.sync.failure)}: ${answer.sync.error ?? "no detail"}`,
      };
    case "superseded":
      // A later read answered first, or the settings moved to another repo or branch meanwhile.
      return {
        tone: "info",
        message: "Changed nothing: a later sync or a change of repository or branch came first",
      };
    case "not-connected":
      return { tone: "error", message: "No org skills repository is connected" };
  }
}

/**
 * A `SKILL.md` without its frontmatter: the page shows the fields on their own, and the body is
 * what reads as a document. Text without a closed frontmatter block comes back whole.
 */
export function skillBody(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match === null ? text : text.slice(match[0].length).replace(/^\s*\n/, "");
}

/** How a file of a skill is shown: a markdown file rendered, other text as code, the rest as its
 * size alone. */
export function skillFileKind(file: SkillFile): "markdown" | "text" | "binary" {
  if (file.text === null) return "binary";
  return /\.(md|markdown)$/i.test(file.path) ? "markdown" : "text";
}

/** A skill's files in reading order: `SKILL.md` first, then the rest by path. */
export function readingOrder<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) =>
    a.path === SKILL_FILE ? -1 : b.path === SKILL_FILE ? 1 : a.path.localeCompare(b.path)
  );
}

/**
 * The file a link in one of a skill's markdown files points at, when it points inside the skill:
 * `references/checks-yml.md` from `SKILL.md`, `../SKILL.md` from a reference. Null for a link
 * anywhere else (another site, an anchor, a path outside the skill or not in it), which is then
 * left to open as a link.
 */
export function resolveSkillLink(
  href: string,
  from: string,
  paths: readonly string[],
): string | null {
  if (
    href === "" || href.startsWith("#") || href.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(href)
  ) {
    return null;
  }
  let target: string;
  try {
    target = decodeURIComponent(href.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  const parts = from.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  const resolved = parts.join("/");
  return paths.includes(resolved) ? resolved : null;
}

/** The skill the guide offers to copy: the smallest one that is useful, frontmatter and all. */
export const EXAMPLE_SKILL = `---
name: release
description: How we cut a release. Read before tagging a version.
---

# Releasing

1. Make sure main is green.
2. Bump the version in package.json and add a CHANGELOG entry.
3. Tag the commit as v<version> and push the tag.
`;

/** What a run had from each source, and what it lost, as the run's details list them. */
export interface RunSkillsView {
  catalogue: string[];
  org: { repoRef: string; commit: string; stale: boolean; names: string[] } | null;
  /** The working-repo skills the runner loaded, each with the checkout it came from. */
  repo: { name: string; path: string }[];
  workingRepos: boolean;
  /** The directory the runner wrote the run's skills under, once it said so. */
  root: string | null;
  /** Each skill left out, and why, in the app's words. */
  dropped: SkillDropView[];
}

/**
 * A skill a run left out, read off the trail. `where` is how the run details name its source
 * ("Ryph", "org", or the repo path); null when the line could not be read, and then `reason` is
 * the line as the trail wrote it.
 */
export interface SkillDropView {
  name: string;
  where: string | null;
  reason: string;
}

/** The source words the control plane's trail uses (core/skills.ts, describeDrops), and ours. */
const DROP_WINNERS: Record<string, string> = {
  "ryph's catalogue": "a Ryph skill",
  "the org skills repo": "an org skill",
  "a working repo": "a repo skill",
};

/** Each reason the trail can give, by how its sentence starts, in the app's words. */
const DROP_REASONS: { trail: RegExp; say: (match: RegExpExecArray) => string }[] = [
  {
    trail: /^the name is already taken by a skill from (.+?)(?=;|$)/,
    say: (m) => `Name already used by ${DROP_WINNERS[m[1]] ?? "another skill"}`,
  },
  { trail: /^over the .*?listing cap/, say: () => "Too many skills for one run" },
  {
    trail: /^names starting with ".*?" are reserved for ryph/,
    say: () => "Only Ryph skills may start with ryph-",
  },
  { trail: /^it did not validate/, say: () => "Not a valid skill" },
  { trail: /^its files could not be loaded/, say: () => "Its files could not be loaded" },
];

/**
 * One line of a `skills.dropped` event, as the control plane words it:
 * ``deploy (`api/`): the name is already taken by a skill from ryph's catalogue; more``.
 * The name, where it came from and why, with whatever the producer added after the reason kept
 * as written. A line in any other shape is kept whole.
 */
export function parseSkillDrop(line: string): SkillDropView {
  const match = /^(\S+) \((catalogue|org|`(.*?)\/?`)\): (.*)$/.exec(line);
  if (match === null) return { name: "", where: null, reason: line };
  const [, name, source, path, rest] = match;
  const where = source === "catalogue" ? "Ryph" : source === "org" ? "org" : `in ${path}/`;
  for (const { trail, say } of DROP_REASONS) {
    const reason = trail.exec(rest);
    if (reason === null) continue;
    const extra = rest.slice(reason[0].length).replace(/^;\s*/, "").trim();
    return { name, where, reason: extra === "" ? say(reason) : `${say(reason)}: ${extra}` };
  }
  return { name, where, reason: rest };
}

/**
 * A run's skills by source. The frozen ones come from the run itself; the working repos' and the
 * drops only from its trail, where the control plane and the runner each record theirs.
 */
export function runSkillsView(skills: RunSkills, events: readonly RunEvent[]): RunSkillsView {
  const lines = (kind: string) =>
    events.filter((e) => e.kind === kind).flatMap((e) =>
      (e.detail ?? "").split("\n").filter((l) => l.trim() !== "")
    );
  const named = (source: "catalogue" | "org") =>
    skills.skills.filter((s) => s.source === source).map((s) => s.name);
  return {
    catalogue: named("catalogue"),
    org: skills.org === null ? null : {
      repoRef: skills.org.repoRef,
      commit: skills.org.commit,
      stale: skills.org.stale,
      names: named("org"),
    },
    // The runner words each as "name (`path/`)".
    repo: lines("skills.repo").map((line) => {
      const match = /^(\S+) \(`(.*?)\/?`\)$/.exec(line);
      return match === null ? { name: line, path: "" } : { name: match[1], path: match[2] };
    }),
    workingRepos: skills.workingRepos,
    root: lines("skills.root").at(-1)?.trim() ?? null,
    dropped: lines("skills.dropped").map(parseSkillDrop),
  };
}

/** A read of one of the run's own skills: which skill, and which of its files. */
export interface SkillRead {
  name: string;
  source: "catalogue" | "org" | "repo";
  /** The file within the skill, `SKILL.md` for the skill itself. */
  file: string;
}

// Where the runner writes every skill it hands the agent (runner/src/helpers/skills.ts,
// `skillDir`), under the root it reports: `catalogue/<name>/`, `org/<name>/` or
// `repo/<checkout>/<name>/`, each a single segment.
const SKILL_PATH = /^(?:(catalogue|org)|repo\/([^/]+))\/([^/]+)\/(.+)$/;

/**
 * Which of the run's skills a read opened, if any. A harness with no skill tool of its own loads a
 * skill by reading its `SKILL.md`, so that read is the loading. Only a name the run actually holds
 * counts: a file that merely looks the part stays a plain read.
 */
export function skillRead(path: string, view: RunSkillsView | null): SkillRead | null {
  // Only under the directory the runner reported: a checkout file laid out the same way, under
  // a directory named like it, is the repo's content and stays a plain read.
  if (view?.root == null || !path.startsWith(`${view.root}/`)) return null;
  const match = SKILL_PATH.exec(path.slice(view.root.length + 1));
  if (match === null) return null;
  const [, frozen, checkout, name, file] = match;
  // A path that climbs back out of the skill reads something else, whatever it passed through.
  if (file.split("/").some((segment) => segment === "." || segment === "..")) return null;
  const held = frozen === "catalogue"
    ? view.catalogue.includes(name)
    : frozen === "org"
    ? (view.org?.names.includes(name) ?? false)
    : view.repo.some((r) => r.name === name && r.path === checkout);
  if (!held) return null;
  return { name, source: frozen === "catalogue" || frozen === "org" ? frozen : "repo", file };
}
