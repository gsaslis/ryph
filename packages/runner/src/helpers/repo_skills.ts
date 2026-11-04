// A working repo's own skills: the
// `.agents/skills/<name>/SKILL.md` and `.claude/skills/<name>/SKILL.md` each repo commits, found in
// its own clones and added to what the control plane froze, below it in precedence.
//
// Repo content is untrusted: anyone who can commit to a repo the run checks out can put
// instructions in front of its agent this way. That is accepted, and it is the standing a repo's
// AGENTS.md already has (helpers/layout.ts quotes it into every run). What this file holds to is
// that a skill is what the repository COMMITTED, and nothing else:
//
// Invariants:
// - read from git objects at the clone's base commit, never from the worktree, and before any
//   setup step has run: a setup step cannot add or rewrite a skill, a sibling repo's setup cannot
//   plant one in a fresh clone, and a gitignored file is never a skill. Replace refs are ignored,
//   so a `refs/replace/` entry in the clone cannot stand in for a committed object either. An
//   ADOPTED checkout (helpers/adopt.ts) is the exception: its `.git/objects` came out of the
//   environment image's build, where every workspace repo's setup ran, and `cat-file` does not
//   re-hash what it reads. Such a checkout trusts what the build left behind, as it already does
//   for the build's outputs and dependencies the agent will run
// - the agent's policy is the control plane's to apply: a run that checks out the org skills repo
//   itself reads its skills as any working repo's, so an org skill the agent turned off loads
//   from that clone whenever working-repo skills are on. Only a skill frozen onto the run is
//   recognised as the org repo's own copy
// - symlinks and submodules are never followed, and every path is held to the skill path rules
//   before it is kept: nothing a repo holds can name a file outside its skill's directory
// - bounded before a byte of content is read: the listing itself (git is killed past
//   `MAX_REPO_SKILLS_LISTING_BYTES`), the skill directories and root links a repo may hold, each
//   skill's files and bytes from the listing's sizes, and every working repo's skills together;
//   one `git cat-file --batch` per repo reads what is left
// - precedence is fixed: a name the control plane froze (ryph's catalogue, the org skills repo)
//   wins, then the repos in the run's order, each in name order; a loser is dropped and said so,
//   never silently shadowed, and what is admitted stays within the budget the run was frozen with
// - a skill never fails the run: a repo that cannot be read costs that repo's skills, and the
//   caller says so

import type { SkillDrop, SkillDropReason, SkillOrigin, SkillSource } from "../core/types.ts";
import { errorMessage } from "./errors.ts";
import type { CatFileBatch, GitBounded } from "./git_exec.ts";
import {
  dropDetail,
  isSkillPath,
  listingBytes,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_MD_BYTES,
  MAX_SKILL_NAME,
  type PreparedRepoSkill,
  prepareRepoSkill,
  type RepoSkillFile,
  RESERVED_PREFIX,
  SKILL_NAME,
  skillDigest,
  skillDrop,
} from "./skills.ts";

/** The preferred directory a repo's skills are read from. */
export const SKILLS_DIR = ".agents/skills";
/** Discovery roots, in precedence order; all limits are shared, not per root. */
export const SKILLS_DIRS = [SKILLS_DIR, ".claude/skills"] as const;
/** The skill directories one working repo may hold; past it, the rest by name are left out. */
export const MAX_REPO_SKILL_DIRS = 32;
/** The bytes every working repo's skills may hold together, per run: disk in the container. */
export const MAX_REPO_SKILL_BYTES = 8 * 1024 * 1024;
/**
 * The most `ls-tree -r` of both skill roots together may print before the repo is passed over
 * unread: 4,096 entries, twice what the directories and files a repo may hold could need, at the
 * longest line a path a skill may hold can make (mode, type, a sha256 id, a padded size and
 * `MAX_SKILL_PATH` after `.agents/skills/` and the skill's name).
 */
export const MAX_REPO_SKILLS_LISTING_BYTES = 4_096 * 1_280;

