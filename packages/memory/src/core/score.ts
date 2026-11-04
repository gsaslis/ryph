// The score that ranks a memory for the brief and for search — legible enough to show in the
// UI as a breakdown, because every term is a column:
//
//   score = trust × clamp(1 + confirmations + ¼·briefedSuccesses − 2·refutations, 0, 5)
//                 × exp(−ageDays / τ[kind]) × relevance
//
// Age counts from the last confirmation, not creation, so a memory in steady use never decays.
// Pinned reads as infinite trust. Brief composition applies that override only to current
// canon; stale observations are ranked there with finite trust and no budget exemption.
// This is a starting point, not a commitment.

import type { Memory, MemoryKind, Trust } from "./types.ts";

export const TRUST_WEIGHT: Record<Trust, number> = {
  pinned: Number.POSITIVE_INFINITY,
  human: 1.5,
  ingested: 1.2,
  agent: 1.0,
};

/** Decay half-scale in days, per kind. Infinity never decays. */
export const DECAY_DAYS: Record<MemoryKind, number> = {
  preference: Number.POSITIVE_INFINITY,
  decision: 365,
  pointer: 365,
  gotcha: 180,
  fact: 90,
  procedure: 60,
};

/** How much one "briefed into a run that succeeded" counts against one explicit confirmation. */
export const IMPLICIT_CONFIRMATION_WEIGHT = 0.25;

export interface ScoreBreakdown {
  trust: number;
  votes: number;
  decay: number;
  relevance: number;
  ageDays: number;
  total: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function ageDaysOf(
  memory: Pick<Memory, "lastConfirmedAt" | "createdAt">,
  now: Date,
): number {
  const since = Date.parse(memory.lastConfirmedAt ?? memory.createdAt);
  if (!Number.isFinite(since)) return 0;
  return Math.max(0, (now.getTime() - since) / DAY_MS);
}

export function votesOf(
  memory: Pick<Memory, "confirmations" | "refutations" | "briefedSuccesses">,
): number {
  const raw = 1 + memory.confirmations + IMPLICIT_CONFIRMATION_WEIGHT * memory.briefedSuccesses -
    2 * memory.refutations;
  return Math.min(5, Math.max(0, raw));
}

export function decayOf(kind: MemoryKind, ageDays: number): number {
  const tau = DECAY_DAYS[kind];
  return Number.isFinite(tau) ? Math.exp(-ageDays / tau) : 1;
}

/** `relevance` in [0, 1]; the caller normalises its search score. Defaults to 1 (no query). */
export function scoreMemory(memory: Memory, now: Date, relevance = 1): ScoreBreakdown {
  const trust = TRUST_WEIGHT[memory.trust];
  const votes = votesOf(memory);
  const ageDays = ageDaysOf(memory, now);
  const decay = decayOf(memory.kind, ageDays);
  const rel = Math.min(1, Math.max(0, relevance));
  const total = Number.isFinite(trust) ? trust * votes * decay * rel : Number.POSITIVE_INFINITY;
  return { trust, votes, decay, relevance: rel, ageDays, total };
}

/**
 * Below this much decay a memory is a candidate for the sweep: three horizons old (e^-3), and
 * not briefed within one horizon. Pinned memories and never-decaying kinds are exempt by
 * construction — their decay is 1.
 */
export const SWEEP_DECAY_BELOW = Math.exp(-3);

/** Whether the sweep retires this memory now: decayed past the threshold, and unused for a
 * horizon — not briefed (or, never briefed, not created) within τ[kind] days. */
export function isSweepable(memory: Memory, now: Date): boolean {
  if (memory.trust === "pinned" || memory.status === "retired") return false;
  const tau = DECAY_DAYS[memory.kind];
  if (!Number.isFinite(tau)) return false;
  if (decayOf(memory.kind, ageDaysOf(memory, now)) >= SWEEP_DECAY_BELOW) return false;
  const lastUse = Date.parse(memory.lastBriefedAt ?? memory.createdAt);
  return Number.isFinite(lastUse) && (now.getTime() - lastUse) / DAY_MS > tau;
}
