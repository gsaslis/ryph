// The ingest extractor — the consolidator's job generalised, with a human at the end of it:
// one model call per section turns a document into candidate claims, each with a kind, a
// subject hint and the excerpt it came from. Pure prompt-building and parsing over a
// `ModelClient`; the service turns the claims into proposals for review.
//
// Invariants:
// - the model proposes, it never promotes: every claim lands in the inbox as a proposal with a
//   source origin, flagged by the same screen as an agent's, and a person reviews the batch
// - a claim over the length bound is dropped here, not truncated: the document is kept whole
//   as a source with a pointer memory, so nothing is lost by not extracting it
// - a parse failure is a THROW per section: the service records nothing for that section and
//   moves on, so one bad answer never empties a batch

import { z } from "@zod/zod";
import type { ModelClient } from "../ports/model.ts";
import { MAX_MEMORY_TEXT, MEMORY_KINDS, type MemoryKind } from "./types.ts";

export interface ExtractedClaim {
  text: string;
  kind: MemoryKind;
  subject: "org" | "repo";
  /** The sentence or two of the section the claim came from. */
  excerpt: string;
}

const SYSTEM = `You extract durable, atomic claims from a document an engineering team handed
to its shared memory — claims that would help an AI agent working in the team's repositories
later. You answer with a single JSON object and nothing else.

Extract only what is DURABLE and USEFUL: how the system is built and deployed, what commands
and flags matter, decisions and their reasons, gotchas that cost time, conventions and
preferences. Skip narrative, dates of meetings, greetings, table-of-contents lines, anything a
reader could not act on, and anything that is only true for one moment.

Each claim: ONE atomic statement of at most ${MAX_MEMORY_TEXT} characters, in plain declarative
English, keeping concrete identifiers (paths, commands, flags, names, versions) exactly as
written, never phrased as an instruction to the reader. Give "kind": one of
${MEMORY_KINDS.filter((k) => k !== "pointer").join(", ")} — fact (how something is), procedure
(how to do something), gotcha (what costs time and how to avoid it), decision (what was decided
and why), preference (how people want things done). Give "subject": "repo" when the claim is
about the repository this document describes, "org" when it is about the organisation, its people
or conventions across repositories. Give "excerpt": the sentence or two the claim comes from,
verbatim. Never include credentials, tokens or keys.

Return at most 12 claims for a section; zero is a fine answer. Answer with exactly:
{"claims": [{"text": "...", "kind": "...", "subject": "org"|"repo", "excerpt": "..."}]}`;

const AnswerSchema = z.object({
  claims: z.array(z.object({
    text: z.string(),
    kind: z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]).optional(),
    subject: z.enum(["org", "repo"]).optional(),
    excerpt: z.string().optional(),
  })).max(50),
});

export function renderExtractPrompt(
  doc: { title: string; subject: "org" | "repo"; repo: string | null },
  section: { title: string; text: string },
): string {
  return [
    `Document: ${doc.title}`,
    `About: ${
      doc.subject === "repo" && doc.repo !== null
        ? `the repository ${doc.repo}`
        : "the organisation"
    }`,
    `Section: ${section.title}`,
    "",
    section.text,
  ].join("\n");
}

/** Parses an answer into claims, dropping the empty and the overlong. */
export function parseClaims(answer: string, fallbackSubject: "org" | "repo"): ExtractedClaim[] {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the answer carries no JSON object");
  const parsed = AnswerSchema.safeParse(JSON.parse(answer.slice(start, end + 1)));
  if (!parsed.success) throw new Error("the answer is not a claim list");
  return parsed.data.claims.flatMap((c) => {
    const text = c.text.trim();
    if (text.length === 0 || text.length > MAX_MEMORY_TEXT) return [];
    const kind = c.kind === undefined || c.kind === "pointer" ? "fact" : c.kind;
    return [{
      text,
      kind,
      subject: c.subject ?? fallbackSubject,
      excerpt: (c.excerpt ?? "").trim().slice(0, 1000),
    }];
  });
}

/** One section's claims. Throws on a model or parse failure. */
export async function extractClaims(
  model: ModelClient,
  doc: { title: string; subject: "org" | "repo"; repo: string | null },
  section: { title: string; text: string },
): Promise<ExtractedClaim[]> {
  const answer = await model.complete({
    system: SYSTEM,
    prompt: renderExtractPrompt(doc, section),
    maxTokens: 2_000,
  });
  return parseClaims(answer, doc.subject);
}