/** One clone to look in. */
export interface RepoToRead {
  /** The checkout path the run names the repo by. */
  path: string;
  /** The clone's directory. */
  dir: string;
  /** The commit the clone started at: what the repository committed. */
  commit: string;
}

/** What the run found in its repos: the skills to write, the ones it will not, and what it
 * could not name on the trail (a directory whose name is no skill name, or a submodule committed
 * as `.agents/skills` itself, whose `path` is then that directory). */
export interface RepoSkills {
  prepared: PreparedRepoSkill[];
  dropped: SkillDrop[];
  unnamed: Array<{ repo: string; path: string; why: string }>;
  /** Repos that could not be read at all, with why. */
  unread: Array<{ repo: string; error: string }>;
  /** Optional frontmatter fields a loaded skill's SKILL.md got wrong, left out of what the agent
   * reads. Its skill is not dropped, so the trail has no line for them. */
  warnings: Array<{ repo: string; name: string; warning: string }>;
}

/** Why a repo skill is dropped: a collision names the source that holds the name. */
type DropWhy =
  & { detail?: string }
  & (
    | { reason: "collision"; winner: SkillOrigin["source"] }
    | { reason: Exclude<SkillDropReason, "collision"> }
  );

/** One entry of a repo's listing, relative to its discovery root. */
interface Listed {
  root: string;
  path: string;
  mode: string;
  id: string;
  size: number;
}

/**
 * Every working repo's skills, judged and put in precedence after the frozen ones: the frozen
 * names win, then each repo in order, and `budget` (what the frozen list left of the run's caps)
 * admits the rest in that order.
 */
