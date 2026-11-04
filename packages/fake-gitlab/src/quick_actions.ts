// GitLab's quick actions, as GitLab finds and carries them out — checked against 17.0–17.11 and
// against master at 19.5.0-pre (`Gitlab::QuickActions::Extractor#perform_regex`,
// `Banzai::Pipeline::QuickActionPipeline`, `Banzai::Filter::QuickActionFilter`). Every `\r` is
// deleted, then two detections must BOTH fire:
//
// 1. rendered: the markdown is rendered, and a top-level paragraph (`<p>`, a direct child of the
//    document — never a code block, an HTML block, a blockquote or a list item, nor a line lazily
//    continuing one of those) is a candidate when a line of its TEXT
//    (`node.content`: escapes resolved, each line's leading blanks dropped) starts with `/`;
// 2. raw: within a candidate's source lines, a line runs when it starts — at its very first
//    character, no blank before it — with `/` and a known command name (any case), followed by a
//    space and arguments or by ASCII blanks to the end of the line.
//
// A command line is stripped from the stored text; an unknown one (`/ryph …`), or one the target
// does not offer, stays as written. They run in a note, a note's edit, a draft note when it is
// published, and an issue's or merge request's description on create and on edit.
//
// `matchRendered` models a GitLab whose second detection read the rendered text too — what a
// parser change could make it — so a test can hold an escape to both.
//
// The fake carries out `/close`, `/reopen`, `/label ~a ~"b c"` and `/unlabel …`. Where it may
// differ: the block structure is `markdown.ts`'s CommonMark model, which fails open from any block
// it does not model (description lists, alerts, `>>>`, front matter, footnotes, math — see there), rendering is approximated (leading blanks, backslash escapes), and GitLab's multi-line
// inline code exclusion is not modelled — so the fake may run a command GitLab would not, never
// the other way round.

import type { Instance } from "./instance.ts";
import { blocksOf } from "./markdown.ts";
import { ACCESS, type Noteable, type Project, type User } from "./model.ts";

export interface QuickAction {
  name: "close" | "reopen" | "label" | "unlabel";
  arg: string;
}

/** GitLab's `^\/(?<cmd>NAMES)(?:[ ](?<arg>[^\n]*))?(?:\s*\n|$)`, case-insensitive. Ruby folds
 * case across Unicode (`/cloſe` is `/close`), as `iu` does here; Ruby's `\s` is ASCII's blanks
 * only, so a no-break space after a name is no command. */
const COMMAND = /^\/(close|reopen|label|unlabel)(?: ([^\n]*))?[\t\n\v\f\r ]*$/iu;

/** A paragraph line as GitLab's rendered `node.content` holds it: leading blanks dropped, and
 * CommonMark's backslash escapes resolved (`\/` is `/`). Anything else — a zero-width space
 * included — is text, kept. */
export function renderedLine(line: string): string {
  return line.replace(/^[ \t]+/, "").replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/**
 * The commands `text` carries and the text without their lines (trailing blanks trimmed, as
 * GitLab's `rstrip`). `offered`: the commands the target takes here — `/close` and `/reopen` need
 * a target that exists, so a description being created offers only the label commands.
 */
export function extractQuickActions(
  text: string,
  offered: ReadonlySet<QuickAction["name"]> = new Set(["close", "reopen", "label", "unlabel"]),
  opts: { matchRendered?: boolean } = {},
): { text: string; actions: QuickAction[] } {
  const lines = text.replaceAll("\r", "").split("\n");
  const { paragraphOf } = blocksOf(lines.join("\n"));
  // Detection 1: a top-level paragraph whose rendered text has a line starting with `/`.
  const candidates = new Set<number>();
  lines.forEach((l, i) => {
    if (paragraphOf[i]! >= 0 && renderedLine(l).startsWith("/")) candidates.add(paragraphOf[i]!);
  });
  const kept: string[] = [];
  const actions: QuickAction[] = [];
  lines.forEach((line, i) => {
    // Detection 2: the source line itself is a command.
    const m = candidates.has(paragraphOf[i]!)
      ? COMMAND.exec(opts.matchRendered ? renderedLine(line) : line)
      : null;
    const name = m?.[1]?.toLowerCase() as QuickAction["name"] | undefined;
    if (m && name !== undefined && offered.has(name)) actions.push({ name, arg: m[2] ?? "" });
    else kept.push(line);
  });
  return { text: kept.join("\n").trimEnd(), actions };
}

function labelsIn(args: string): string[] {
  return [...args.matchAll(/~"([^"]+)"|~(\S+)/g)].map((m) => (m[1] ?? m[2])!);
}

/** What a set of commands asks of the target. */
export interface QuickEdit {
  stateEvent?: "close" | "reopen";
  addLabels?: string[];
  removeLabels?: string[];
}

export function editOf(actions: QuickAction[]): QuickEdit {
  const edit: QuickEdit = {};
  for (const a of actions) {
    if (a.name === "close") edit.stateEvent = "close";
    else if (a.name === "reopen") edit.stateEvent = "reopen";
    else if (a.name === "label") edit.addLabels = [...(edit.addLabels ?? []), ...labelsIn(a.arg)];
    else edit.removeLabels = [...(edit.removeLabels ?? []), ...labelsIn(a.arg)];
  }
  return edit;
}

/** GitLab's sentences for what a quick action did, as a 202 lists them. */
export function summaryOf(applied: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (applied.state_event === "close") out.push("Closed this merge request.");
  if (applied.state_event === "reopen") out.push("Reopened this merge request.");
  if (applied.add_label_ids) out.push("Added labels.");
  if (applied.remove_label_ids) out.push("Removed labels.");
  return out;
}

/**
 * A description being created: the label commands only (there is nothing to close yet), for
 * someone who may label in `project` — Reporter and up. Answers the description as stored and
 * the labels it adds and removes.
 */
export function onCreate(
  gl: Instance,
  actor: User,
  project: Project,
  text: string,
): { description: string; addLabels: string[]; removeLabels: string[] } {
  if (!gl.world.can(actor, project, ACCESS.reporter)) {
    return { description: text, addLabels: [], removeLabels: [] };
  }
  const { text: description, actions } = extractQuickActions(text, new Set(["label", "unlabel"]));
  const edit = editOf(actions);
  return { description, addLabels: edit.addLabels ?? [], removeLabels: edit.removeLabels ?? [] };
}

/**
 * Finds the commands in `text` and carries them out on `on` as `actor`, who must be able to
 * change it (its author, or Reporter and up); answers the text as stored and what was done.
 * Someone who may not change it gets the text back whole, as GitLab offers them no command.
 */
export async function carryOut(
  gl: Instance,
  actor: User,
  on: Noteable,
  text: string,
): Promise<{ body: string; applied: Record<string, unknown> }> {
  const project = gl.world.projects.get(on.projectId)!;
  if (!gl.world.can(actor, project, ACCESS.reporter) && on.authorId !== actor.id) {
    return { body: text, applied: {} };
  }
  const { text: body, actions } = extractQuickActions(text);
  const applied: Record<string, unknown> = {};
  if (actions.length === 0) return { body, applied };
  const edit = editOf(actions);
  if (edit.stateEvent) applied.state_event = edit.stateEvent;
  if (edit.addLabels) applied.add_label_ids = edit.addLabels;
  if (edit.removeLabels) applied.remove_label_ids = edit.removeLabels;
  if (on.kind === "issue") gl.updateIssue(actor, on, edit);
  else await gl.mrs.update(actor, on, edit);
  return { body, applied };
}
