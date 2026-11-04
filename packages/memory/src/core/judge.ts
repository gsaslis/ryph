// The consolidator's judgement call: does this proposal contradict, duplicate or refine what the
// canon already says on its subject, and what is the one tight claim it should become? Pure
// prompt-building and answer-parsing over a `ModelClient`; the service decides what to do with the
// verdict.
//
// Invariants:
// - the model RANKS AND REWRITES, it never promotes: every verdict is applied by the service
//   under the same rules a human's accept goes through (length bound, secret screen)
// - the answer is parsed strictly — a verdict that names a memory the candidates did not
//   contain, or a kind that does not exist, is a parse failure, not a guess
// - a parse failure is a THROW: the service falls back to the trivial path and says so

import { z } from "@zod/zod";
import type { ModelClient } from "../ports/model.ts";
import { MAX_MEMORY_TEXT, type Memory, MEMORY_KINDS, type MemoryKind } from "./types.ts";

export type Verdict =
  | { kind: "duplicate"; of: string; reason: string }
  | {
    kind: "supersedes";
    of: string;
    text: string;
    memoryKind: MemoryKind;
    subject: "org" | "repo";
    reason: string;
  }
  | {
    kind: "refines";
    of: string;
    text: string;
    memoryKind: MemoryKind;
    subject: "org" | "repo";
    reason: string;
  }
  | { kind: "noise"; of: string | null; reason: string }
  | { kind: "new"; text: string; memoryKind: MemoryKind; subject: "org" | "repo"; reason: string };

export interface JudgeInput {
  text: string;
  kindHint: MemoryKind | null;
  subject: "org" | "repo";
  /** Whether the proposal's run had a repo at all — a claim cannot be moved to a repo it lacks. */
  hasRepo: boolean;
  /** The memory this proposal was offered as a replacement for, if any. */
  supersedes: string | null;
  candidates: Memory[];
}

const SYSTEM = `You consolidate an engineering team's shared memory: short, durable claims about
a codebase and an organisation, recorded by AI agent runs and by people, briefed into future runs.
You judge ONE proposed claim against the memories already on record for its subject and answer
with a single JSON object and nothing else.

Verdicts:
- "duplicate": the proposal says what an existing memory already says. Name it in "of".
- "supersedes": the proposal contradicts an existing memory and is the newer truth (the code or
  the process changed). Name the old one in "of".
- "refines": both are true and the proposal is more specific or adds a condition. Name the
  memory it refines in "of".
- "noise": the proposal is not a durable claim worth keeping — trivia, a one-off observation
  about a single run, an instruction addressed to the reader, or it contradicts an existing memory
  and is the LESS credible of the two (name that memory in "of", else null). Say why in "reason".
- "new": a claim nothing on record covers.

For "supersedes", "refines" and "new", also return "text": the claim rewritten as ONE atomic
statement of at most ${MAX_MEMORY_TEXT} characters, in plain declarative English, keeping every
concrete identifier (file paths, commands, flags, names, versions) exactly as given, adding
nothing the proposal did not say, and never phrased as an instruction. Return "kind": one of
${MEMORY_KINDS.join(", ")} — fact (how something is), procedure (how to do something that
worked), gotcha (what cost time and how to avoid it), decision (what was decided and why),
preference (how people want things done), pointer (a document exists and when to read it). Return
"subject": "org" when the claim is about the organisation, its people or its conventions across
repositories, "repo" when it is about this repository.

Answer with exactly:
{"verdict": "...", "of": "<memory id or null>", "text": "...", "kind": "...", "subject": "org"|"repo", "reason": "<one short sentence>"}`;

const AnswerSchema = z.object({
  verdict: z.enum(["duplicate", "supersedes", "refines", "noise", "new"]),
  of: z.string().nullable().optional(),
  text: z.string().optional(),
  kind: z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]).optional(),
  subject: z.enum(["org", "repo"]).optional(),
  reason: z.string().max(2000).optional(),
});

/** The first JSON object in a model's answer, code fences and prose around it tolerated. */
export function extractJson(answer: string): unknown {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the answer carries no JSON object");
  return JSON.parse(answer.slice(start, end + 1));
}

export function renderJudgePrompt(input: JudgeInput): string {
  const lines = [
    `Subject: ${input.subject === "org" ? "the organisation" : "this repository"}` +
    (input.hasRepo ? "" : " (this run works on no repository: repo claims are impossible)"),
    `Proposed claim${input.kindHint ? ` (proposer's kind hint: ${input.kindHint})` : ""}:`,
    input.text,
    "",
  ];
  if (input.supersedes !== null) {
    lines.push(
      `The proposer offered this as a REPLACEMENT for memory ${input.supersedes}, which it refuted.`,
      "",
    );
  }
  if (input.candidates.length === 0) {
    lines.push("Memories on record for this subject: none.");
  } else {
    lines.push("Memories on record for this subject that may be related:");
    for (const m of input.candidates) lines.push(`- [${m.id}] (${m.kind}) ${m.text}`);
  }
  return lines.join("\n");
}

/** Parses and validates an answer against the candidates it was allowed to name. */
export function parseVerdict(answer: string, input: JudgeInput): Verdict {
  const parsed = AnswerSchema.safeParse(extractJson(answer));
  if (!parsed.success) throw new Error("the answer is not a verdict");
  const a = parsed.data;
  const known = new Set(input.candidates.map((c) => c.id));
  const of = a.of ?? null;
  const reason = (a.reason ?? "").trim();
  const named = (): string => {
    if (of === null || !known.has(of)) {
      throw new Error(`verdict "${a.verdict}" names no known memory`);
    }
    return of;
  };
  const rewritten = () => {
    const text = (a.text ?? "").trim();
    if (text.length === 0 || text.length > MAX_MEMORY_TEXT) {
      throw new Error("the rewritten claim is empty or over the length bound");
    }
    const memoryKind = a.kind ?? input.kindHint ?? "fact";
    const subject = a.subject === "repo" && !input.hasRepo ? "org" : a.subject ?? input.subject;
    return { text, memoryKind, subject };
  };
  switch (a.verdict) {
    case "duplicate":
      return { kind: "duplicate", of: named(), reason };
    case "supersedes":
      return { kind: "supersedes", of: named(), ...rewritten(), reason };
    case "refines":
      return { kind: "refines", of: named(), ...rewritten(), reason };
    case "noise":
      return { kind: "noise", of: of !== null && known.has(of) ? of : null, reason };
    case "new":
      return { kind: "new", ...rewritten(), reason };
  }
}

/** One judgement: the prompt, the call, the parse. Throws on any failure. */
export async function judge(model: ModelClient, input: JudgeInput): Promise<Verdict> {
  const answer = await model.complete({
    system: SYSTEM,
    prompt: renderJudgePrompt(input),
    maxTokens: 600,
  });
  return parseVerdict(answer, input);
}
