// The report: the written account a run's work carries wherever it lands — a PR body today,
// a PR/issue comment when inbound triggers ship. ONE composed artifact, several delivery
// targets; never three features.
//
// The provenance (the header's "requested by") is NOT a courtesy. The threat model's residual risk is a human
// rubber-stamping a PR whose instructions someone else wrote, and this block is the only
// control standing there. Hence the two invariants below.
//
// Invariants:
// - pure: Result fields + task origin in, markdown out — unit-testable with no forge at all,
//   and the same function serves every phase's delivery target
// - the provenance CANNOT be suppressed: it is composed unconditionally, from inputs
//   the caller must supply — there is no path that renders a report without it

import type { CommitInfo, ForgeWriteTool, Phase, RunState } from "./types.ts";
import { TERMINAL_STATES } from "./types.ts";
import { DEFAULT_LINE } from "@ryph/shared/lines";

export interface ReportProvenance {
  /** How the task came to exist. */
  origin: "user" | "break-glass" | "forge" | "automation" | "chat" | "token";
  /** The requester's linked GitHub login, when known. Written as an @-mention. */
  requestedByLogin: string | null;
  /**
   * The requester's ryph name, already sanitized to plain text, where a login would name the
   * wrong person: in GitHub's user mode every user acts as the token's owner, and "requested by
   * @owner" on a run someone else asked for misattributes it (and pings the owner). Used only
   * when `requestedByLogin` is null; written without an @, so it mentions nobody.
   */
  requestedByName?: string | null;
  /** A chat task's commander, by sanitized display name; null for every other origin. */
  requestedVia: string | null;
}

/** One repo's delta, as the run reported it: the checkout path and its commits, oldest first. */
export interface ReportedBranch {
  path: string;
  /** The line of the run's work the branch ships; absent reads as the default line. */
  line?: string;
  commits: CommitInfo[];
}

export interface ReportInput {
  runId: string;
  agentName: string;
  /** Browser-facing task link; omitted when the app URL is not configured. */
  runUrl?: string | null;
  /** A patch's description, placed after the attribution and before the report. */
  description?: string | null;
  /** The agent's own account of the run — Result.summary, already reported by the runner. */
  summary: string;
  /**
   * True when the agent already posted what it did in the thread this report lands in: the
   * summary is left out and one line says where to look. Only a thread's status comment sets it
   * — a pull request body always carries the summary.
   *
   * The agent's word is not enough, and the caller must not pass its claim through: it says
   * "look in the thread", and if nothing was written there the run's account of itself is simply
   * gone from the one place a maintainer reads. The caller CHECKS the claim against the run's
   * tool ledger (a settled comment or review on this thread) before setting it.
   */
  summaryInThread?: boolean;
  /**
   * The run's delta, as far as THIS delivery target may show it. With several, each is listed
   * under its repo so a reader sees the whole change and knows the parts land independently.
   */
  branches: ReportedBranch[];
  /** True for a success that shipped no branch: the agent declared the task needed no changes. */
  noChanges: boolean;
  /**
   * How many parts of the change live in OTHER repositories, which this report must not
   * describe. A pull request body and a progress comment are read in one repository, which may
   * be public, while a sibling of the workspace may be private: the report says the other parts
   * exist and never what or where they are. Absent or zero: the report is the whole change.
   */
  otherParts?: number;
  /**
   * Forge capabilities this run spent to the last one. Said in the report because the caps are
   * per RUN while a thread's conversation is now one run: the fourth thing a maintainer asks
   * meets a budget the first three spent, and without this the model reads `over_cap` while the
   * thread simply shows an agent that stopped doing something, with nothing saying why.
   */
  spentCaps?: Array<{ tool: ForgeWriteTool; max: number }>;
  provenance: ReportProvenance;
}

/** A write capability as a maintainer would name it, for the line that says a budget is gone. */
const CAP_NOUNS: Record<ForgeWriteTool, string> = {
  create_issue: "issues it may open",
  add_comment: "comments it may post",
  add_labels: "labellings it may make",
  submit_review: "reviews it may post",
  close_issue: "issue closes it may make",
};

