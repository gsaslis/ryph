// Skills: what a valid skill is, its content digest, the caps, and
// which skills a run is given. One set of rules for every source the control plane reads — the
// catalogue this package ships and the org skills repo — restated once more in
// @ryph/runner's helpers/skills.ts, because the runner is the other end of the wire.
//
// A skill is a directory `<name>/` holding `SKILL.md` (YAML frontmatter with `name` and
// `description`, then a Markdown body) and whatever `scripts/`, `references/` and `assets/` it
// carries. Only the name and the description are listed to the model; it reads the rest with
// its own tools when the task calls for it.
//
// Invariants:
// - every rule ryph cares about is enforced HERE, before a harness sees the file: pi itself
//   loads a skill with a bad name or an overlong description and only warns
// - an invalid skill is dropped on its own, with warnings; nothing one skill holds can take
//   another down
// - the digest is over the source bytes, before any normalization, so two skills with the same
//   files have the same digest wherever they came from
// - pure apart from hashing: no I/O, no clock, no port

import type {
  ConnectedRepo,
  RunSkill,
  RunSkills,
  SkillOrigin,
  SkillPolicy,
  SkillSettings,
  SkillSource,
} from "./types.ts";
import { DEFAULT_SKILL_POLICY } from "./types.ts";
import { parseFrontmatter, splitFrontmatter } from "../helpers/skill_file.ts";
import { isMapping } from "../helpers/services.ts";
import {
  type SkillIcons,
  type SkillPresentation,
  skillPresentation,
} from "./skill_presentation.ts";

export type {
  SkillIcon,
  SkillIcons,
  SkillPresentation,
  SkillPresentationView,
} from "./skill_presentation.ts";

/** The name grammar: 1–64 lowercase letters, digits and single hyphens, none leading or
 * trailing — the Agent Skills specification's. */
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME = 64;
/** Names only the catalogue may carry. */
export const RESERVED_PREFIX = "ryph-";
export const MAX_DESCRIPTION_CHARS = 1024;
export const MAX_SKILL_MD_BYTES = 64 * 1024;
export const MAX_SKILL_FILES = 64;
export const MAX_SKILL_BYTES = 512 * 1024;
export const MAX_PATH_DEPTH = 8;
export const PATH_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
export const MAX_LICENSE_CHARS = 200;
export const MAX_COMPATIBILITY_CHARS = 500;
export const MAX_METADATA_KEYS = 32;
export const MAX_METADATA_CHARS = 1024;
export const MAX_ALLOWED_TOOLS_CHARS = 1024;
/** Control characters a description may not hold: all but `\n` and `\t`. */
// oxlint-disable-next-line no-control-regex
export const DESCRIPTION_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/**
 * Skills listed per run, all sources together. Past a few dozen a listing is a menu the model
 * skims, and pi has no limit of its own.
 */
export const MAX_LISTED_SKILLS = 32;
/** UTF-8 bytes of every listed skill's name and description together, per run: the listing
 * rides every turn's system prompt. */
export const MAX_LISTING_BYTES = 16_384;

/** Drops one runner report carries. The runner cuts its own there and says how many it cut. */
export const MAX_REPORTED_SKILL_DROPS = 100;
/** Characters of a drop's detail: one line on the run's trail. */
export const MAX_SKILL_DROP_DETAIL = 500;

/** One entry under a skill's directory, as its source holds it. */
export interface SkillTreeEntry {
  /** Relative to the skill's directory, "/"-separated. */
  path: string;
  /** A symlink or a submodule is never read and never kept. */
  type: "file" | "symlink" | "submodule";
  executable: boolean;
  /** The file's bytes; empty for a symlink or a submodule. */
  bytes: Uint8Array;
}

/** The optional frontmatter fields ryph carries, as validated. Shown, never enforced. */
export interface SkillFrontmatter {
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** `allowed-tools` in the file. Enforced by neither ryph nor pi. */
  allowedTools?: string;
}

/** One file of a stored bundle. `content` is base64: `assets/` may be binary. */
export interface SkillFile {
  path: string;
  executable: boolean;
  content: string;
}

/** One skill's files, content-addressed. */
export interface SkillBundle {
  digest: string;
  files: SkillFile[];
  bytes: number;
}

