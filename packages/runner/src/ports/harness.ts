import type {
  AgentIdentity,
  AttachmentRef,
  ChatContext,
  ChecksDeclaration,
  RepoEntry,
  SkillOrigin,
  TaskSpec,
  TranscriptChunk,
} from "../core/types.ts";
import type { Diagnostics } from "./diagnostics.ts";
import type { UnkeptReason } from "../core/image_refs.ts";

/**
 * The extension point: the pluggable coding-agent CLI the runner drives.
 * Adapters translate this generic contract into whatever the CLI understands,
 * and normalize its output into `TranscriptChunk`s (keeping the raw payload for lossless archival).
 *
 * Invariants:
 * - the harness works ONLY inside checkoutDir — the root that holds one clone per repo — and
 *   never touches git remotes (the core pushes, per clone)
 * - it MAY commit locally (some CLIs do); the core commits any leftovers at finalize
 * - on signal abort, stop as soon as coherent and return { interrupted: true }
 * - it throws only for mechanical breakage (a crash, unusable output);
 *   "the agent gave up" is a normal `HarnessOutcome` —
 *   a throw reports as the run's error, never the agent's failure
 * - it sends the task as one prompt and keeps driving turns — every message a steer while the
 *   agent works, a new turn once it has settled — until `done` fires and the agent is settled
 *   (see HarnessConversation)
 */
export interface Harness {
  run(input: HarnessInput, io: HarnessIo): Promise<HarnessOutcome>;
}

export interface HarnessInput {
  spec: TaskSpec;
  /** Who the agent is, as the work item names it — what an adapter tells the agent it is. */
  agent: AgentIdentity;
  /** The chat the run is bound to, when it is: an adapter tells the agent where "the chat" is
   * and how people in it reach it. */
  chat?: ChatContext;
  systemPrompt?: string;
  /**
   * The checkout, described: which repositories the root holds, where each lives, what it is,
   * and each one's context file — rendered by the core (helpers/layout.ts) and framed as the
   * platform's, so no file in any clone can suppress or rewrite it. Always present: the agent
   * starts at the root, not inside a repo, and cannot see the layout otherwise.
   */
  layout: string;
  /**
   * The machine, described: the environment image the run landed on when the platform resolved
   * one, the everyday tools the runner found on `PATH`, the toolchains the image's build
   * recorded, and the standing facts of a run (who may speak to it, no container runtime,
   * egress by policy, verify with the repository's own checks) — rendered by the core
   * (helpers/machine.ts). Always present, and always the platform's: it says only what the
   * runner established here, and a repo's prose comes after it, never instead of it.
   */
  machine: string;
  /** The repo's own description of the environment set up for the run
   * (its config dir's environment.md), injected so the agent knows what was prepared for it. */
  environment?: string;
  /** What previous runs learned, already rendered by the orchestrator; null when there is
   * nothing to say. An adapter puts it in front of the agent where a task's notes belong. */
  brief: string | null;
  /** The checkout root: the directory holding one clone per entry of `repos`, where the
   * harness runs. */
  checkoutDir: string;
  /** The repos under `checkoutDir`, in checkout order — for a harness that needs to address one
   * (the echo harness writes into the first); the prose form is `layout`. */
  repos: RepoEntry[];
  /**
   * The run's declared service containers, by the hostname they answer on — what an adapter
   * must keep off the egress proxy when it spawns (`runChildEnv`). Empty on a run that
   * declared none, which is most of them.
   */
  serviceHosts: string[];
  /** The MCP servers this run may call, when the agent has a tool policy; absent otherwise.
   * An adapter translates it into its CLI's own MCP config (pi: an `mcp.json` plus one
   * extension); a harness without an MCP client ignores it. */
  tools?: HarnessTools;
  /**
   * Whether the platform runs the repositories' declared checks for this run — what
   * `run_checks` reaches. An adapter tells the agent about them only then. Absent: no checks.
   */
  checksEnabled?: boolean;
  /** Whether the run may open patches: an adapter tells the agent about its patch tools only
   * then, and otherwise that its work leaves the run only as what it says. Absent: it may. */
  canOpenPatches?: boolean;
  /** Whether the run may publish artifacts: an adapter tells the agent about
   * `publish_artifact` only then. Absent: it may not. */
  canPublishArtifacts?: boolean;
  /** Whether nobody follows the run while it works: an adapter tells the agent to finish once
   * its work is submitted rather than wait for review. Absent: someone may. */
  unattended?: boolean;
  /** Whether a person started the run on its page and talks to it there: an adapter tells the
   * agent that answering is not finishing. Absent: no. */
  interactive?: boolean;
  /**
   * What each repo's checks run, read at the run's start, and which repos' checks files could
   * not be read: an adapter tells the agent about checks only where a repo declares some or
   * might. `declared` holds only repos with checks, so both lists empty means none has any.
   * Null or absent when nothing could be read, which an adapter says as little about as it
   * can, as it does for each unread repo.
   */
  checksDeclared?: ChecksDeclaration | null;
  /**
   * The skills this run may load, resolved, deduplicated, capped and written to disk by the core
   * after setup, in a directory outside every clone. Every harness gets the same list; an adapter
   * maps it to its CLI (pi: one `--skill` per entry). Empty when the run has none.
   */
  skills: HarnessSkill[];
  /**
   * The images the task came with, already fetched and saved outside every clone, and the
   * platform's lines saying which `[image N]` of the instructions is which file (and which could
   * not be fetched). An adapter puts one of the two notes after the instructions and, when it
   * sends the images inline (pi: `images` on the task's prompt), says so with `attached`.
   * Absent: the task had none.
   */
  taskImages?: HarnessImages;
  /**
   * The run's browser, when the platform gave it one: `ready` with its tools in
   * `tools.browser`, or `failed` when it never came up — an adapter then says so in one line, so
   * an agent asked to check a page knows why it cannot. Absent: the run has no browser, and an
   * adapter says nothing about one.
   */
  browser?: "ready" | "failed";
}

