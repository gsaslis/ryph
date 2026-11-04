import { z } from "zod";
import { type AttachmentRef, attachmentRefSchema, type HistoryEvent } from "./types";
import { BROWSER_SERVER } from "$lib/utils/browser-tools";

// A tool call reaches us as two transcript events — the invocation and its outcome — whose
// structured detail rides in `payload`, typed `unknown` by contract. Nothing here is guaranteed:
// the echo harness sends no payload at all, and the runner's emitter reduces any payload over 32 KB
// to its identifying scalars. So every read is a safeParse and every failure falls back to the
// event's flat `text`, which is always there.
//
// A truncated payload keeps `toolCallId` (see the runner's emitter) — which is what lets a `read`
// of a big file still fold into one row, having lost only its body. That is a contract across two
// packages, and the emitter's tests are what hold up this end of it.

const toolUsePayload = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown().optional(),
});

const toolResultPayload = z.object({
  toolCallId: z.string(),
  result: z.unknown().optional(),
  isError: z.boolean().optional(),
});

/** `write` replaces a whole file: it carries the new content and no trace of the old. */
const writeArgs = z.object({ path: z.string(), content: z.string() });

/** `edit` and `read` both name their file up front; what they did with it is in the result. */
const editArgs = z.object({ path: z.string() });

/** `bash` is the one tool whose input is not a path. */
const bashArgs = z.object({ command: z.string() });

/**
 * A tool the ryph pi-mcp extension registered, as `<server slug>__<tool>` — the slug grammar is
 * the gateway's, and pi's own tools never carry a double underscore. The split is what lets the
 * row say which server a call went to, which the transcript alone does not record anywhere else.
 */
const MCP_TOOL_NAME = /^([a-z0-9][a-z0-9-]{0,38})__(.+)$/;

/** The server slug and remote tool name behind an extension-registered tool; null for any other. */
export function splitMcpToolName(name: string): { server: string; tool: string } | null {
  const match = MCP_TOOL_NAME.exec(name);
  return match === null ? null : { server: match[1], tool: match[2] };
}

/**
 * Every tool answers in the same envelope: a list of parts. `read` returns the file this way and
 * `bash` its console output — including a failure, which arrives as ordinary text alongside
 * `isError` rather than in a field of its own.
 */
const toolTextResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

/** The text parts of a tool's reply, concatenated; empty string when it said nothing. */
function textOf(result: unknown): string {
  const parsed = toolTextResult.safeParse(result);
  if (!parsed.success) return "";
  // Joined rather than [0] so a chunked reply survives whole.
  return parsed.data.content
    .filter((part) => part.type === "text" && part.text !== undefined)
    .map((part) => part.text)
    .join("");
}

/**
 * The image parts of a tool's reply as the history holds them. The bytes never are: the runner
 * swaps `data` for a note of its size, and a block it stored as a run attachment carries that
 * attachment's id. So `data` is never something to draw.
 */
const toolImageResult = z.object({
  content: z.array(z.object({ type: z.string(), attachment: z.unknown().optional() }).loose()),
});

/** The images a tool sent back: the ones kept as run attachments, and how many were not. */
export interface ToolImages {
  /** Drawn from the run's attachments, in the order the reply held them. */
  kept: AttachmentRef[];
  /** Image parts with no attachment to draw (too big, an upload that failed, a type not taken). */
  notKept: number;
}

const NO_IMAGES: ToolImages = { kept: [], notKept: 0 };

/**
 * An oversize result as the runner's emitter reduced it: its scalars, and the attachments its
 * image parts named as `images: [{id, mime}]` (the image parts themselves went with the bulk).
 */
const truncatedImages = z.object({ truncated: z.literal(true), images: z.array(z.unknown()) });

/**
 * A reply's image parts, read as run attachments. Only an `attachment` that parses (an id and a
 * png, jpeg, gif or webp type) is drawn; every other image part is counted as not kept. Takes a
 * reply (`{content}`) or a truncated result's whole payload (`{truncated, images}`), whose refs
 * are read the same way; what a truncation dropped is not counted.
 */