/** The report as markdown — a PR body, verbatim. */
export function composeReport(input: ReportInput): string {
  const agentName = input.agentName.replace(/[\\`*_[\]<>|~#]/g, (c) => `\\${c}`)
    .replace(/[\r\n]+/g, " ");
  const link = input.runUrl ? ` · [Run](${encodeURI(input.runUrl)})` : "";
  // Provenance is the header's last item, not a footer: ahead of the description and summary,
  // nothing they contain (an unclosed `<!--`, `<details>` or fence) can hide it.
  const sections: string[] = [
    `<sub>Proposed by **${agentName}**, a Ryph agent${link} · ${provenance(input)}</sub>`,
  ];
  if (input.description?.trim()) sections.push(input.description.trim());

  if (input.summaryInThread === true) {
    sections.push(`_**${input.agentName}** posted what it did in this thread._`);
  } else if (input.summary.trim() !== "") {
    sections.push(input.summary.trim());
  }

  const shipped = input.branches.filter((b) => b.commits.length > 0);
  if (shipped.length === 1) {
    sections.push(
      [
        "### Commits",
        ...shipped[0].commits.map((c) => `- \`${c.sha.slice(0, 10)}\` ${c.subject}`),
      ].join("\n"),
    );
  } else if (shipped.length > 1) {
    // A part is named by its directory, and by its line too wherever that tells it apart: a line
    // other than the default, or a directory that shipped more than one.
    const linesAt = new Map<string, number>();
    for (const b of shipped) linesAt.set(b.path, (linesAt.get(b.path) ?? 0) + 1);
    const label = (b: ReportedBranch) => {
      const line = b.line ?? DEFAULT_LINE;
      return line !== DEFAULT_LINE || (linesAt.get(b.path) ?? 0) > 1
        ? `\`${b.path}/\` on line \`${line}\``
        : `\`${b.path}/\``;
    };
    const spans = linesAt.size > 1
      ? "This change spans several repositories"
      : "This run shipped several unrelated changes";
    sections.push(
      shipped.map((b) =>
        [
          `### Commits in ${label(b)}`,
          ...b.commits.map((c) => `- \`${c.sha.slice(0, 10)}\` ${c.subject}`),
        ].join("\n")
      ).join("\n\n") +
        `\n\n_${spans}; each part is a pull request of its own and they land independently._`,
    );
  } else if (input.noChanges) {
    sections.push("_No code changes were needed._");
  }

  const others = input.otherParts ?? 0;
  if (others > 0) {
    sections.push(
      `> **Part of a set.** This run also changed ${others} other ` +
        `${others === 1 ? "repository" : "repositories"} — each part is a pull request of its ` +
        "own, in its own repository, and they land independently. The whole set is listed on " +
        "the run's task in ryph.",
    );
  }

  const spent = input.spentCaps ?? [];
  if (spent.length > 0) {
    const named = spent.map((cap) => `all ${cap.max} ${CAP_NOUNS[cap.tool]}`);
    const list = named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
    sections.push(
      `> **Budget spent.** This run used ${list}; anything it tried after that was refused. ` +
        "Those limits are per run, and a follow-up command in this thread joins the run already " +
        "working it — so more of that needs a new run.",
    );
  }

  return sections.join("\n\n");
}

export interface ProgressCommentInput {
  runId: string;
  taskId: string;
  agentName: string;
  state: RunState;
  phase: Phase | null;
  /** The web app's browser-facing origin (RYPH_APP_URL). Null: the link line is omitted. */
  appUrl: string | null;
  /** The composed final report — present exactly when the run is terminal. */
  report: string | null;
}

const STATE_BADGES: Record<RunState, string> = {
  starting: "🚀",
  running: "⚙️",
  succeeded: "✅",
  failed: "❌",
  errored: "💥",
  cancelled: "🛑",
  lost: "❓",
};

/**
 * The progress comment a forge-triggered run keeps as its face in the thread — ONE comment,
 * edited through the run's life, terminal report embedded at the end. Pure, like the report:
 * the sweep supplies rows, this supplies markdown, and both are testable with no forge.
 */
export function composeProgressComment(input: ProgressCommentInput): string {
  const badge = STATE_BADGES[input.state];
  const phase = input.phase === null || TERMINAL_STATES.has(input.state) ? "" : ` (${input.phase})`;
  const verb = TERMINAL_STATES.has(input.state) ? "finished" : "is working on this";
  const sections: string[] = [
    `${badge} **${input.agentName}** ${verb} — ryph run \`${input.runId}\` is ` +
    `**${input.state}**${phase}.`,
  ];
  if (input.report !== null) sections.push(input.report);
  if (input.appUrl !== null) {
    sections.push(`[View the run](${input.appUrl}/tasks/${input.taskId})`);
  }
  if (!TERMINAL_STATES.has(input.state)) {
    sections.push("_This comment updates as the run progresses._");
  }
  return sections.join("\n\n");
}

// The one lever against rubber-stamping: who asked, stated where it cannot be missed — the
// report's first line. Break-glass is a positive statement, never an omission.
function provenance(input: ReportInput): string {
  const login = input.provenance.requestedByLogin;
  const name = input.provenance.requestedByName ?? null;
  /** The requester as this block writes them: a login, else a ryph name, else nobody. A name
   * is anyone's to choose and `chatDisplayName` keeps `www.evil.example` (letters and dots), which
   * GitHub autolinks in bold text — so a name is a code span, where nothing is linked. */
  const person = login !== null ? `**@${login}**` : name !== null ? `ryph user \`${name}\`` : null;
  const who = input.provenance.origin === "break-glass"
    ? "**break-glass API access** (no user identity — this bypassed the normal permission gate)"
    : input.provenance.origin === "forge"
    // The command channel names itself: the instructions came from a thread anyone with
    // write access could have posted in, and the reader deserves to know that.
    ? person !== null
      ? `${person} via a /ryph command`
      : "a /ryph command (requester's login no longer resolves)"
    // An automation names itself too: the run fired without a human at the keyboard, with a
    // machine-written payload in its context, and the reader deserves to know that.
    : input.provenance.origin === "automation"
    ? person !== null
      ? `${person}'s automation`
      : "an automation (owner's login no longer resolves)"
    // A chat mention the same way: the ask came from a chat identity nobody linked, on a room
    // whose owner the run acts for — the reader should know both halves.
    : input.provenance.origin === "chat"
    ? `${
      input.provenance.requestedVia !== null
        ? `\`${input.provenance.requestedVia}\`'s mention`
        : "a mention"
    } in ${
      person !== null
        ? `${person}'s command room`
        : "a command room (owner's login no longer resolves)"
    }`
    // A script or an agent holding the user's API token: it acted for them, and the reader
    // deserves to know no person typed the instructions.
    : input.provenance.origin === "token"
    ? person !== null ? `${person}'s API token` : "an API token (owner's login no longer resolves)"
    : person !== null
    ? person
    : "a ryph user with no linked GitHub account";
  return `requested by ${who}`;
}
