// The ryph skills catalogue as a directory — one skill per subdirectory, `<name>/SKILL.md` plus
// whatever references it carries — read and validated ONCE, at construction. An invalid skill
// fails the load loudly, naming the file and every issue, as the service catalogue does: this is
// platform-authored content, so "we skipped the one that did not parse" is not a mode worth
// having, and a warning that would only drop a field in the org repo is a failure here too.
//
// The directory ships inside the package. Resolved through import.meta.url rather than the cwd,
// so the same path works from source, from the control-plane image (its Dockerfile copies the
// directory beside `catalogue/`) and from inside the `ryph` binary's embedded filesystem (its
// compile step `--include`s it).
//
// Every file is read as NOT executable, whatever its mode says: a compiled binary's embedded
// filesystem is not trusted to keep modes, and a digest that differed between the binary and the
// source would be a bug nobody could see. A catalogue script is run through its interpreter.

import { readdir, readFile } from "node:fs/promises";
import { fromFileUrl, join } from "@std/path";
import {
  bundleOf,
  type CatalogueSkill,
  judgeSkill,
  RESERVED_PREFIX,
  type SkillBundle,
  type SkillTreeEntry,
} from "../../core/skills.ts";
import type { SkillCatalogue } from "../../ports/skill_catalogue.ts";

/** Where the skills this package ships live. */
export const SKILL_CATALOGUE_DIR: string = fromFileUrl(new URL("../../../skills", import.meta.url));

export async function directorySkillCatalogue(
  dir: string = SKILL_CATALOGUE_DIR,
): Promise<SkillCatalogue> {
  const problems: string[] = [];
  const skills: CatalogueSkill[] = [];
  const bundles = new Map<string, SkillBundle>();
  const dirs: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    // Files directly in the root (a README) are not skills, and are ignored without a word.
    if (item.isDirectory()) dirs.push(item.name);
    else if (item.isSymbolicLink()) problems.push(`${item.name}: a symlink, not a skill directory`);
  }
  for (const name of dirs.sort()) {
    const entries: SkillTreeEntry[] = [];
    await walk(join(dir, name), "", entries);
    const judged = await judgeSkill({ dir: name, entries, allowReserved: true });
    for (const warning of judged.warnings) problems.push(`${warning.path}: ${warning.message}`);
    if (judged.kind === "dropped" || judged.warnings.length > 0) continue;
    const { skill } = judged;
    if (!skill.name.startsWith(RESERVED_PREFIX)) {
      problems.push(
        `${name}: "${skill.name}" does not start with "${RESERVED_PREFIX}", which every catalogue skill's name must`,
      );
      continue;
    }
    skills.push({
      name: skill.name,
      description: skill.description,
      digest: skill.digest,
      bytes: skill.bytes,
      files: skill.files.map((f) => ({ path: f.path, bytes: f.bytes.length })),
      frontmatter: skill.frontmatter,
      presentation: skill.presentation,
      icons: skill.icons,
    });
    bundles.set(skill.digest, bundleOf(skill));
  }
  if (problems.length > 0) {
    throw new Error(`the skills catalogue at ${dir} is invalid:\n  ${problems.join("\n  ")}`);
  }
  return {
    list: () => structuredClone(skills),
    bundle: (digest) => {
      const bundle = bundles.get(digest);
      return bundle === undefined ? null : structuredClone(bundle);
    },
  };
}

/** Every entry under `root/prefix`, depth-first, as a skill's tree. */
async function walk(root: string, prefix: string, out: SkillTreeEntry[]): Promise<void> {
  const names = await readdir(prefix === "" ? root : join(root, prefix), { withFileTypes: true });
  for (const item of names.sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = prefix === "" ? item.name : `${prefix}/${item.name}`;
    if (item.isDirectory()) {
      await walk(root, path, out);
    } else if (item.isSymbolicLink()) {
      out.push({ path, type: "symlink", executable: false, bytes: new Uint8Array() });
    } else {
      out.push({
        path,
        type: "file",
        executable: false,
        bytes: await readFile(join(root, path)),
      });
    }
  }
}
