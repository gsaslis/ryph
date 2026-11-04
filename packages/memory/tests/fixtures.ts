// Shared fixtures: a memory row, a proposal, a clock and a counting id minter.

import type { Memory, Proposal, Source } from "../src/core/types.ts";

export const T0 = "2026-09-01T00:00:00.000Z";

export function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    tenantId: "default",
    text: "App tests are vitest, wired in via package.json scripts.test",
    kind: "procedure",
    subject: { kind: "repo", url: "github.com/acme/app" },
    audience: { kind: "all" },
    status: "canon",
    trust: "agent",
    provenance: { kind: "run", runId: "r-0", taskId: "t-0", proposalId: "prop-0" },
    evidence: null,
    supersedes: null,
    supersededBy: null,
    confirmations: 0,
    refutations: 0,
    briefedCount: 0,
    briefedSuccesses: 0,
    lastBriefedAt: null,
    lastConfirmedAt: null,
    lastRefutedAt: null,
    embedding: null,
    embeddingModel: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "prop-1",
    tenantId: "default",
    text: "The dockerignore is an allowlist; a new dir a Dockerfile copies must be re-included",
    kind: "gotcha",
    subject: { kind: "repo", url: "github.com/acme/app" },
    audience: { kind: "all" },
    evidence: null,
    origin: { kind: "run", runId: "r-1", taskId: "t-1" },
    supersedes: null,
    basis: "observed",
    changeId: null,
    status: "pending",
    resolution: null,
    flags: [],
    createdAt: T0,
    ...overrides,
  };
}

/** Ids that read in tests: `mem-1`, `mem-2`, `prop-1`… */
export function countingMinter(): (prefix: string) => string {
  const counts = new Map<string, number>();
  return (prefix) => {
    const n = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, n);
    return `${prefix}-${n}`;
  };
}

export function fakeClock(startIso = T0) {
  let nowMs = Date.parse(startIso);
  return {
    now: () => new Date(nowMs),
    advanceDays: (days: number) => {
      nowMs += days * 24 * 60 * 60 * 1000;
    },
  };
}

/** A stable, cheap stand-in for SHA-256: the text's length and a checksum, hex. */
export function fakeHash(text: string): Promise<string> {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum = (sum * 31 + text.charCodeAt(i)) >>> 0;
  return Promise.resolve(`${text.length.toString(16)}-${sum.toString(16)}`);
}

/**
 * A deterministic stand-in embedder: a text's vector is its bag of lowercase terms hashed into
 * a few buckets, unit-normalised — so texts sharing words are close and unrelated ones are
 * not, which is all hybrid search needs to be tested against.
 */
export function fakeEmbedder(model = "fake-embed") {
  const calls: string[][] = [];
  const dims = 32;
  const embedOne = (text: string): number[] => {
    const v = new Array(dims).fill(0);
    for (const term of text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) {
      let h = 0;
      for (let i = 0; i < term.length; i++) h = (h * 31 + term.charCodeAt(i)) >>> 0;
      v[h % dims] += 1;
    }
    const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0)) || 1;
    return v.map((x: number) => x / norm);
  };
  return {
    model,
    calls,
    embed(texts: string[]) {
      calls.push(texts);
      return Promise.resolve(texts.map(embedOne));
    },
  };
}

export function source(overrides: Partial<Source> = {}): Source {
  return {
    id: "src-1",
    tenantId: "default",
    kind: "paste",
    status: "ready",
    extraction: null,
    failure: null,
    title: "Guide",
    locator: null,
    contentHash: "h1",
    text: "# Guide\n\nHello.",
    defaultSubject: { kind: "org" },
    ingestedBy: "u-1",
    ingestedAt: "2026-09-01T00:00:00.000Z",
    supersedesSourceId: null,
    ...overrides,
  };
}