export interface SkillWarning {
  /** The path the warning is about, relative to the source root (`ryph-checks/SKILL.md`). */
  path: string;
  message: string;
}

/** A skill that passed every rule. */
export interface ValidSkill {
  name: string;
  /** Trimmed. */
  description: string;
  frontmatter: SkillFrontmatter;
  /** How the skills page shows it in text (core/skill_presentation.ts); null when it sets none. */
  presentation: SkillPresentation | null;
  /** Its icons, stored with its bundle, once per digest; null when it has none. */
  icons: SkillIcons | null;
  digest: string;
  bytes: number;
  /** The files kept, sorted by path. */
  files: Array<{ path: string; executable: boolean; bytes: Uint8Array }>;
}

export type SkillJudgement =
  | { kind: "valid"; skill: ValidSkill; warnings: SkillWarning[] }
  | { kind: "dropped"; warnings: SkillWarning[] };

/**
 * Judges one skill directory against the rules. `dir` is the directory's name, which the
 * frontmatter's `name` must equal; `allowReserved` says whether this source may use the `ryph-`
 * prefix, which only the catalogue may.
 */
export async function judgeSkill(input: {
  dir: string;
  entries: SkillTreeEntry[];
  allowReserved: boolean;
}): Promise<SkillJudgement> {
  const { dir } = input;
  const warnings: SkillWarning[] = [];
  const at = (path: string) => `${dir}/${path}`;
  const drop = (path: string, message: string): SkillJudgement => {
    warnings.push({ path: at(path), message });
    return { kind: "dropped", warnings };
  };

  const kept: Array<{ path: string; executable: boolean; bytes: Uint8Array }> = [];
  let skillMd: Uint8Array | null = null;
  for (const entry of input.entries) {
    const refused = pathRefusal(entry.path);
    if (refused !== null) {
      warnings.push({ path: at(entry.path), message: `${refused}; the file is skipped` });
      continue;
    }
    if (entry.type !== "file") {
      // SKILL.md as a link is no SKILL.md at all, which the check below says.
      if (entry.path !== "SKILL.md") {
        warnings.push({
          path: at(entry.path),
          message: `a ${entry.type} is never read; the file is skipped`,
        });
      }
      continue;
    }
    if (entry.path === "SKILL.md") skillMd = entry.bytes;
    kept.push({ path: entry.path, executable: entry.executable, bytes: entry.bytes });
  }
  if (skillMd === null) return drop("SKILL.md", "no SKILL.md as a regular file");
  const clash = pathClash(kept.map((f) => f.path));
  if (clash !== null) return drop(clash.path, clash.message);
  if (skillMd.length > MAX_SKILL_MD_BYTES) {
    return drop("SKILL.md", `${skillMd.length} bytes, over the ${MAX_SKILL_MD_BYTES}-byte limit`);
  }
  const bytes = kept.reduce((sum, f) => sum + f.bytes.length, 0);
  if (kept.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
    return drop(
      "",
      `${kept.length} files and ${bytes} bytes, over the limit of ${MAX_SKILL_FILES} files ` +
        `and ${MAX_SKILL_BYTES} bytes per skill`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(skillMd);
  } catch {
    return drop("SKILL.md", "not valid UTF-8");
  }
  const split = splitFrontmatter(text);
  if (split === null) {
    return drop("SKILL.md", "no frontmatter: the file must start with a line `---` and close it");
  }
  let doc: unknown;
  try {
    doc = parseFrontmatter(split.yaml);
  } catch (err) {
    return drop("SKILL.md", err instanceof Error ? err.message : String(err));
  }
  if (!isMapping(doc)) return drop("SKILL.md", "the frontmatter must be a mapping");

  const { name, description } = doc;
  if (typeof name !== "string" || name.length > MAX_SKILL_NAME || !SKILL_NAME.test(name)) {
    return drop(
      "SKILL.md",
      "`name` must be 1–64 lowercase letters, digits and single hyphens, with no hyphen at " +
        "either end",
    );
  }
  if (name !== dir) {
    return drop("SKILL.md", `\`name\` is "${name}" but the directory is "${dir}"; they must match`);
  }
  if (!input.allowReserved && name.startsWith(RESERVED_PREFIX)) {
    return drop("SKILL.md", `names starting with "${RESERVED_PREFIX}" are reserved for ryph`);
  }
  if (typeof description !== "string" || description.trim() === "") {
    return drop("SKILL.md", "`description` is required: what the skill is for and when to read it");
  }
  const trimmed = description.trim();
  if (trimmed.length > MAX_DESCRIPTION_CHARS) {
    return drop(
      "SKILL.md",
      `\`description\` is ${trimmed.length} characters, over the ${MAX_DESCRIPTION_CHARS} limit`,
    );
  }
  if (DESCRIPTION_CONTROL.test(trimmed)) {
    return drop("SKILL.md", "`description` holds control characters");
  }
  // The file is valid UTF-8, but YAML decodes its `\uD800` escapes after that check, and the
  // description is stored in jsonb (`runs.skills`), which refuses an unpaired surrogate: one
  // such skill would fail every run insert.
  if (!trimmed.isWellFormed()) {
    return drop("SKILL.md", "`description` holds an unpaired UTF-16 surrogate");
  }
  if (doc["disable-model-invocation"] === true) {
    // pi would load it and leave it out of the listing: a skill nobody can see, readable only
    // through a `/skill:` command no run sends.
    return drop(
      "SKILL.md",
      "`disable-model-invocation: true` would hide the skill from the model; it is not listed",
    );
  }

  const frontmatter = optionalFields(
    doc,
    (message) => warnings.push({ path: at("SKILL.md"), message }),
  );
  const sorted = kept.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const { presentation, icons } = skillPresentation({
    files: sorted,
    metadata: frontmatter.metadata,
    warn: (path, message) => warnings.push({ path: at(path), message }),
  });
  return {
    kind: "valid",
    skill: {
      name,
      description: trimmed,
      frontmatter,
      presentation,
      icons,
      digest: await skillDigest(sorted),
      bytes,
      files: sorted,
    },
    warnings,
  };
}

/**
 * The first path that cannot be written beside the others, and why: one that appears twice, or a
 * file that is also a directory of another (`x` and `x/y`). Git refuses such a tree under fsck,
 * but a repo that never ran it (a Radicle repo, a clone without fsck) can hold one, and the
 * runner could write only part of the skill. Null when every path can be written.
 */
export function pathClash(paths: readonly string[]): { path: string; message: string } | null {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) return { path, message: "the path appears twice in the skill" };
    seen.add(path);
  }
  for (const path of paths) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const dir = segments.slice(0, depth).join("/");
      if (seen.has(dir)) {
        return { path: dir, message: `a file, and also the directory holding ${path}` };
      }
    }
  }
  return null;
}

