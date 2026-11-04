// Skills on the runner's side of the wire: checking a frozen skill's
// bundle against what the control plane froze, judging a working repo's own skill by the same
// rules, and writing both where the harness reads them.
//
// The rules restate the control plane's (@ryph/orchestrator's core/skills.ts and
// helpers/skill_file.ts), because this is the other end of the wire. The runner ships in the
// agent image and imports no service package, only the dependency-free kits (@ryph/shared,
// @ryph/sealed), so the copy is deliberate: if a rule there changes, change it here.
//
// Invariants:
// - a bundle is accepted only when its files hash to the digest the run was frozen with, and its
//   frontmatter names the frozen name and description: what the harness lists is exactly what the
//   control plane checked and counted against the listing cap
// - `SKILL.md` is written NORMALIZED. The frontmatter is re-emitted from the checked fields, every
//   value a JSON string (a JSON string is a valid YAML double-quoted scalar), and the body after
//   the closing `---` is copied as it was. pi parses YAML with another library than ours, and two
//   parsers can disagree about adversarial input; a frontmatter with one reading cannot
// - every path is checked again before it is joined onto the skills root, whatever the schema
//   already said

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "@std/yaml";
import type { RunSkill, SkillBundle, SkillDrop, SkillOrigin } from "../core/types.ts";
import { errorMessage } from "./errors.ts";

// Exported so schema.ts bounds the wire with the same numbers, and so a test can hold each to
// the control plane's constant of the same name.
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME = 64;
export const MAX_DESCRIPTION_CHARS = 1024;
export const MAX_SKILL_MD_BYTES = 64 * 1024;
export const MAX_SKILL_FILES = 64;
export const MAX_SKILL_BYTES = 512 * 1024;
export const MAX_PATH_DEPTH = 8;
export const MAX_LISTED_SKILLS = 32;
export const MAX_LISTING_BYTES = 16_384;
/** Names only ryph's catalogue may carry. */
export const RESERVED_PREFIX = "ryph-";
const MAX_PATH_SEGMENT = 128;
export const PATH_SEGMENT = new RegExp(`^[A-Za-z0-9._-]{1,${MAX_PATH_SEGMENT}}$`);
/** The longest path `isSkillPath` accepts: as deep as allowed, every segment at its longest. */
export const MAX_SKILL_PATH = MAX_PATH_DEPTH * (MAX_PATH_SEGMENT + 1) - 1;
/** Control characters a description may not hold: all but `\n` and `\t`. */
// oxlint-disable-next-line no-control-regex
export const DESCRIPTION_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
// The optional fields' bounds: a field over one is left out of the normalized SKILL.md, so one
// narrower here than the control plane's would drop what the settings page shows.
export const MAX_LICENSE_CHARS = 200;
export const MAX_COMPATIBILITY_CHARS = 500;
export const MAX_METADATA_KEYS = 32;
export const MAX_METADATA_CHARS = 1024;
export const MAX_ALLOWED_TOOLS_CHARS = 1024;

/** The longest drop detail the control plane takes: one line on the run's trail. */
export const MAX_SKILL_DROP_DETAIL = 500;
/** The most drops one report carries: the control plane refuses a longer list whole. */
export const MAX_REPORTED_SKILL_DROPS = 100;

/** What one listed skill costs against `MAX_LISTING_BYTES`. */
export function listingBytes(skill: { name: string; description: string }): number {
  return new TextEncoder().encode(skill.name + skill.description).length;
}

/**
 * A drop's detail as the control plane takes it, whoever worded it: one line, at most
 * `MAX_SKILL_DROP_DETAIL` characters. A report with any other is refused whole, and every drop
 * in it would be lost.
 */
export function dropDetail(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= MAX_SKILL_DROP_DETAIL
    ? line
    : `${line.slice(0, MAX_SKILL_DROP_DETAIL - 1)}…`;
}

/** A drop as a report carries it: every producer builds its drops here, so every detail is
 * `dropDetail`'s one bounded line. */
export function skillDrop(drop: SkillDrop): SkillDrop {
  return drop.detail === undefined ? drop : { ...drop, detail: dropDetail(drop.detail) };
}

/**
 * The drops one report can carry: all of them, or the first `MAX_REPORTED_SKILL_DROPS` with the last
 * saying how many more there were, so the trail never loses them without a word. `unread` counts
 * further dropped skills that were never looked at, and is said the same way.
 */