export async function discoverRepoSkills(input: {
  repos: readonly RepoToRead[];
  frozen: ReadonlyArray<{ name: string; source: SkillSource; digest: string }>;
  budget: { skills: number; listingBytes: number };
  git: GitBounded;
  catFile: CatFileBatch;
}): Promise<RepoSkills> {
  const out: RepoSkills = { prepared: [], dropped: [], unnamed: [], unread: [], warnings: [] };
  const holders = new Map<string, { source: SkillSource | "repo"; digest?: string }>(
    input.frozen.map((s) => [s.name, { source: s.source, digest: s.digest }]),
  );
  let read = 0;
  let count = 0;
  let listing = 0;

  for (const repo of input.repos) {
    const drop = (name: string, why: DropWhy) => {
      if (isReportable(name)) {
        out.dropped.push(skillDrop({ name, source: "repo", path: repo.path, ...why }));
      } else {
        const detail = why.detail === undefined ? why.reason : dropDetail(why.detail);
        out.unnamed.push({ repo: repo.path, path: name, why: detail });
      }
    };

    let listed: { entries: Listed[]; submodules: string[] };
    try {
      listed = await listSkills(input.git, repo);
    } catch (err) {
      out.unread.push({ repo: repo.path, error: dropDetail(errorMessage(err)) });
      continue;
    }
    for (const path of listed.submodules) {
      out.unnamed.push({ repo: repo.path, path, why: "a submodule is never read" });
    }
    const dirs = new Map<string, Listed[]>();
    // A link or a submodule at the root looks like a skill directory to its author, so it is
    // named, and it counts against the same cap as the directories: however many a repo commits,
    // what the run holds and logs about them stays bounded. A plain file there (a README) is
    // just a file.
    const links = new Set<string>();
    for (const entry of listed.entries) {
      const slash = entry.path.indexOf("/");
      if (slash < 0) {
        if (entry.mode === "120000" || entry.mode === "160000") {
          links.add(`${entry.root}/${entry.path}`);
        }
        continue;
      }
      const dir = `${entry.root}/${entry.path.slice(0, slash)}`;
      dirs.set(dir, [...dirs.get(dir) ?? [], { ...entry, path: entry.path.slice(slash + 1) }]);
    }
    const candidates = [...new Set([...dirs.keys(), ...links])].map((key) => {
      const slash = key.lastIndexOf("/");
      return { key, root: key.slice(0, slash), dir: key.slice(slash + 1) };
    }).sort((a, b) =>
      a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : a.root < b.root ? -1 : a.root > b.root ? 1 : 0
    );
    const names = candidates.map((c) => c.dir);
    if (names.length > MAX_REPO_SKILL_DIRS) {
      drop(names[MAX_REPO_SKILL_DIRS], {
        reason: "cap",
        detail: `this repo holds ${names.length} skill directories and links; only the first ` +
          `${MAX_REPO_SKILL_DIRS} by name are read, and the rest are left out from here on`,
      });
    }

    // What the listing alone can settle, before a byte is read.
    const toRead: Array<{ dir: string; files: Listed[] }> = [];
    for (const { key, root, dir } of candidates.slice(0, MAX_REPO_SKILL_DIRS)) {
      // A committed preferred candidate reserves its name even if invalid or unreadable:
      // adding a broken .agents copy must not silently enable different .claude instructions.
      const preferred = `${SKILLS_DIR}/${dir}`;
      if (root !== SKILLS_DIR && (dirs.has(preferred) || links.has(preferred))) {
        drop(dir, {
          reason: "collision",
          winner: "repo",
          detail: `${root}/${dir} is shadowed by ${preferred}`,
        });
        continue;
      }
      if (links.has(key)) {
        drop(dir, { reason: "invalid", detail: "a link or a submodule is never read" });
        continue;
      }
      if (!isReportable(dir)) {
        out.unnamed.push({ repo: repo.path, path: dir, why: "not a skill name" });
        continue;
      }
      if (dir.startsWith(RESERVED_PREFIX)) {
        drop(dir, { reason: "reserved" });
        continue;
      }
      // Links, submodules and paths a skill may not hold are skipped; the skill keeps the rest,
      // as the control plane's rules have it. A SKILL.md that is a link is no SKILL.md at all.
      const files = dirs.get(key)!.filter((f) =>
        (f.mode === "100644" || f.mode === "100755") && isSkillPath(f.path)
      );
      const skillMd = files.find((f) => f.path === "SKILL.md");
      const bytes = files.reduce((sum, f) => sum + f.size, 0);
      if (skillMd === undefined) {
        drop(dir, { reason: "invalid", detail: "no SKILL.md as a regular file" });
      } else if (skillMd.size > MAX_SKILL_MD_BYTES) {
        drop(dir, { reason: "invalid", detail: `SKILL.md is over ${MAX_SKILL_MD_BYTES} bytes` });
      } else if (files.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
        drop(dir, {
          reason: "invalid",
          detail: `${files.length} files and ${bytes} bytes, over the limit of ` +
            `${MAX_SKILL_FILES} files and ${MAX_SKILL_BYTES} bytes per skill`,
        });
      } else if (read + bytes > MAX_REPO_SKILL_BYTES) {
        drop(dir, {
          reason: "unavailable",
          detail: `the run's working repos already hold ${MAX_REPO_SKILL_BYTES} bytes of skills`,
        });
      } else {
        read += bytes;
        toRead.push({ dir, files });
      }
    }

    let blobs: Map<string, Uint8Array>;
    const queued = toRead.reduce((sum, s) => sum + s.files.reduce((n, f) => n + f.size, 0), 0);
    try {
      const ids = [...new Set(toRead.flatMap((s) => s.files.map((f) => f.id)))];
      blobs = await input.catFile(repo.dir, ids, queued);
    } catch (err) {
      // Nothing was read, so nothing counts against the next repo's allowance.
      read -= queued;
      for (const { dir } of toRead) {
        drop(dir, { reason: "unavailable", detail: errorMessage(err) });
      }
      continue;
    }

    // Repo skills that are the frozen org copy byte for byte: the org skills repo is checked out
    // by this run. Said once per repo rather than once per skill.
    const same: string[] = [];
    for (const { dir, files } of toRead) {
      // Kept only for a skill the agent is given: a dropped one is said by its drop.
      const warnings: string[] = [];
      const prepared = prepareRepoSkill({
        repo: repo.path,
        dir,
        warn: (warning) => warnings.push(warning),
        files: files.map((f): RepoSkillFile => ({
          path: f.path,
          executable: f.mode === "100755",
          bytes: blobs.get(f.id) ?? new Uint8Array(),
        })),
      });
      if ("refused" in prepared) {
        drop(dir, { reason: "invalid", detail: prepared.refused });
        continue;
      }
      const holder = holders.get(dir);
      if (holder !== undefined) {
        if (holder.source === "org" && holder.digest === await skillDigest(prepared.files)) {
          same.push(dir);
        } else {
          drop(dir, { reason: "collision", winner: holder.source });
        }
        continue;
      }
      const cost = listingBytes(prepared);
      if (count + 1 > input.budget.skills || listing + cost > input.budget.listingBytes) {
        drop(dir, { reason: "cap" });
        continue;
      }
      count += 1;
      listing += cost;
      holders.set(dir, { source: "repo" });
      out.prepared.push(prepared);
      for (const warning of warnings) out.warnings.push({ repo: repo.path, name: dir, warning });
    }
    if (same.length > 0) {
      drop(same[0], {
        reason: "collision",
        winner: "org",
        detail: "the same files as the org skills repo's synced version" +
          (same.length > 1 ? `, as are ${same.length - 1} more of this repo's skills` : ""),
      });
    }
  }
  return out;
}