/** Why a path inside a skill is refused, or null when it is fine. */
export function pathRefusal(path: string): string | null {
  const segments = path.split("/");
  if (segments.length > MAX_PATH_DEPTH) {
    return `deeper than ${MAX_PATH_DEPTH} directories`;
  }
  if (segments.some((s) => s === "." || s === ".." || !PATH_SEGMENT.test(s))) {
    return "a path segment must be 1–128 letters, digits, '.', '_' or '-', and not '.' or '..'";
  }
  return null;
}

/** The optional fields as validated: a field that does not fit is dropped with a warning, and
 * the skill keeps the rest. */
function optionalFields(
  doc: Record<string, unknown>,
  warn: (message: string) => void,
): SkillFrontmatter {
  const out: SkillFrontmatter = {};
  const text = (key: string, min: number, max: number): string | undefined => {
    const value = doc[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.length < min || value.length > max) {
      warn(`\`${key}\` must be a string of ${min}–${max} characters; it is left out`);
      return undefined;
    }
    if (!storable(value)) {
      warn(`\`${key}\` holds a NUL or an unpaired UTF-16 surrogate; it is left out`);
      return undefined;
    }
    return value;
  };
  const license = text("license", 0, MAX_LICENSE_CHARS);
  if (license !== undefined) out.license = license;
  const compatibility = text("compatibility", 1, MAX_COMPATIBILITY_CHARS);
  if (compatibility !== undefined) out.compatibility = compatibility;
  const allowedTools = text("allowed-tools", 0, MAX_ALLOWED_TOOLS_CHARS);
  if (allowedTools !== undefined) out.allowedTools = allowedTools;
  const metadata = doc.metadata;
  if (metadata !== undefined && metadata !== null) {
    const entries = isMapping(metadata) ? Object.entries(metadata) : null;
    if (
      entries === null || entries.length > MAX_METADATA_KEYS ||
      entries.some(([key, value]) =>
        key.length > MAX_METADATA_CHARS || !storable(key) || typeof value !== "string" ||
        value.length > MAX_METADATA_CHARS || !storable(value)
      )
    ) {
      warn(
        `\`metadata\` must map at most ${MAX_METADATA_KEYS} keys to strings of at most ` +
          `${MAX_METADATA_CHARS} characters, with no NUL or unpaired surrogate; it is left out`,
      );
    } else {
      out.metadata = Object.fromEntries(entries as Array<[string, string]>);
    }
  }
  return out;
}

