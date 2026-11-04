// The six tools a run holds, as an MCP server would list and call them.
// Names are bare (`search`, `propose`); the pi extension prefixes them with the platform
// server's slug, so the agent sees `memory__search`. Every call takes the RunScope the data
// route derived from the gateway's run id; nothing in the arguments widens it.
//
// Results are compact text: one line per memory on a search, a handful of labelled lines on a
// get, a sentence on a write. Citing an id costs a few tokens; the full record is a separate
// call so listing stays cheap.

import type { z } from "@zod/zod";
import { describeIssues } from "@ryph/shared/http";
import { relativeAge } from "../core/brief.ts";
import { scoreMemory } from "../core/score.ts";
import type { MemoryDetail, MemoryService } from "../core/service.ts";
import { MemoryRefusedError } from "../core/service.ts";
import type { RunScope } from "../core/subject.ts";
import { repoLabel, resolveSubjectHint } from "../core/subject.ts";
import type { Memory } from "../core/types.ts";
import {
  ConfirmArgsSchema,
  DocArgsSchema,
  GetArgsSchema,
  jsonSchemaOf,
  ProposeArgsSchema,
  RefuteArgsSchema,
  SearchArgsSchema,
} from "../schema.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** An MCP `tools/call` result: text content, and whether it is an error the model should read. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const failure = (t: string): ToolResult => ({
  content: [{ type: "text", text: t }],
  isError: true,
});

export const TOOLS: ToolDefinition[] = [
  {
    name: "search",
    description: "Search what previous runs and people recorded about this repository and " +
      "the org. Returns compact lines with ids; use `get` for a full record. Memories may " +
      "be outdated — verify before relying on one, then `confirm` or `refute` it.",
    inputSchema: jsonSchemaOf(SearchArgsSchema),
  },
  {
    name: "get",
    description: "The full record of one memory: where it came from, what it is evidence " +
      "for, what replaced it, and how it has been confirmed or refuted.",
    inputSchema: jsonSchemaOf(GetArgsSchema),
  },
  {
    name: "doc",
    description: "Read the document behind a pointer memory: a runbook, an onboarding guide, " +
      "an architecture page a person handed to memory. Whole when it fits, else its section " +
      "index and head — ask again with a section title for the rest.",
    inputSchema: jsonSchemaOf(DocArgsSchema),
  },
  {
    name: "propose",
    description: "Record one durable claim for future runs: a fact about the repo, a " +
      "procedure that worked, a gotcha that cost time, a decision and its reason. Say whether " +
      "you observed it or your own change introduces it. It lands in an inbox and is reviewed " +
      "before it reaches anyone. Never include credentials.",
    inputSchema: jsonSchemaOf(ProposeArgsSchema),
  },
  {
    name: "confirm",
    description: "Say that you relied on a memory and it held. One call, one id.",
    inputSchema: jsonSchemaOf(ConfirmArgsSchema),
  },
  {
    name: "refute",
    description: "Say that a memory was wrong, why, and — strongly preferred — what is true " +
      "instead. The replacement becomes a proposal that supersedes the old memory.",
    inputSchema: jsonSchemaOf(RefuteArgsSchema),
  },
];

/** `[mem-k3f9] text (kind · score 0.82 · confirmed 3× · 12d ago)` */
export function renderSearchLine(memory: Memory, relevance: number, now: Date): string {
  const score = scoreMemory(memory, now, relevance);
  const trail: string[] = [memory.kind];
  if (memory.trust === "pinned") trail.push("pinned");
  trail.push(
    Number.isFinite(score.total) ? `score ${score.total.toFixed(2)}` : "score ∞",
  );
  if (memory.confirmations > 0) trail.push(`confirmed ${memory.confirmations}×`);
  if (memory.refutations > 0) trail.push(`refuted ${memory.refutations}×`);
  if (memory.status === "needs-verification") trail.push("may be outdated");
  trail.push(relativeAge(memory.lastConfirmedAt ?? memory.createdAt, now));
  return `[${memory.id}] ${memory.text} (${trail.join(" · ")})`;
}