export function reportableDrops(dropped: readonly SkillDrop[], unread = 0): SkillDrop[] {
  const kept = dropped.slice(0, MAX_REPORTED_SKILL_DROPS);
  const cut = dropped.length - kept.length + unread;
  if (cut === 0 || kept.length === 0) return kept;
  const last = kept[kept.length - 1];
  const more = `${cut} more skills were dropped and are not listed`;
  return [
    ...kept.slice(0, -1),
    skillDrop({ ...last, detail: last.detail === undefined ? more : `${more}; ${last.detail}` }),
  ];
}

/** The optional frontmatter fields a skill carries into the normalized file. */
export interface SkillFrontmatter {
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

/** A skill checked and held in memory, ready to be written once setup is over. */
export type PreparedSkill =
  & {
    name: string;
    description: string;
    frontmatter: SkillFrontmatter;
    /** `SKILL.md`'s body after the frontmatter, as it was written. */
    body: string;
    /** Every file, `SKILL.md` included, as the source holds it. */
    files: Array<{ path: string; executable: boolean; bytes: Uint8Array }>;
  }
  & SkillOrigin;

/** Just where a skill came from, without the rest of it: what a drop or the harness's list
 * carries over from a prepared skill, whose files must not ride along. */
export function skillOrigin(skill: SkillOrigin): SkillOrigin {
  return skill.source === "repo" ? { source: "repo", path: skill.path } : { source: skill.source };
}

/**
 * A frozen skill's bundle, checked: the paths, the counts and sizes, the digest, and the
 * frontmatter against what was frozen. Answers why it was refused otherwise, in words for the
 * run's trail.
 */
export async function prepareFrozenSkill(
  frozen: RunSkill,
  bundle: SkillBundle,
): Promise<PreparedSkill | { refused: string }> {
  const files: PreparedSkill["files"] = [];
  for (const file of bundle.files) {
    if (!isSkillPath(file.path)) return { refused: `a file path is not allowed: ${file.path}` };
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.fromBase64(file.content);
    } catch {
      return { refused: `${file.path} is not valid base64` };
    }
    files.push({ path: file.path, executable: file.executable, bytes });
  }
  const clash = pathClash(files.map((f) => f.path));
  if (clash !== null) return { refused: clash };
  const total = files.reduce((sum, f) => sum + f.bytes.length, 0);
  if (files.length > MAX_SKILL_FILES || total > MAX_SKILL_BYTES) {
    return { refused: `${files.length} files and ${total} bytes, over the limit` };
  }
  if (await skillDigest(files) !== frozen.digest) {
    return { refused: "its files do not match the digest it was frozen with" };
  }
  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (skillMd === undefined) return { refused: "no SKILL.md" };
  // The control plane judged this same SKILL.md when it froze the skill, and recorded with the
  // version every optional field it left out; the same rules leave out the same fields here.
  const parsed = parseSkillMd(skillMd.bytes, () => {});
  if ("refused" in parsed) return parsed;
  if (parsed.name !== frozen.name || parsed.description !== frozen.description) {
    return { refused: "its frontmatter does not name the skill it was frozen as" };
  }
  return {
    name: frozen.name,
    description: frozen.description,
    source: frozen.source,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    files,
  };
}

/** A working repo's skill, prepared: always named by its repo's checkout path. */
export type PreparedRepoSkill = PreparedSkill & { source: "repo"; path: string };

/** One file of a working repo's skill, as git holds it at the base commit. */
export interface RepoSkillFile {
  /** Relative to the skill's directory. */
  path: string;
  executable: boolean;
  bytes: Uint8Array;
}

/**
 * A working repo's skill, judged by the control plane's rules (its core/skills.ts `judgeSkill`):
 * the name's grammar and that it matches the directory, the description's length and
 * characters, a skill that would hide itself from the listing, and the counts and sizes. The
 * reserved prefix and the paths are the caller's, decided from the listing before any byte was
 * read. Answers why it was refused otherwise, in words for the run's trail. An optional field
 * that does not fit is left out and the skill kept, as the control plane does, and `warn` is
 * told: nobody else judges a repo skill, so nobody else would say so.
 */