/** Whether jsonb can hold the string: Postgres refuses `\\u0000` and an unpaired surrogate,
 * and both survive the UTF-8 check because YAML decodes its escapes after it. */
function storable(value: string): boolean {
  return value.isWellFormed() && !value.includes("\0");
}

/**
 * A skill's content digest:
 *
 *   "sha256:" + hex(sha256( for each file, sorted by path:
 *     utf8(path) 0x00 ("x" if executable else "-") 0x00 utf8(decimal byte length) 0x00 bytes ))
 *
 * Over the source bytes, before any normalization. The sort is by path; paths are held to ASCII
 * (`pathRefusal`), so string order and UTF-8 byte order agree. The runner computes the same over
 * what it fetched and refuses a bundle that does not match the digest it was frozen with.
 */
export async function skillDigest(
  files: ReadonlyArray<{ path: string; executable: boolean; bytes: Uint8Array }>,
): Promise<string> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const file of sorted) {
    parts.push(
      encoder.encode(`${file.path}\0${file.executable ? "x" : "-"}\0${file.bytes.length}\0`),
      file.bytes,
    );
  }
  const whole = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.length;
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", whole));
  return `sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A valid skill's files as the store and the runner route carry them. */
export function bundleOf(skill: ValidSkill): SkillBundle {
  return {
    digest: skill.digest,
    bytes: skill.bytes,
    files: skill.files.map((f) => ({
      path: f.path,
      executable: f.executable,
      content: f.bytes.toBase64(),
    })),
  };
}

/**
 * The version of the rules above, recorded on every sync that judged a tree. Bump it with any
 * change to what a valid skill is, to the caps, or to what a judgement carries (2: the
 * presentation; 3: icons judged on the bundle, under a 16 KiB small cap; 4: `agents/openai.yml`
 * read too): a version judged by older rules is then read and judged again on the next sync,
 * whatever its tree id says, so what runs get and the warnings the settings page shows are the
 * running code's.
 */
export const SKILL_RULES_VERSION = 4;

/** What started a read of the org skills repo. */
export type SkillSyncTrigger = "connect" | "push" | "manual" | "reconcile";

/**
 * Why a read failed. `missing-ref` is the forge saying the branch is gone: an
 * answer and not an outage, so the settings page can name it. `invalid` is a tree over the
 * forge's read bounds, or a ref or repo the forge refuses outright: not always a tree too big.
 * `error` is anything the read did not expect.
 */
export type SkillSyncFailure = "unavailable" | "missing-ref" | "invalid" | "error";

/**
 * One read of the org skills repo that changed something: a new tree, or a failure. A read that
 * found the tree runs already get is not one; it moves the settings' `checkedAt`. A failure
 * identical to the latest read of the same repo and branch is the same row read again, so
 * `repeats` counts them and `finishedAt` is the latest.
 */
export interface SkillSync {
  id: string;
  connectedRepoId: string;
  /** The branch actually read. */
  branch: string;
  trigger: SkillSyncTrigger;
  /** `superseded`: a read that moved nothing, because the settings moved to another repo or
   * branch while it ran, or a read that started later answered first. It may be a tree that
   * never became the version runs get, or a failure that never stood. */
  outcome: "synced" | "superseded" | "failed";
  /** Why the read failed: set on every `failed` row and on a superseded failure, null on a tree
   * read, superseded or not. */
  failure: SkillSyncFailure | null;
  /** `SKILL_RULES_VERSION` when the tree was judged. */
  rulesVersion: number;
  /** Null when the read failed before a commit was resolved. */
  commit: string | null;
  /** The `.agents/skills` tree id; null when the directory is absent or the read failed. */
  treeId: string | null;
  skillCount: number;
  warnings: SkillWarning[];
  error: string | null;
  repeats: number;
  /** The user who asked, for `connect` and `manual`. */
  requestedBy: string | null;
  startedAt: string;
  finishedAt: string;
}

/** One skill of a synced version: what a run is frozen with and the settings page lists. */
export interface OrgSkill {
  name: string;
  description: string;
  digest: string;
  frontmatter: SkillFrontmatter;
  /** In text only: a run start reads this, so the icons are read apart (`SkillStore.iconsOf`). */
  presentation: SkillPresentation | null;
}

/** The org skills repo as the settings page reads it, archived or not. */
export interface OrgState {
  /** The connected repo the settings name; `archivedAt` set means runs get no org skills until an
   * admin picks a repo again, since reconnecting it mints a new id. */
  repo: ConnectedRepo;
  /** The branch the settings name; null reads `repo.defaultBranch`. */
  branch: string | null;
  /** The version runs get, with its skills; null until a sync read a tree. */
  current: { sync: SkillSync; skills: OrgSkill[] } | null;
  checkedAt: string | null;
  checkedCommit: string | null;
  /**
   * The newest failed read of this repo, when it is newer than both the current version and the
   * last answer: the failure still standing. Null once a read succeeds after it.
   */
  lastFailure: SkillSync | null;
}

/** The version runs get, as task start freezes it. */
export interface OrgVersion {
  connectedRepoId: string;
  repoRef: string;
  sync: SkillSync;
  skills: OrgSkill[];
  /** A read that failed after this version: runs are on the last good one while it stands. */
  lastFailure: SkillSync | null;
}

/** What a sync knew when it started, so its write can tell whether the settings moved since. */
export interface SkillSyncStart {
  /** The id a new row takes; unused when the read is a repeat or records nothing. */
  id: string;
  connectedRepoId: string;
  /** The settings' branch, null for the default: compared, not read. */
  settingsBranch: string | null;
  /** The branch the read asks for: the settings' branch, or the repo's default. */
  branch: string;
  trigger: SkillSyncTrigger;
  requestedBy: string | null;
  startedAt: string;
}

/** What the read answered, as the sync's one write records it. */
export type SkillSyncResult =
  /**
   * The branch still holds `treeId`, the tree the read named to the forge, judged by
   * `rulesVersion`. Only the last answer moves, and only while runs still get that tree.
   */
  | { kind: "unchanged"; commit: string; treeId: string; rulesVersion: number; finishedAt: string }
  /** A tree was read (`treeId` null: no `.agents/skills`), and these skills in it are valid. */
  | {
    kind: "tree";
    commit: string;
    treeId: string | null;
    rulesVersion: number;
    skills: ValidSkill[];
    warnings: SkillWarning[];
    finishedAt: string;
  }
  | {
    kind: "failed";
    failure: SkillSyncFailure;
    error: string;
    commit: string | null;
    rulesVersion: number;
    finishedAt: string;
  };

/** What the sync's write did. */
export type RecordedSync =
  /** A new version, now the one runs get. */
  | { kind: "synced"; sync: SkillSync }
  /** Runs already get this tree, judged by these rules; only the last answer moved. */
  | { kind: "up-to-date" }
  /** An unchanged answer about a tree runs no longer get: a read that started earlier landed
   * another tree while this one ran. Nothing is recorded, and the sync reads the whole tree. */
  | { kind: "behind" }
  /** A failed read, recorded or counted as a repeat of the latest. The current version stays. */
  | { kind: "failed"; sync: SkillSync }
  /** The settings moved to another repo or branch while the read ran, or a read that started
   * later answered first: a tree or a failure is kept as history (outcome `superseded`, with
   * `failure` and `error` set when it failed) and moves nothing, an unchanged answer records
   * nothing. */
  | { kind: "superseded"; sync: SkillSync | null };

/** One version of one org skill: a run of consecutive syncs that held the same digest. */
export interface SkillVersion {
  digest: string;
  description: string;
  firstSync: { id: string; commit: string | null; at: string };
  lastSync: { id: string; commit: string | null; at: string };
}

/** What a catalogue skill is, as the catalogue port lists it. */
export interface CatalogueSkill {
  name: string;
  description: string;
  digest: string;
  bytes: number;
  files: Array<{ path: string; bytes: number }>;
  frontmatter: SkillFrontmatter;
  presentation: SkillPresentation | null;
  /** Held in memory with the catalogue; a route decides which of them it answers with. */
  icons: SkillIcons | null;
}

/** Why a skill did not reach the agent. */
export type SkillDropReason = "collision" | "cap" | "reserved" | "invalid" | "unavailable";

/**
 * A skill a run could not be given, and why: frozen at task start, or reported by the runner for
 * a bundle it could not load or a working-repo skill it could not list. One shape for every
 * producer, so the run's trail words each reason one way.
 */
export type SkillDrop =
  & {
    name: string;
    /** What went wrong, in the producer's words; one line. */
    detail?: string;
  }
  & SkillOrigin
  & (
    /** A collision always knows which source holds the name. */
    | { reason: "collision"; winner: SkillOrigin["source"] }
    | { reason: Exclude<SkillDropReason, "collision"> }
  );

/** What one listed skill costs against `MAX_LISTING_BYTES`. */
export function listingBytes(skill: { name: string; description: string }): number {
  return new TextEncoder().encode(skill.name + skill.description).length;
}

/**
 * Which catalogue and org skills a run is given, frozen onto it at task start.
 *
 * 1. A harness without skills support gets nothing frozen at all.
 * 2. Catalogue skills in name order, minus what the admin turned off, minus what the agent's
 *    policy turned off unless the task's purpose pins it. A pin overrides the agent's switch,
 *    never the admin's: a platform task does not overrule an org-wide decision.
 * 3. Then the org repo's current version, when there is one and the agent did not turn the repo
 *    off: its skills in name order, minus what the agent turned off. A `ryph-` name is dropped as
 *    reserved; the sync already refused those, and this is checked again because precedence is
 *    decided here, not there.
 * 4. A name already taken is dropped as a collision, naming the source that holds it: the
 *    catalogue wins over the org repo, as the working repos the runner adds lose to both.
 * 5. The caps: pinned skills are admitted first, then the rest in that order, each while the
 *    count stays within `MAX_LISTED_SKILLS` and the listing within `MAX_LISTING_BYTES`; the rest
 *    are dropped. What is left of both caps is the working repos' budget.
 *
 * Turning a skill off is a decision made where it can be seen, not a drop: it writes nothing.
 * The frozen `org` names the version only when it gave the run at least one skill.
 */
export function resolveRunSkills(input: {
  supportsSkills: boolean;
  catalogue: readonly CatalogueSkill[];
  settings: SkillSettings;
  /** The org repo's current version (`SkillStore.currentOrg`); null when there is none. */
  org: OrgVersion | null;
  policy: SkillPolicy | null;
  /** Catalogue names the task's purpose requires (the environment setup task's skill). */
  pinned: readonly string[];
}): { skills: RunSkills | null; drops: SkillDrop[] } {
  if (!input.supportsSkills) return { skills: null, drops: [] };
  const policy = input.policy ?? DEFAULT_SKILL_POLICY;
  const adminOff = new Set(input.settings.disabledCatalogue);
  const agentOff = new Set(policy.catalogue.disabled);
  const pinned = new Set(input.pinned);
  const drops: SkillDrop[] = [];

  const catalogue = byName(input.catalogue)
    .filter((s) => !adminOff.has(s.name) && (pinned.has(s.name) || !agentOff.has(s.name)))
    .map((s) => ({
      name: s.name,
      description: s.description,
      digest: s.digest,
      source: "catalogue" as const,
    }));
  const org = input.org !== null && policy.org.enabled ? input.org : null;
  const orgOff = new Set(policy.org.disabled);
  const fromOrg = byName(org?.skills ?? [])
    .filter((s) => !orgOff.has(s.name))
    .filter((s) => {
      if (!s.name.startsWith(RESERVED_PREFIX)) return true;
      drops.push({ name: s.name, source: "org", reason: "reserved" });
      return false;
    })
    .map((s) => ({
      name: s.name,
      description: s.description,
      digest: s.digest,
      source: "org" as const,
    }));

  const holders = new Map<string, SkillSource>();
  const unique = [...catalogue, ...fromOrg].filter((s) => {
    const winner = holders.get(s.name);
    if (winner !== undefined) {
      drops.push({ name: s.name, source: s.source, reason: "collision", winner });
      return false;
    }
    holders.set(s.name, s.source);
    return true;
  });

  let count = 0;
  let bytes = 0;
  const admitted = new Set<string>();
  // Pins are catalogue names, and a name is held by one source by now.
  const isPinned = (s: RunSkill) => s.source === "catalogue" && pinned.has(s.name);
  for (const skill of [...unique.filter(isPinned), ...unique.filter((s) => !isPinned(s))]) {
    const cost = listingBytes(skill);
    if (count + 1 > MAX_LISTED_SKILLS || bytes + cost > MAX_LISTING_BYTES) {
      drops.push({ name: skill.name, source: skill.source, reason: "cap" });
      continue;
    }
    count += 1;
    bytes += cost;
    admitted.add(skill.name);
  }

  const skills = unique.filter((s) => admitted.has(s.name));
  return {
    skills: {
      skills,
      org: org === null || !skills.some((s) => s.source === "org") ? null : {
        connectedRepoId: org.connectedRepoId,
        repoRef: org.repoRef,
        // A version is a sync that read a tree, and every such sync names its commit.
        commit: org.sync.commit!,
        syncId: org.sync.id,
        syncedAt: org.sync.finishedAt,
        stale: org.lastFailure !== null,
      },
      workingRepos: input.settings.workingRepoSkills && policy.workingRepos.enabled,
      budget: { skills: MAX_LISTED_SKILLS - count, listingBytes: MAX_LISTING_BYTES - bytes },
    },
    drops,
  };
}

function byName<T extends { name: string }>(skills: readonly T[]): T[] {
  return [...skills].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * The `skills.stale` line: which version of the org repo the run got, when it was synced, and the
 * read that failed after it, so a revoked installation or a deleted branch never goes on steering
 * agents unseen.
 */
export function describeStale(org: OrgVersion, failed: SkillSync): string {
  const commit = org.sync.commit === null ? "" : ` at ${org.sync.commit.slice(0, 12)}`;
  const failure = failed.error ?? failed.failure;
  return `the org skills came from ${org.repoRef}${commit}, synced ${org.sync.finishedAt}` +
    `; the latest read failed (${failure}), so they may be behind the repo as it stands`;
}

/** The drops as the run's trail reads them, one per line, whoever produced them:
 * `deploy (\`api/\`): the name is already taken by a skill from ryph's catalogue`. The run page
 * reads these lines back into its own words (packages/app, utils/skills.ts `parseSkillDrop`), so
 * a change to the shape or a reason's opening words goes there too. */
export function describeDrops(drops: readonly SkillDrop[]): string {
  return drops.map((drop) => {
    const from = drop.source === "repo" ? `\`${drop.path}/\`` : drop.source;
    const detail = drop.detail === undefined ? "" : `; ${drop.detail}`;
    return `${drop.name} (${from}): ${dropReason(drop)}${detail}`;
  }).join("\n");
}

/** Where a winning skill came from, as a reader of the trail would say it. */
const SOURCE_WORDS: Record<SkillOrigin["source"], string> = {
  catalogue: "ryph's catalogue",
  org: "the org skills repo",
  repo: "a working repo",
};

function dropReason(drop: SkillDrop): string {
  switch (drop.reason) {
    case "collision":
      return `the name is already taken by a skill from ${SOURCE_WORDS[drop.winner]}`;
    case "cap":
      return `over the ${MAX_LISTED_SKILLS}-skill or ${MAX_LISTING_BYTES}-byte listing cap`;
    case "reserved":
      return `names starting with "${RESERVED_PREFIX}" are reserved for ryph`;
    case "invalid":
      return "it did not validate";
    case "unavailable":
      return "its files could not be loaded";
  }
}
