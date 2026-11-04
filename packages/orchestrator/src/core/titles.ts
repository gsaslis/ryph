// A task's title, when nobody gave it one.
//
// A task that arrives with instructions and no title — from the app, the API, or a prompt sent
// to a task started without one — is titled at once with the instructions' first line, cut short
// (`fallbackTitle`). Then the platform's background model is asked for a better one, off the
// request path, and that replaces the fallback when it lands (`titleTask`).
//
// Invariants:
// - a title a caller passed is never touched: only a task still titled with ITS OWN fallback is
//   retitled, and the replacement is a compare-and-set on that exact value (`retitleTask`), so
//   anything that wrote the title meanwhile wins
// - the model is optional and never in the way: none configured, a refusal, nonsense or a slow
//   answer each leave the fallback standing, and none of them fails anything
// - the answer is untrusted text: one line, no quotes, bounded — whatever the model said
// - the change lands through the store, whose wrapper announces it on the task feed, so the
//   list's live tail shows the new title without a reload

import type { Diagnostics } from "../ports/diagnostics.ts";
import type { PlatformModel } from "../ports/platform_model.ts";
import type { TaskStore } from "../ports/task_store.ts";
import type { Task } from "./types.ts";

/** The longest fallback title, before its ellipsis. */
export const FALLBACK_TITLE_CHARS = 60;
/** The longest title the model may give; anything longer is cut at a word. */
export const GENERATED_TITLE_CHARS = 80;
/** How long the model is given before the fallback is kept for good. */
export const TITLE_TIMEOUT_MS = 20_000;
/** How much of the instructions the model is shown: the start says what the task is. */
const PROMPT_CHARS = 4_000;
/** How many of the request's references the model is told about. */
const MAX_PROMPT_REFERENCES = 3;
/** The fallback for instructions with no words at all — a prompt of images only. */
const UNTITLED = "New task";

/** Whether the task is still waiting for the first message that becomes its instructions. */
export function awaitsPrompt(task: Pick<Task, "spec">): boolean {
  return task.spec.instructions === null;
}

/**
 * The instructions' first line with words in it, as a title: image markers and leading markdown
 * dropped, whitespace collapsed, and cut at a word boundary past FALLBACK_TITLE_CHARS with an
 * ellipsis. A link to an issue, pull request or patch reads as its reference ("issue #216"), and
 * instructions that open with one are named by it and the verb that follows: "Tackle issue
 * #216", or "Issue #216" with no verb to take. Never empty, never more than one line.
 */