export function imagesOf(result: unknown): ToolImages {
  const truncated = truncatedImages.safeParse(result);
  if (truncated.success) {
    const kept: AttachmentRef[] = [];
    for (const image of truncated.data.images) {
      const ref = attachmentRefSchema.safeParse(image);
      if (ref.success) kept.push({ id: ref.data.id, mime: ref.data.mime });
    }
    return kept.length === 0 ? NO_IMAGES : { kept, notKept: 0 };
  }
  const parsed = toolImageResult.safeParse(result);
  if (!parsed.success) return NO_IMAGES;
  const kept: AttachmentRef[] = [];
  let notKept = 0;
  for (const part of parsed.data.content) {
    if (part.type !== "image") continue;
    const ref = attachmentRefSchema.safeParse(part.attachment);
    if (ref.success) kept.push({ id: ref.data.id, mime: ref.data.mime });
    else notKept++;
  }
  return kept.length === 0 && notKept === 0 ? NO_IMAGES : { kept, notKept };
}

/**
 * `edit` reports itself as a unified patch — the one real before/after in the whole record,
 * since no other tool reads a file before changing it.
 */
const editResult = z.object({
  details: z.object({ patch: z.string() }).partial().optional(),
});

/** Where the run's checkout lived. The runner emits this before it does anything else. */
const workspaceCreated = z.object({ dir: z.string() });

/** How much of a file a call touched — the row's `+n -n`, so a closed row still says how big it is. */
export interface DiffStat {
  added: number;
  removed: number;
}