/**
 * One image for the agent: the file the runner saved it to (outside every clone, so the agent
 * can open it again), its type, and its size. An adapter that sends it inline reads the file
 * then — most images of a run never go inline, so none is held in memory as base64 for nothing.
 * Untrusted, like the text it came with.
 */
export interface HarnessImage {
  path: string;
  mime: string;
  /** The file's size in bytes, before base64: what an adapter weighs before sending it inline. */
  bytes: number;
  /** Its width and height in pixels, read from the file's header (`imageDimensions`), or null
   * when the header could not be read. pi re-encodes an image larger than 2000 pixels on a side,
   * which can make it bigger than the file, so an adapter weighing it needs these too. */
  dimensions: { width: number; height: number } | null;
}

/**
 * The images of one message or of the task, and the platform's words about them — in the two
 * forms an adapter chooses between at the moment it sends, because only it knows whether its
 * CLI will take them inline then (pi resizes an image only on a prompt that starts a turn, and a
 * run's requests have a size the images must fit in). Both forms name every image by its path,
 * and any that could not be fetched as missing.
 */
export interface HarnessImages {
  /** The images that could be fetched, in order. Empty when none could. */
  images: HarnessImage[];
  /** Said when `images` ride inline with the text: they are attached, and also saved. */
  attached: string;
  /** Said when they do not: each is a file the agent opens with its read tool to see it. What a
   * harness that never sends images inline always says. */
  saved: string;
}

/** One message for the agent, already framed — and the images it carries, whose note the adapter
 * puts after the text in the form that matches how it sends them. */
export interface HarnessMessage {
  text: string;
  images?: HarnessImages;
}

/** One skill on disk, ready for a harness to point its CLI at: from ryph's catalogue, the org
 * skills repo, or a repository the run checked out (named by its checkout path). */
export type HarnessSkill = SkillOrigin & {
  name: string;
  description: string;
  /** The skill's materialized directory; `SKILL.md` is inside. Outside every clone. */
  dir: string;
};

/**
 * Tool access as the credentials fetch delivered it: the gateway endpoint per server, plus the
 * NAME of the private runtime credential holding the run's virtual token. The token itself
 * never rides this type — an adapter reads it from memory at spawn and hands it to its CLI
 * under the CLI-facing env name. No secret is exported into the runner's process environment.
 */
export interface HarnessTools {
  /** The gateway's servers; empty for a run with no tool policy. */
  servers: Array<{ slug: string; name: string; url: string }>;
  /** The runtime lookup name for the gateway's virtual token; read only when `servers` is not
   * empty. */
  tokenEnv: string;
  /**
   * The runner's own tool server on loopback — the run's `finish`, `submit_patch` and
   * `patches` tools — and the runtime lookup name for its per-run token. Present on every run
   * the composition root serves one for, whether or not the run has gateway tools.
   */
  loopback?: { url: string; tokenEnv: string };
  /**
   * The browser sidecar's tool server on loopback, and the runtime lookup name for the bearer
   * the runner configured it with (ports/browser.ts). Present only once the browser answered.
   */
  browser?: { url: string; tokenEnv: string };
}

