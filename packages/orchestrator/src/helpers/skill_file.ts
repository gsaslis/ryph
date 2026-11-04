// A `SKILL.md`'s frontmatter, split off and parsed. The rules about what the fields may hold are
// core/skills.ts's; this file only finds the YAML and reads it, so the core stays free of a
// parser it does not need to know about.
//
// The frontmatter is the file's first line `---`, everything up to the next line that is `---`,
// and nothing else: no BOM, no leading blank line, no `...` terminator. The Agent Skills
// specification shows exactly that shape, and pi finds it the same way, so a file this refuses
// is one pi would not read as a skill either.
//
// No anchor screen, unlike the checks and services parsers (helpers/services.ts
// `refuseAnchors`): a skill description is prose, where `, *bold*` is ordinary text the screen
// would refuse. What bounds an alias expansion here is that nothing deep-walks the document:
// the rules read a handful of named fields, each held to a string or a flat map of strings, and
// the file itself is capped before it is parsed.

import { parse as parseYaml } from "@std/yaml";

/** The frontmatter's YAML and the body after its closing line, or null when there is none. */
export function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const open = /^---\r?\n/.exec(text);
  if (open === null) return null;
  const rest = text.slice(open[0].length);
  // The closing line may be the very first line of the rest (an empty frontmatter), so the
  // match looks for `---` at the start of ANY line, including the first.
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (close === null) return null;
  return { yaml: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length) };
}

/** The frontmatter, parsed; throws with the parser's message when it is not YAML. */
export function parseFrontmatter(yaml: string): unknown {
  try {
    return parseYaml(yaml);
  } catch (err) {
    throw new Error(`the frontmatter is not valid YAML: ${parserMessage(err)}`);
  }
}

/** A YAML file a skill carries beside its SKILL.md (`agents/openai.yaml`), parsed; throws with
 * the parser's message when it is not YAML. Bounded the same way: the caller reads named fields
 * and never walks the document, and the file is capped before it is parsed. */
export function parseSkillYaml(text: string): unknown {
  try {
    return parseYaml(text);
  } catch (err) {
    throw new Error(`not valid YAML: ${parserMessage(err)}`);
  }
}

/** The parser's message, which quotes the line it stopped at, made storable: it becomes a sync
 * warning in jsonb, which refuses a NUL and an unpaired surrogate. */
function parserMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.toWellFormed().replaceAll("\0", "\uFFFD");
}