export function prepareRepoSkill(input: {
  /** The repo's checkout path, as the run names it. */
  repo: string;
  /** The skill's directory under `.agents/skills/`. */
  dir: string;
  files: readonly RepoSkillFile[];
  warn: (message: string) => void;
}): PreparedRepoSkill | { refused: string } {
  const { dir, files } = input;
  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (skillMd === undefined) return { refused: "no SKILL.md as a regular file" };
  const clash = pathClash(files.map((f) => f.path));
  if (clash !== null) return { refused: clash };
  const total = files.reduce((sum, f) => sum + f.bytes.length, 0);
  if (files.length > MAX_SKILL_FILES || total > MAX_SKILL_BYTES) {
    return {
      refused: `${files.length} files and ${total} bytes, over the limit of ${MAX_SKILL_FILES} ` +
        `files and ${MAX_SKILL_BYTES} bytes per skill`,
    };
  }
  const parsed = parseSkillMd(skillMd.bytes, input.warn);
  if ("refused" in parsed) return parsed;
  const { name, description } = parsed;
  if (name.length > MAX_SKILL_NAME || !SKILL_NAME.test(name)) {
    return {
      refused: "`name` must be 1–64 lowercase letters, digits and single hyphens, with no " +
        "hyphen at either end",
    };
  }
  if (name !== dir) return { refused: `\`name\` is "${name}" but the directory is "${dir}"` };
  if (description === "") return { refused: "`description` is empty" };
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return {
      refused: `\`description\` is ${description.length} characters, over the ` +
        `${MAX_DESCRIPTION_CHARS} limit`,
    };
  }
  if (DESCRIPTION_CONTROL.test(description) || !description.isWellFormed()) {
    return { refused: "`description` holds control characters or an unpaired surrogate" };
  }
  if (parsed.hidden) {
    return { refused: "`disable-model-invocation: true` would hide it from the model" };
  }
  return {
    name,
    description,
    source: "repo",
    path: input.repo,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    files: [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  };
}