/** Lines in a file: a trailing newline ends the last line rather than starting another. */
function countLines(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

/**
 * Additions and deletions in a unified patch. Counting only starts at the first hunk header, so the
 * `---`/`+++` file headers are not miscounted as a deleted and an added line. Within a hunk the
 * marker is the first column and the content follows it, so a line that itself begins with `-`
 * arrives as `--…` and still counts exactly once.
 */
function statOfPatch(patch: string): DiffStat {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (!inHunk) continue;
    else if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/**
 * The workspace root, from the `workspace.created` diag event. The runner emits it as its first
 * event of the run, so it is always known by the time a path could mention it — but only by a
 * reader that has the start of the run. A transcript opened at its tail has not, which is why the
 * page loads the head as well and hands the root it finds there to every page's merge.
 */
export function workspaceRootOf(events: readonly HistoryEvent[]): string | null {
  for (const event of events) {
    if (event.voice !== "diag" || event.kind !== "workspace.created") continue;
    const parsed = workspaceCreated.safeParse(event.payload);
    if (parsed.success) return parsed.data.dir;
  }
  return null;
}

/**
 * A path as it reads inside the checkout. The harness echoes back whatever absolute path it was
 * handed, but the temp root is a per-run hash that is gone by the time anyone reads this and means
 * nothing to them — what identifies the file is its path within the repo. Only ever strips the root
 * this very run reported: an unrecognized path is shown exactly as recorded rather than guessed at,
 * and runs whose harness already reports relative paths pass through untouched.
 */
function relativize(path: string, root: string | null): string {
  if (root === null) return path;
  if (path === root) return "."; // the checkout itself — a `read` of the directory
  if (!path.startsWith(root + "/")) return path;
  return path.slice(root.length + 1) || ".";
}

/**
 * What a call's body should show. `write` has no previous version anywhere in the pipeline, so it
 * renders as an all-addition diff — true for the new file it usually is, and the most it can
 * honestly claim otherwise. `opaque` is the degradation path: an unrecognized tool, a payload that
 * got truncated, or an edit still waiting on its result.
 */
export type ToolView =
  | { kind: "write"; path: string; content: string; stat: DiffStat }
  | { kind: "edit"; path: string; patch: string; stat: DiffStat }
  | { kind: "read"; path: string; content: string }
  /** `output` is null only while the command is still running. */
  | { kind: "bash"; command: string; output: string | null }
  /** A call through the MCP gateway: which server, which of its tools, with what, and what came back. */
  | { kind: "mcp"; server: string; tool: string; args: unknown; output: string | null }
  /**
   * A call to the run's own browser. `truncated` is a reply the runner cut down to its id because
   * it was too big for the history, so what it said is gone.
   */
  | {
    kind: "browser";
    tool: string;
    args: unknown;
    output: string | null;
    truncated: boolean;
  }
  /** A post into the run's chat: what the agent said there, drawn as its side of the conversation. */
  | { kind: "chat"; text: string }
  | { kind: "opaque" };

/** One tool call, with its outcome folded back in. */
export interface ToolCall {
  /** The tool_use's seq — the call's place in the run. */
  seq: number;
  /** The run the call belongs to, which is where its images are read from. */
  runId: string;
  at: string;
  name: string;
  /** The tool's own summary of what it did; null while the call is still in flight. */
  resultText: string | null;
  useText: string | null;
  isError: boolean;
  done: boolean;
  view: ToolView;
  /** Any tool's images: a screenshot, or pi's `read` of an image file. */
  images: ToolImages;
}

/**
 * A call's outcome as the view needs to read it: whether the answer has ARRIVED is a different
 * question from what it said, and `undefined` cannot hold both. A tool that fails carries no
 * `result` field at all (the pi adapter says so in as many words), and so does a result whose
 * payload was truncated past it — conflating those with "still in flight" left a finished call
 * rendering "Running…", with no spinner, forever.
 */
type Outcome = { arrived: false } | { arrived: true; value: unknown; truncated?: boolean };

function viewFor(name: string, args: unknown, result: Outcome, root: string | null): ToolView {
  const value = result.arrived ? result.value : undefined;
  const mcp = splitMcpToolName(name);
  if (mcp !== null && mcp.server === "chat" && mcp.tool === "post") {
    const text = (args as { text?: unknown } | null)?.text;
    if (typeof text === "string") return { kind: "chat", text };
  }
  if (mcp !== null && mcp.server === BROWSER_SERVER) {
    return {
      kind: "browser",
      tool: mcp.tool,
      args,
      output: result.arrived ? textOf(result.value) : null,
      truncated: result.arrived && result.truncated === true,
    };
  }
  if (mcp !== null) {
    // The extension maps every result to content blocks, so the text parts are the whole reply;
    // an error reply reads the same way, flagged by `isError` on the row.
    return {
      kind: "mcp",
      server: mcp.server,
      tool: mcp.tool,
      args,
      output: result.arrived ? textOf(result.value) : null,
    };
  }
  if (name === "write") {
    const parsed = writeArgs.safeParse(args);
    if (parsed.success) {
      // Every line is an addition and nothing is removed — the same claim the all-addition diff
      // below it makes, counted from the same content.
      return {
        kind: "write",
        path: relativize(parsed.data.path, root),
        content: parsed.data.content,
        stat: { added: countLines(parsed.data.content), removed: 0 },
      };
    }
  }
  if (name === "edit") {
    const path = editArgs.safeParse(args);
    const patch = editResult.safeParse(value);
    if (path.success && patch.success && patch.data.details?.patch) {
      return {
        kind: "edit",
        path: relativize(path.data.path, root),
        patch: patch.data.details.patch,
        stat: statOfPatch(patch.data.details.patch),
      };
    }
  }
  if (name === "read") {
    const path = editArgs.safeParse(args);
    const text = textOf(value);
    if (path.success && text !== "") {
      return { kind: "read", path: relativize(path.data.path, root), content: text };
    }
  }
  if (name === "bash") {
    const parsed = bashArgs.safeParse(args);
    if (parsed.success) {
      // A command that printed nothing still ran, and a command still running has no output yet —
      // both are worth showing as themselves rather than collapsing to `opaque`. Keyed on whether
      // the answer arrived, not on whether it had anything in it: a result that came back empty has
      // finished, and `""` says so honestly where `null` would claim it is still going.
      const output = result.arrived ? textOf(result.value) : null;
      return { kind: "bash", command: parsed.data.command, output };
    }
  }
  return { kind: "opaque" };
}

/** What one call was built from, so a later merge can tell that nothing about it has changed. */
interface CallSource {
  use: HistoryEvent;
  result: HistoryEvent | null;
  root: string | null;
}

/** One merge's answer. `sources` is only ever read back by the next merge of the same page. */
export interface MergedCalls {
  calls: Map<number, ToolCall>;
  absorbed: Set<number>;
  /** Results here whose `tool_use` is not: what the page ABOVE this one has to be offered. */
  orphanResults: HistoryEvent[];
  /** What each call was built from: the identities `previous` is checked against. */
  sources: Map<number, CallSource>;
}

/**
 * Fold each `tool_result` back onto the `tool_use` it answers, so a call and its outcome are one
 * row instead of two. `toolCallId` is the join — the runner is the single writer for its run, so
 * ids never collide within one.
 *
 * Returns the calls keyed by their tool_use seq, plus the seqs of the results that were absorbed:
 * the caller drops those so they do not also render on their own. A result whose call never parsed
 * is deliberately left out of `absorbed` — it still deserves a line rather than vanishing.
 */
export function mergeToolCalls(
  events: readonly HistoryEvent[],
  opts: {
    /** The run's checkout, read off the head of the run; `null` falls back to these events. */
    root?: string | null;
    /**
     * Results from the page BELOW this one, for the call that ran at its very end: a `tool_use`
     * at the bottom of a page is answered at the top of the next, and neither page holds both
     * halves. Their seqs land in `absorbed` like any other, so the page they really live in knows
     * not to draw them a second time.
     */
    carried?: readonly HistoryEvent[];
    /**
     * The last merge of these same events, if there was one. A call built from the same `tool_use`,
     * the same result and the same root is the same call, and is handed back as the SAME OBJECT.
     *
     * That identity is load-bearing, not a saving: a live tail re-merges the newest page on every
     * event it delivers, and an equal-but-new `ToolCall` reaches the open row as a changed prop.
     * The syntax highlighter's effect then tears its render down and rebuilds it — the card drops
     * to plain text, loses a hundred-odd pixels of height for a frame, and a transcript following
     * the tail scrolls against the dip. Same facts, same object, and nothing downstream stirs.
     */
    previous?: MergedCalls;
  } = {},
): MergedCalls {
  const root = opts.root ?? workspaceRootOf(events);

  const results = new Map<string, HistoryEvent>();
  const uses = new Set<string>();
  for (const event of events) {
    if (event.kind === "tool_use") {
      const parsed = toolUsePayload.safeParse(event.payload);
      if (parsed.success) uses.add(parsed.data.toolCallId);
      continue;
    }
    if (event.kind !== "tool_result") continue;
    const parsed = toolResultPayload.safeParse(event.payload);
    if (parsed.success) results.set(parsed.data.toolCallId, event);
  }
  const orphanResults: HistoryEvent[] = [];
  for (const [id, event] of results) if (!uses.has(id)) orphanResults.push(event);
  for (const event of opts.carried ?? []) {
    const parsed = toolResultPayload.safeParse(event.payload);
    // A carried result never displaces one from this page: the id is the runner's own and unique
    // within a run, so the two would be the same event arriving from two directions.
    if (parsed.success && !results.has(parsed.data.toolCallId)) {
      results.set(parsed.data.toolCallId, event);
    }
  }

  const calls = new Map<number, ToolCall>();
  const absorbed = new Set<number>();
  const sources = new Map<number, CallSource>();
  for (const event of events) {
    if (event.kind !== "tool_use") continue;
    const use = toolUsePayload.safeParse(event.payload);
    if (!use.success) continue; // no id to join on — it stays a plain block

    const result = results.get(use.data.toolCallId) ?? null;
    const parsedResult = result === null ? null : toolResultPayload.safeParse(result.payload);
    if (result !== null) absorbed.add(result.seq);

    sources.set(event.seq, { use: event, result, root });
    // The same two events and the same root: nothing about this call can have changed, whatever
    // else the page has grown. Events are never rewritten in place, so identity is the whole test.
    const held = opts.previous?.sources.get(event.seq);
    if (held !== undefined && held.use === event && held.result === result && held.root === root) {
      const before = opts.previous?.calls.get(event.seq);
      if (before !== undefined) {
        calls.set(event.seq, before);
        continue;
      }
    }

    calls.set(event.seq, {
      seq: event.seq,
      runId: event.runId,
      at: event.at,
      name: use.data.toolName,
      useText: event.text,
      resultText: result?.text ?? null,
      isError: parsedResult?.success === true && parsedResult.data.isError === true,
      done: result !== null,
      view: viewFor(
        use.data.toolName,
        use.data.args,
        // `done` and `arrived` are the same fact: the answer is here, whatever it turned out to say.
        parsedResult?.success === true
          ? {
            arrived: true,
            value: parsedResult.data.result,
            truncated: (result?.payload as { truncated?: unknown } | null)?.truncated === true,
          }
          : { arrived: result !== null, value: undefined },
        root,
      ),
      // A result truncated for size has no `result`; its payload still names its images.
      images: parsedResult?.success === true
        ? imagesOf(parsedResult.data.result ?? result?.payload)
        : NO_IMAGES,
    });
  }
  return { calls, absorbed, orphanResults, sources };
}
