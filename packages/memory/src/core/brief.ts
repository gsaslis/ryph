// The brief: what a run is told at start, under a token budget, rendered as observations rather
// than instructions. Pure — the service fetches the candidates, this decides and renders.
//
// Composition, in order until the budget is spent: pinned memories, then everything else on the
// run's subjects — a turn per subject in rounds, each subject offering its next-best by score,
// so a repo with hundreds of memories cannot crowd a sibling repo or the org out of a checkout
// that holds several — then a topic index for what did not fit — one line per subject with
// counts by kind — so the agent knows what exists and searches for it instead of being handed
// all of it. What was admitted renders in score order whatever turn admitted it.

import { scoreMemory } from "./score.ts";
import { repoLabel, subjectKey } from "./subject.ts";
import type { Brief, Memory, MemoryKind } from "./types.ts";

/** A candidate for the brief: a live memory and how relevant the task text found it. */
export interface BriefCandidate {
  memory: Memory;
  /** In [0, 1]. */
  relevance: number;
}

export const BRIEF_HEADING = "## What previous runs learned";

const BRIEF_PREAMBLE = "These are observations recorded by earlier runs and by people. They " +
  "may be outdated; verify before relying on one, and use the memory tools to confirm or " +
  "correct it.";

const INDEX_HEADING = "### Also on record";

/** Four characters per token is the usual English estimate; the budget is a cap, not a meter. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "3d ago", "2mo ago", "today". */
export function relativeAge(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS);
  if (!Number.isFinite(days) || days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** One brief line: id, claim, and the trail in parentheses. */
export function renderLine(memory: Memory, now: Date): string {
  const trail: string[] = [memory.kind];
  if (memory.trust === "pinned" && memory.status !== "needs-verification") trail.push("pinned");
  else if (memory.trust === "human") trail.push("by a person");
  if (memory.confirmations > 0) trail.push(`confirmed ${memory.confirmations}×`);
  if (memory.refutations > 0) trail.push(`refuted ${memory.refutations}×`);
  trail.push(relativeAge(memory.lastConfirmedAt ?? memory.createdAt, now));
  return `- [${memory.id}] ${memory.text} (${trail.join(" · ")})`;
}

/** `repo github.com/x/y: 47 memories — gotcha 11 · fact 12 · …` */
export function renderIndexLine(subject: Memory["subject"], memories: Memory[]): string {
  const counts = new Map<MemoryKind, number>();
  for (const m of memories) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  const byKind = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${kind} ${n}`)
    .join(" · ");
  const label = subject.kind === "org" ? "org" : `repo ${repoLabel(subject.url)}`;
  const noun = memories.length === 1 ? "memory" : "memories";
  return `${label}: ${memories.length} ${noun} — ${byKind}`;
}

/**
 * Composes the brief. Null when there is nothing to say — the run then proceeds without a
 * memory section rather than with an empty one.
 */
export function composeBrief(
  candidates: BriefCandidate[],
  budgetTokens: number,
  now: Date,
): Brief | null {
  if (candidates.length === 0) return null;
  const ranked = candidates
    .filter((c) => c.memory.status === "canon")
    .map((c) => ({ ...c, score: scoreMemory(c.memory, now, c.relevance).total }))
    .sort((a, b) => {
      const pinA = a.memory.trust === "pinned" ? 1 : 0;
      const pinB = b.memory.trust === "pinned" ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;
      if (a.score !== b.score) return b.score - a.score;
      return a.memory.id.localeCompare(b.memory.id);
    });

  const head = `${BRIEF_HEADING}\n\n${BRIEF_PREAMBLE}\n`;
  let spent = estimateTokens(head);
  const included: Memory[] = [];
  const left: Memory[] = [];
  const admit = (memory: Memory) => {
    const cost = estimateTokens(renderLine(memory, now)) + 1;
    // Pinned memories ride regardless: a budget too small for what a human insisted on is the
    // budget's mistake, and the sort above put them first so they are also the cheapest to fit.
    if (spent + cost > budgetTokens && memory.trust !== "pinned") {
      left.push(memory);
      return;
    }
    spent += cost;
    included.push(memory);
  };
  for (const { memory } of ranked) if (memory.trust === "pinned") admit(memory);
  // The rest take turns by subject: one lane per subject, in the order their best candidate
  // ranks, each lane in score order; a round offers every lane its head.
  const lanes = new Map<string, Memory[]>();
  for (const { memory } of ranked) {
    if (memory.trust === "pinned") continue;
    const key = subjectKey(memory.subject);
    const lane = lanes.get(key);
    if (lane === undefined) lanes.set(key, [memory]);
    else lane.push(memory);
  }
  const queues = [...lanes.values()];
  while (queues.some((q) => q.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next !== undefined) admit(next);
    }
  }
  const rank = new Map(ranked.map((c, i) => [c.memory.id, i]));
  included.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const lines = included.map((m) => renderLine(m, now));

  const parts = [head, ...lines];
  if (left.length > 0) {
    const bySubject = new Map<string, { subject: Memory["subject"]; memories: Memory[] }>();
    for (const m of left) {
      const key = subjectKey(m.subject);
      const entry = bySubject.get(key) ?? { subject: m.subject, memories: [] };
      entry.memories.push(m);
      bySubject.set(key, entry);
    }
    parts.push("", INDEX_HEADING);
    for (const { subject, memories } of bySubject.values()) {
      parts.push(renderIndexLine(subject, memories));
    }
  }
  // Stale claims never displace canon (or its index), and pinning is no budget override.
  // Include the warning itself in the secondary section's quarter-budget allowance.
  const staleHead = "### Needs verification — not current canon\n\n" +
    "These observations may be outdated. If relevant to your task, use memory__get for their " +
    "evidence and check the current code before relying on them. Use memory__confirm if still true, " +
    "or memory__refute with a correction; exposure alone is not confirmation.";
  const staleBudget = Math.min(
    Math.floor(budgetTokens / 4),
    budgetTokens - estimateTokens(parts.join("\n")),
  );
  let staleSpent = estimateTokens(`\n\n${staleHead}\n`);
  const staleLines: string[] = [];
  const stale = candidates
    .filter((c) => c.memory.status === "needs-verification" && c.relevance > 0)
    .map((c) => ({
      ...c,
      // A stale pin is an observation to check, not an unconditional instruction.
      score: scoreMemory(
        c.memory.trust === "pinned" ? { ...c.memory, trust: "human" } : c.memory,
        now,
        c.relevance,
      ).total,
    }))
    .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id));
  for (const { memory } of stale) {
    const line = renderLine(memory, now);
    const cost = estimateTokens(`${line}\n`);
    if (staleSpent + cost > staleBudget) continue;
    staleSpent += cost;
    staleLines.push(line);
    included.push(memory);
  }
  if (staleLines.length > 0) parts.push("", staleHead, ...staleLines);
  if (included.length === 0 && left.length === 0) return null;
  return {
    text: parts.join("\n"),
    memoryIds: included.map((m) => m.id),
    // Evidence is a commit in a repo, so only a repo claim's is checkable; the URL is the
    // canonical one here, and the service restates it in the caller's spelling.
    evidence: included.flatMap((m) =>
      m.evidence === null || m.subject.kind !== "repo" ? [] : [{
        memoryId: m.id,
        repo: m.subject.url,
        sha: m.evidence.sha,
        paths: m.evidence.paths,
      }]
    ),
  };
}