/**
 * Both roots at the clone's base commit, in one bounded listing. Root submodules are reported
 * separately without preventing discovery from the other root; root files/links list nothing.
 */
async function listSkills(
  git: GitBounded,
  repo: RepoToRead,
): Promise<{ entries: Listed[]; submodules: string[] }> {
  // `-z`: paths unquoted and NUL-separated. The trailing slash lists what is UNDER the directory;
  // `.agents/skills` committed as a link or a file lists nothing. A submodule there lists its own
  // gitlink entry, without the slash, since git cannot descend into a commit it does not hold.
  const raw = await git(
    repo.dir,
    MAX_REPO_SKILLS_LISTING_BYTES,
    "--no-replace-objects",
    "ls-tree",
    "-r",
    "-l",
    "-z",
    "--end-of-options",
    repo.commit,
    "--",
    ...SKILLS_DIRS.map((root) => `${root}/`),
  );
  if (raw === null) {
    throw new Error(
      `the listing of ${
        SKILLS_DIRS.join(" and ")
      } is over ${MAX_REPO_SKILLS_LISTING_BYTES} bytes, so none of ` +
        "this repo's skills are read",
    );
  }
  const listed: Listed[] = [];
  const submodules: string[] = [];
  for (const entry of raw.split("\0")) {
    if (entry === "") continue;
    // `<mode> SP <type> SP <object> SP+ <size>\t<path>`; the size is padded, and "-" for a
    // submodule.
    const tab = entry.indexOf("\t");
    const [mode, , id, size] = entry.slice(0, tab).split(/ +/);
    const path = entry.slice(tab + 1);
    if (tab >= 0 && mode === "160000" && SKILLS_DIRS.some((root) => path === root)) {
      submodules.push(path);
      continue;
    }
    const root = SKILLS_DIRS.find((root) => path.startsWith(`${root}/`));
    if (tab < 0 || root === undefined) {
      throw new Error(`git ls-tree answered an entry this does not read: ${entry.slice(0, 80)}`);
    }
    const regular = mode === "100644" || mode === "100755";
    const length = regular ? Number(size) : 0;
    if (!Number.isSafeInteger(length)) throw new Error(`git ls-tree could not size ${path}`);
    listed.push({ root, path: path.slice(root.length + 1), mode, id, size: length });
  }
  return { entries: listed, submodules };
}

/** Whether the trail can name it: the control plane refuses a drop whose name is no skill name. */
function isReportable(name: string): boolean {
  return name.length <= MAX_SKILL_NAME && SKILL_NAME.test(name);
}