export interface HarnessIo {
  /** Tripped by the core when the run must stop. */
  signal: AbortSignal;
  /**
   * Live narration; fire-and-forget, must never gate the work.
   *
   * Returns the history seq the chunk was recorded at, when the run keeps a history — a handle
   * an adapter can name later, for the one thing narration cannot express in the moment: that an
   * event ALREADY sent turned out to be significant. (The pi adapter marks the assistant message
   * a run's result was derived from, which it only learns at the settle.) Undefined when the run
   * narrates nowhere durable; an adapter must then simply not point back.
   */
  onTranscript(chunk: TranscriptChunk): number | undefined;
  /** The machinery's own log, for the adapter's mechanical story
   * (spawns, kill fallbacks, swallowed failures); total by contract, callable unwrapped. */
  diagnostics: Diagnostics;
  /**
   * Keeps an image one of the agent's tools returned as a run attachment, so the transcript can
   * name it by id (ports/attachments.ts `upload`). Absent on a run with no control plane. Null:
   * not kept, and the image is narrated without one. Never throws; the adapter bounds how long
   * it waits.
   */
  keepImage?(
    bytes: Uint8Array,
    imageRef: string,
    signal: AbortSignal,
  ): Promise<AttachmentRef | null>;
  /**
   * Each tool result's image uploads as the adapter queues them, settled once they are (kept or
   * not): what a write naming an image ref waits on before it is checked, since the agent sees
   * a tool's image before its upload is done. Absent with `keepImage`.
   */
  keepingImages?(settled: Promise<unknown>): void;
  /**
   * An image a tool returned that the adapter did NOT keep, by a ref the agent may have read for
   * it, and why: what a write naming that ref is refused with. Absent with `keepImage`.
   */
  unkeptImage?(imageRef: string, reason: UnkeptReason): void;
  /**
   * The environment the agent's own commands run in — what the adapter spawned its CLI with,
   * after the runner's scrub — called once, at spawn. A background command the agent starts is
   * given exactly this, so it has the agent's powers and no others.
   */
  onAgentEnv?(env: Readonly<Record<string, string>>): void;
  /** The conversation: every run has one. */
  conversation: HarnessConversation;
}

/**
 * How a harness is spoken to while it runs. It sends the prompt and keeps going: a message that
 * arrives while the agent is working is a STEER (delivered after the current tool call, before
 * the next model call), one that arrives after a settle is a new turn. The harness returns when
 * `done` is aborted and the agent is settled — if `done` fires mid-turn, it waits for the
 * settle. The outcome's summary is the last assistant text.
 */
export interface HarnessConversation {
  /** The messages for the agent, already framed, in order; the iterable ends when the run is
   * over. A message's images ride beside its text, with the note that names their paths; an
   * adapter whose CLI takes none puts the `saved` form of it after the text. */
  messages: AsyncIterable<HarnessMessage>;
  /** Aborted when the run is over — the agent called finish, a person finished the run from its
   * page, or the idle clock ran out. */
  done: AbortSignal;
  /** Every settle of the agent: it has nothing more to do until it is spoken to again. */
  onSettled(): void;
}

/**
 * The agent's self-reported outcome, judged against the deliverable the person asked for — never
 * the latest step or turn. "in-progress": required work or verification remains (checks, a
 * subagent, an answer it needs), so the run is not done; only `report_outcome` takes it.
 * "success": the deliverable is complete and verified. "no-changes": the request is answered or
 * done and needed no code changes. "failed": the agent concluded it cannot deliver.
 */
export type DeclaredOutcome = "in-progress" | TerminalOutcome;

/** The outcomes that say the work is over, one way or the other: what `finish` takes. */
export type TerminalOutcome = "success" | "no-changes" | "failed";

/** How much of the summary the run's status comment in its thread repeats: "minimal" when the
 * agent already said what it did in that thread (a review, a comment) and the comment only needs
 * to point at the run. The summary itself is kept whole either way. */
export type StatusCommentDetail = "full" | "minimal";

/** What the harness read off the agent. How the run went is the agent's to say through its
 * tools (`finish`, `report_outcome`), never the harness's to parse out of a message. */
export interface HarnessOutcome {
  /** The agent's last message: the run's summary unless the agent reported one. */
  summary: string;
  interrupted: boolean;
}