export function fallbackTitle(instructions: string): string {
  const lines = instructions
    .split(/\r?\n/)
    .map((l) =>
      l.replace(/[\[［]\s*image\s*\d+\s*[\]］]/giu, " ")
        .replace(/^\(attached:[^)]*\)$/i, " ")
        .replace(/^[\s#>*+\-]+(?!\d)/, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((l) => l !== "");
  if (lines.length === 0) return UNTITLED;
  return clipAtWord(referenceTitle(lines) ?? lines[0], FALLBACK_TITLE_CHARS, "…");
}

/** A thing a request can point at that the title writer cannot see, as text names it. */
export interface TaskReference {
  /** "issue #216", "PR #88", "patch 3f2a1b9", "#12". */
  label: string;
  /** The repo it is in, when the reference says: "acme/app", or a Radicle RID. */
  repo: string | null;
}

/** A link to a numbered issue, pull or merge request on GitHub, or any forge spelled like it. */
const NUMBERED_LINK =
  /https?:\/\/[^\s\/]+\/((?:[^\s\/]+\/)*?[^\s\/]+)\/(?:-\/)?(issues|pull|pulls|merge_requests)\/(\d+)(?:[\/?#][^\s)>\]]*)?/gi;
/** A Radicle issue or patch, bare or inside a web link. */
const RADICLE_LINK =
  /(?:https?:\/\/[^\s]*?\/)?(rad:z[1-9A-HJ-NP-Za-km-z]+)\/(issues|patches)\/([0-9a-f]{7,40})(?:[\/?#][^\s)>\]]*)?/g;
/** "#216" or "acme/app#216", standing alone. */
const SHORTHAND = /(?<![\w\/#&])((?:[\w.-]+\/[\w.-]+)?)#(\d+)\b/g;

/** Every issue, pull request or patch reference in `text`, links first, in order, deduplicated by
 * label. Nothing is fetched: the references only name what the request points at. */
export function extractReferences(text: string): TaskReference[] {
  const found: TaskReference[] = [];
  const add = (ref: TaskReference) => {
    if (!found.some((f) => f.label === ref.label && f.repo === ref.repo)) found.push(ref);
  };
  for (const m of text.matchAll(NUMBERED_LINK)) add(numberedReference(m));
  for (const m of text.matchAll(RADICLE_LINK)) add(radicleReference(m));
  // Any other link's anchor ("…/page#12") is no reference.
  const rest = text.replace(NUMBERED_LINK, " ").replace(RADICLE_LINK, " ")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
  for (const m of rest.matchAll(SHORTHAND)) add({ label: `#${m[2]}`, repo: m[1] || null });
  return found;
}

function numberedReference(m: RegExpMatchArray): TaskReference {
  const kind = m[2].toLowerCase() === "issues"
    ? "issue"
    : m[2].toLowerCase() === "merge_requests"
    ? "MR"
    : "PR";
  return { label: `${kind} #${m[3]}`, repo: m[1] };
}

function radicleReference(m: RegExpMatchArray): TaskReference {
  return { label: `${m[2] === "issues" ? "issue" : "patch"} ${m[3].slice(0, 7)}`, repo: m[1] };
}

/** `line` with every reference link read as its label. */
function withLabels(line: string): string {
  return line
    .replace(NUMBERED_LINK, (...m) => numberedReference(m as unknown as RegExpMatchArray).label)
    .replace(RADICLE_LINK, (...m) => radicleReference(m as unknown as RegExpMatchArray).label)
    .replace(/\s+/g, " ")
    .trim();
}

/** Verbs a request may open with that name the work on a reference: "tackle" + "issue #216". */
const REFERENCE_VERBS = new Set([
  "tackle",
  "fix",
  "implement",
  "review",
  "investigate",
  "address",
  "resolve",
  "solve",
  "handle",
  "finish",
  "continue",
  "close",
  "update",
  "rebase",
  "merge",
  "test",
  "debug",
  "triage",
  "check",
  "summarize",
  "summarise",
  "reproduce",
  "refactor",
  "build",
]);
/** Verbs that take their particle along: "look into issue #216". */
const PHRASAL_VERBS: Record<string, string[]> = {
  look: ["into", "at"],
  work: ["on"],
  pick: ["up"],
  follow: ["up"],
};

/** The verb `text` opens with, past any "please" or "can you", as a title starts it. */
function leadingVerb(text: string): string | null {
  const words = text
    .toLowerCase()
    .replace(/^(?:(?:please|pls|plz|can you|could you|would you|hey|hi|ok|okay)[\s,!]+)+/, "")
    .split(/[^a-z']+/)
    .filter((w) => w !== "");
  const [first, second] = words;
  if (first === undefined) return null;
  if (REFERENCE_VERBS.has(first)) return capitalize(first);
  if (second !== undefined && PHRASAL_VERBS[first]?.includes(second)) {
    return `${capitalize(first)} ${second}`;
  }
  return null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The title for instructions whose first line with words opens with a reference — "Tackle issue
 * #216" for a link followed by "tackle this issue please" — or that line with its links read as
 * labels; null when the line names no reference at all.
 */
function referenceTitle(lines: string[]): string | null {
  const [line, next] = lines;
  const refs = extractReferences(line);
  if (refs.length === 0) return null;
  const labelled = withLabels(line);
  const label = refs[0].label;
  if (!labelled.startsWith(label)) return labelled;
  // What follows the leading references, on the line or else on the next one.
  let after = labelled;
  for (const ref of refs) {
    if (after.startsWith(ref.label)) {
      after = after.slice(ref.label.length).replace(/^[\s,;:.\-–—]+/, "");
    }
  }
  const context = after !== "" ? after : next ?? "";
  const verb = leadingVerb(context);
  if (verb !== null) return `${verb} ${label}`;
  return after === "" ? capitalize(label) : capitalize(labelled);
}

/**
 * Whether a model's answer is about the answer rather than the work: "Need issue title",
 * "Unknown task", "I cannot see the link". Targeted phrases, so a title that merely contains such
 * a word ("Missing index on runs", "Unknown column error in migrations") still stands.
 */
export function isMetaTitle(title: string): boolean {
  return META_TITLE_PATTERNS.some((p) => p.test(title));
}

const META_TITLE_PATTERNS: RegExp[] = [
  /^needs? (?:(?:more|the|a|an|an?other|some|further|additional) )*(?:info|information|context|details?|title|clarification|issue|task|link|access|description)\b/i,
  /^(?:unknown|unclear|untitled|unspecified|n\/a|none|no title|tbd)(?: (?:task|request|issue|work|title|reference))?$/i,
  /^(?:missing|no|insufficient|lacking|not enough) (?:title|context|info|information|details|description)$/i,
  /^(?:insufficient|not enough|lacking) (?:info|information|context|details)\b/i,
  /\b(?:issue|task|request|pr|pull request|ticket) (?:title|details|description|content) (?:needed|required|missing|unavailable|unknown|not provided)\b/i,
  /\b(?:title|context|info|information|details) (?:needed|required|unavailable|not provided|not available)\b/i,
  /\b(?:more|additional|further) (?:info|information|context|details)(?: (?:needed|required))?$/i,
  /^(?:please )?(?:provide|share|clarify|specify|paste)\b/i,
  /^(?:i|i'm|i am|i can't|i cannot|sorry|unable|cannot|can't)\b/i,
  /\b(?:can't|cannot|unable to) (?:see|access|open|read|view|determine|tell)\b/i,
];

/**
 * A model's answer as a title, or null when nothing usable is left: the first line with words,
 * any "Title:" lead-in, wrapping quotes, markdown emphasis and trailing periods gone, whitespace
 * collapsed, and cut at a word past GENERATED_TITLE_CHARS. An answer about itself rather than
 * the work (`isMetaTitle`) is no title either.
 */
export function sanitizeTitle(raw: string): string | null {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
  if (line === undefined) return null;
  let title = line
    .replace(/^#+\s*/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Quotes the model wrapped it in, possibly twice ("'Fix it'").
  for (let i = 0; i < 2; i++) {
    title = title.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "").trim();
  }
  title = title.replace(/[.。]+$/, "").replace(/^[-\s]+/, "").trim();
  if (title === "" || isMetaTitle(title)) return null;
  return clipAtWord(title, GENERATED_TITLE_CHARS, "");
}

/** `text` cut at the last space before `max` (or at `max` when no space comes late enough). */
function clipAtWord(text: string, max: number, ellipsis: string): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}${ellipsis}`;
}

export interface TitleDeps {
  store: Pick<TaskStore, "getTask" | "getAgent" | "getWorkspace" | "retitleTask">;
  /** The background model. Null: no titles are generated, and every fallback stands. */
  platformModel: PlatformModel | null;
  diag: Diagnostics;
  /** Tests shrink it. */
  titleTimeoutMs?: number;
}

const SYSTEM = [
  "You name tasks that people hand to a coding agent, for the list they are shown in.",
  "Write a short label for the work, two to five words, the way a ticket or a changelog entry " +
  "would name it: a noun phrase in sentence case. Never restate or paraphrase the request, never " +
  'address anyone, and drop filler like "please", "can you" or "etc".',
  "When the request mostly points at something you cannot see — a link to an issue, pull " +
  'request or patch, or a number like "#123" — name the work by that reference, with the verb ' +
  'the person used: "Tackle issue #216", "Review PR #88", or just "Issue #216". Never write ' +
  "about yourself, about what you cannot see or what is missing, and never ask for anything: " +
  "a label is always possible.",
  "Answer with the label alone: no quotes, no trailing period, no emoji, no prefix.",
  "Examples:",
  '"Investigate the tools available to you, like browser, commands, etc." -> Investigation of available tools',
  '"the login page breaks on safari when you hit enter twice" -> Safari double-submit on login',
  '"Can you add a dark mode toggle to the settings page?" -> Dark mode toggle in settings',
  '"bump deno to 2.9 and fix whatever breaks" -> Deno 2.9 upgrade',
  '"https://github.com/acme/app/issues/216 tackle this issue please" -> Tackle issue #216',
  '"review #88 when you get a chance" -> Review PR #88',
].join("\n");

/**
 * Asks the background model for the task's title and puts it in place of `fallback` — the
 * title the task was given at once. Answers whether it did. Never throws: every way this can go
 * wrong keeps the fallback, said at warn either way, so a title that never changes says why. No
 * background model at all is said nowhere: it is an ordinary configuration.
 */
export async function titleTask(
  deps: TitleDeps,
  taskId: string,
  fallback: string,
): Promise<boolean> {
  const model = deps.platformModel;
  if (model === null) return false;
  try {
    const task = await deps.store.getTask(taskId);
    // Somebody named it meanwhile, or it is not a task this was asked about.
    if (task === null || task.spec.instructions === null || task.spec.title !== fallback) {
      return false;
    }
    const [agent, workspace] = await Promise.all([
      deps.store.getAgent(task.agentId),
      task.workspaceId === null ? null : deps.store.getWorkspace(task.workspaceId),
    ]);
    const where = workspace !== null
      ? `the workspace "${workspace.name}" (${task.repos.map((r) => r.name).join(", ")})`
      : task.repos.map((r) => r.name).join(", ");
    const instructions = task.spec.instructions.slice(0, PROMPT_CHARS);
    const refs = extractReferences(instructions).slice(0, MAX_PROMPT_REFERENCES);
    const prompt = [
      `Agent: ${agent?.name ?? "the agent"}`,
      `Working on: ${where}`,
      ...(refs.length === 0 ? [] : [
        `Points at (not visible to you): ${
          refs.map((r) => r.repo === null ? r.label : `${r.label} in ${r.repo}`).join(", ")
        }`,
      ]),
      "",
      "What the person asked, between the markers:",
      "<<<task",
      instructions,
      "task>>>",
      "",
      "The title:",
    ].join("\n");
    // Room for a reasoning model's thinking, which counts against the same ceiling: at 40 a
    // model that reasons first answers with nothing. The answer is cut to a title regardless.
    const answer = await bounded(
      (signal) => model.complete({ system: SYSTEM, prompt, maxTokens: 1024, signal }),
      deps.titleTimeoutMs ?? TITLE_TIMEOUT_MS,
    );
    if (answer.kind !== "answered") {
      deps.diag.warn("task.title_kept", { taskId, reason: answer.reason });
      return false;
    }
    const title = sanitizeTitle(answer.text);
    if (title === null || title === fallback) {
      deps.diag.warn("task.title_kept", { taskId, reason: "the model gave no usable title" });
      return false;
    }
    const moved = await deps.store.retitleTask(taskId, fallback, title);
    deps.diag.debug("task.titled", { taskId, moved });
    return moved;
  } catch (err) {
    deps.diag.warn("task.title_failed", { taskId, err: String(err) });
    return false;
  }
}

/** `titleTask`, started and left to finish on its own: what the doors call. */
export function startTitling(deps: TitleDeps, taskId: string, fallback: string): void {
  if (deps.platformModel === null) return;
  void titleTask(deps, taskId, fallback);
}

/** A call held to `ms`, whether or not it honours its signal. */
async function bounded(
  call: (signal: AbortSignal) => Promise<string>,
  ms: number,
): Promise<{ kind: "answered"; text: string } | { kind: "kept"; reason: string }> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "kept"; reason: string }>((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve({ kind: "kept", reason: `the model did not answer within ${ms}ms` });
    }, ms);
  });
  try {
    return await Promise.race([
      call(abort.signal).then(
        (text) => ({ kind: "answered" as const, text }),
        (err) => ({ kind: "kept" as const, reason: String(err) }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