export function renderDetail(detail: MemoryDetail, now: Date): string {
  const { memory } = detail;
  const score = scoreMemory(memory, now);
  const lines = [
    `id: ${memory.id}`,
    `text: ${memory.text}`,
    `kind: ${memory.kind}`,
    // Named as a run may read it: a `local` repository by its folder, never its path on the host.
    `subject: ${memory.subject.kind === "org" ? "org" : `repo ${repoLabel(memory.subject.url)}`}`,
    `audience: ${memory.audience.kind === "all" ? "every agent" : "you"}`,
    `status: ${memory.status}`,
    `trust: ${memory.trust}`,
    `score: ${Number.isFinite(score.total) ? score.total.toFixed(2) : "∞"} ` +
    `(votes ${score.votes.toFixed(2)} · decay ${score.decay.toFixed(2)} · age ${
      Math.round(score.ageDays)
    }d)`,
    `confirmed: ${memory.confirmations}× · refuted: ${memory.refutations}× · briefed into ${memory.briefedCount} runs`,
    `provenance: ${
      memory.provenance.kind === "run"
        ? `run ${memory.provenance.runId}`
        : memory.provenance.kind === "source"
        ? `document ${memory.provenance.sourceId}${
          memory.provenance.section ? ` § ${memory.provenance.section}` : ""
        }`
        : "written by a person"
    }`,
  ];
  if (memory.evidence !== null) {
    lines.push(`evidence: ${memory.evidence.sha} — ${memory.evidence.paths.join(", ")}`);
  }
  if (detail.supersedes !== null) {
    lines.push(`replaced: [${detail.supersedes.id}] ${detail.supersedes.text}`);
  }
  if (detail.supersededBy !== null) {
    lines.push(`replaced by: [${detail.supersededBy.id}] ${detail.supersededBy.text}`);
  }
  const refutes = detail.feedback.filter((f) => f.kind === "refute").slice(0, 3);
  for (const f of refutes) {
    if (f.kind === "refute") lines.push(`refuted (${relativeAge(f.at, now)}): ${f.reason}`);
  }
  return lines.join("\n");
}

function parse<T>(
  schema: z.ZodType<T, unknown>,
  args: unknown,
): { ok: true; data: T } | { ok: false; result: ToolResult } {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, result: failure(`invalid arguments: ${describeIssues(parsed.error)}`) };
}

export interface ToolCallContext {
  service: MemoryService;
  scope: RunScope;
  runId: string;
  now(): Date;
}

/** Null: no such tool — the caller answers JSON-RPC's method-not-found. */
export async function callTool(
  ctx: ToolCallContext,
  name: string,
  args: unknown,
): Promise<ToolResult | null> {
  const { service, scope, runId } = ctx;
  try {
    switch (name) {
      case "search": {
        const p = parse(SearchArgsSchema, args);
        if (!p.ok) return p.result;
        // A repo the run does not hold is refused with the reason, never answered with an
        // empty result the agent would read as "nothing recorded".
        if (p.data.repo !== undefined && p.data.repo.trim() !== "") {
          const resolved = resolveSubjectHint(scope, "repo", p.data.repo);
          if (resolved.kind === "none") return failure(resolved.reason);
        }
        const hits = await service.search(scope, p.data);
        if (hits.length === 0) return text("No memories match. Nothing is recorded on this yet.");
        return text(
          hits.map((h) => renderSearchLine(h.memory, h.relevance, ctx.now())).join("\n"),
        );
      }
      case "get": {
        const p = parse(GetArgsSchema, args);
        if (!p.ok) return p.result;
        const detail = await service.getInScope(scope, p.data.id);
        if (detail === null) return failure(`No memory ${p.data.id} is visible to this run.`);
        return text(renderDetail(detail, ctx.now()));
      }
      case "doc": {
        const p = parse(DocArgsSchema, args);
        if (!p.ok) return p.result;
        const doc = await service.docInScope(scope, p.data.id, p.data.section);
        if (doc === null) {
          return failure(
            p.data.section === undefined
              ? `No document ${p.data.id} is visible to this run.`
              : `No section "${p.data.section}" in document ${p.data.id}.`,
          );
        }
        return text(doc);
      }
      case "propose": {
        const p = parse(ProposeArgsSchema, args);
        if (!p.ok) return p.result;
        const outcome = await service.propose(scope, runId, p.data);
        if (!outcome.ok) return failure(`Not recorded: ${outcome.reason}.`);
        const flagged = outcome.proposal.flags.length > 0
          ? ` It was flagged (${outcome.proposal.flags.join(", ")}) and will wait for a person.`
          : "";
        const introduced = outcome.proposal.basis === "introduced"
          ? " It waits until your change lands, and is dropped if the change is."
          : "";
        return text(`Recorded as proposal ${outcome.proposal.id}.${flagged}${introduced}`);
      }
      case "confirm": {
        const p = parse(ConfirmArgsSchema, args);
        if (!p.ok) return p.result;
        const memory = await service.confirm(scope, runId, p.data.id);
        if (memory === null) return failure(`No memory ${p.data.id} is visible to this run.`);
        return text(`Confirmed ${memory.id} (now ${memory.confirmations}×).`);
      }
      case "refute": {
        const p = parse(RefuteArgsSchema, args);
        if (!p.ok) return p.result;
        const outcome = await service.refute(
          scope,
          runId,
          p.data.id,
          p.data.reason,
          p.data.replacement,
          p.data.basis,
        );
        if (outcome === null) return failure(`No memory ${p.data.id} is visible to this run.`);
        const status = outcome.memory.status === "retired"
          ? "It is retired."
          : outcome.memory.status === "needs-verification"
          ? "It is marked as needing verification."
          : "";
        const replacement = outcome.replacement === null
          ? ""
          : ` Your replacement is proposal ${outcome.replacement.id}.`;
        return text(`Refuted ${outcome.memory.id}. ${status}${replacement}`.trim());
      }
      default:
        return null;
    }
  } catch (err) {
    if (err instanceof MemoryRefusedError) return failure(`Not recorded: ${err.message}.`);
    throw err;
  }
}