/** A SKILL.md's frontmatter and body, read by the same rules the control plane holds it to. */
function parseSkillMd(
  bytes: Uint8Array,
  warn: (message: string) => void,
):
  | {
    name: string;
    description: string;
    frontmatter: SkillFrontmatter;
    body: string;
    /** `disable-model-invocation: true`: pi would load it and leave it out of the listing. */
    hidden: boolean;
  }
  | { refused: string } {
  if (bytes.length > MAX_SKILL_MD_BYTES) return { refused: "SKILL.md is over 64 KiB" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { refused: "SKILL.md is not valid UTF-8" };
  }
  const open = /^---\r?\n/.exec(text);
  const rest = open === null ? null : text.slice(open[0].length);
  const close = rest === null ? null : /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (rest === null || close === null) return { refused: "SKILL.md has no frontmatter" };
  let doc: unknown;
  try {
    doc = parseYaml(rest.slice(0, close.index));
  } catch {
    return { refused: "SKILL.md's frontmatter is not valid YAML" };
  }
  if (!isMapping(doc)) return { refused: "SKILL.md's frontmatter is not a mapping" };
  if (typeof doc.name !== "string" || typeof doc.description !== "string") {
    return { refused: "SKILL.md's frontmatter has no name or description" };
  }
  return {
    name: doc.name,
    description: doc.description.trim(),
    frontmatter: optionalFields(doc, warn),
    body: rest.slice(close.index + close[0].length),
    hidden: doc["disable-model-invocation"] === true,
  };
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

/** Whether the control plane's jsonb could hold the string, as its rule has it: a NUL and an
 * unpaired surrogate both survive the UTF-8 check, because YAML decodes its escapes after it. */
function storable(value: string): boolean {
  return value.isWellFormed() && !value.includes("\0");
}

/**
 * `SKILL.md` as the harness reads it: the frontmatter re-emitted from the checked fields, each a
 * JSON string, then the body as it was written.
 */
export function normalizedSkillMd(
  skill: Pick<PreparedSkill, "name" | "description" | "frontmatter" | "body">,
): string {
  const q = (value: string) => JSON.stringify(value);
  const lines = ["---", `name: ${q(skill.name)}`, `description: ${q(skill.description)}`];
  const { license, compatibility, metadata, allowedTools } = skill.frontmatter;
  if (license !== undefined) lines.push(`license: ${q(license)}`);
  if (compatibility !== undefined) lines.push(`compatibility: ${q(compatibility)}`);
  if (allowedTools !== undefined) lines.push(`allowed-tools: ${q(allowedTools)}`);
  if (metadata !== undefined && Object.keys(metadata).length > 0) {
    lines.push("metadata:");
    for (const [key, value] of Object.entries(metadata)) lines.push(`  ${q(key)}: ${q(value)}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n${skill.body}`;
}

/**
 * Writes every skill into one fresh directory, each under its origin (`skillDir`), and answers the
 * root and, in order, each skill's directory or why it could not be written. A skill that fails
 * part-way has its own directory removed and costs only itself: one broken skill never takes the
 * others down, so the run gets every skill but that one rather than half of it. Throws only when
 * the root itself cannot be made.
 */
export async function writeSkills(
  skills: readonly PreparedSkill[],
): Promise<{ root: string; written: Array<{ dir: string } | { error: string }> }> {
  const root = await mkdtemp(join(tmpdir(), "ryph-skills-"));
  const written: Array<{ dir: string } | { error: string }> = [];
  for (const skill of skills) {
    let dir: string | null = null;
    try {
      dir = skillDir(root, skill);
      written.push({ dir: await writeSkill(dir, skill) });
    } catch (err) {
      if (dir !== null) await rm(dir, { recursive: true }).catch(() => {});
      written.push({ error: errorMessage(err) });
    }
  }
  return { root, written };
}

/** Removes a directory `writeSkills` made. */
export async function removeSkills(root: string): Promise<void> {
  await rm(root, { recursive: true });
}

/**
 * Where a skill is written under the root: `catalogue/<name>/`, `org/<name>/` or
 * `repo/<checkout path>/<name>/`. The harness lists a skill by its location, so the agent can
 * tell a repo's own skill, which anyone who can commit there wrote, from one the platform froze,
 * and the last segment stays the skill's name, as pi wants it.
 */
export function skillDir(root: string, skill: SkillOrigin & { name: string }): string {
  const segments = skill.source === "repo"
    ? ["repo", skill.path, skill.name]
    : [skill.source, skill.name];
  // Checked here, where the origin and the name meet the filesystem, whatever already held them:
  // one plain segment each, so nothing nests or climbs.
  if (!segments.every(isPlainSegment)) {
    throw new Error(`not a skill directory: ${segments.join("/")}`);
  }
  return `${root}/${segments.join("/")}`;
}

/**
 * Writes one skill into `dir`, its `skillDir`, `SKILL.md` normalized, every other file as it
 * came, 0644 or 0755 for an executable one. Answers the skill's directory.
 */
async function writeSkill(dir: string, skill: PreparedSkill): Promise<string> {
  for (const file of skill.files) {
    // Checked again here, where the path meets the filesystem: whatever produced this skill,
    // nothing it holds may land outside its own directory.
    if (!isSkillPath(file.path)) throw new Error(`${skill.name}: not a skill path: ${file.path}`);
    const path = `${dir}/${file.path}`;
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    const bytes = file.path === "SKILL.md"
      ? new TextEncoder().encode(normalizedSkillMd(skill))
      : file.bytes;
    await writeFile(path, bytes, { flag: "wx" });
    await chmod(path, file.executable ? 0o755 : 0o644);
  }
  return dir;
}

/**
 * Why a skill's paths cannot all be written, or null when they can: a path that appears twice,
 * or a file that is also the directory of another (`x` and `x/y`), which a tree built without
 * git's fsck can hold. The control plane's `pathClash`, restated.
 */
export function pathClash(paths: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) return `${path} appears twice`;
    seen.add(path);
  }
  for (const path of paths) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const dir = segments.slice(0, depth).join("/");
      if (seen.has(dir)) return `${dir} is a file, and also the directory holding ${path}`;
    }
  }
  return null;
}

/** Whether a path is one a skill may hold: relative, plain segments, at most eight deep. */
export function isSkillPath(path: string): boolean {
  const segments = path.split("/");
  return segments.length <= MAX_PATH_DEPTH && segments.every(isPlainSegment);
}

/** One path segment that names a file or directory and nothing else: `PATH_SEGMENT` alone admits
 * "." and "..", which would stay put or climb out. */
function isPlainSegment(segment: string): boolean {
  return segment !== "." && segment !== ".." && PATH_SEGMENT.test(segment);
}

/**
 * A skill's content digest, the control plane's `skillDigest`:
 *
 *   "sha256:" + hex(sha256( for each file, sorted by path:
 *     utf8(path) 0x00 ("x" if executable else "-") 0x00 utf8(decimal byte length) 0x00 bytes ))
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

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
