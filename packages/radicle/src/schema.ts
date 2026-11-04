// The ingest boundary — every JSON payload is parsed against a schema here before it may travel
// as a core type, the same doctrine as the other services'. Nothing downstream re-validates, so
// a field that reaches a subprocess argument gets its shape checked exactly once: here.

import { z } from "@zod/zod";
import { MAX_EMBED_BYTES } from "./core/service.ts";

const MAX_BODY = 200_000;

export const CompareChangeSchema = z.strictObject({
  from: z.string().regex(/^[0-9a-f]{40}$/),
  to: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  mode: z.enum(["diff", "range-diff"]).default("diff"),
});

/** How many files one write may embed — the forge's per-body image cap. */
export const MAX_EMBEDS = 10;

/** The most base64 one embed's bytes take. */
const MAX_EMBED_BASE64 = Math.ceil(MAX_EMBED_BYTES / 3) * 4;

/**
 * The most JSON a write with embeds can be: every file at the cap, base64, beside the text.
 * Bounded so a write is never an unbounded allocation; generous so ten screenshots fit.
 */
export const MAX_EMBEDS_JSON = MAX_EMBEDS * (MAX_EMBED_BASE64 + 1_024);

/**
 * A file a write stores with the COB: its name and its bytes, base64 on the wire. The name
 * becomes a path in the op's `embeds/` tree and a CLI argument (`--embed-hash <name> <oid>`), so
 * it is a plain file name — no slash, no leading dash or dot.
 */
const embed = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, {
    error: "must be a plain file name",
  }),
  data: z.string().min(1).max(MAX_EMBED_BASE64).transform((data, ctx) => {
    try {
      const bytes = Uint8Array.fromBase64(data);
      if (bytes.length > MAX_EMBED_BYTES) {
        ctx.addIssue({ code: "custom", message: `larger than ${MAX_EMBED_BYTES} bytes` });
        return z.NEVER;
      }
      return bytes;
    } catch {
      ctx.addIssue({ code: "custom", message: "not base64" });
      return z.NEVER;
    }
  }),
}).transform((e) => ({ name: e.name, bytes: e.data }));

const embeds = z.array(embed).max(MAX_EMBEDS).refine(
  (list) => new Set(list.map((e) => e.name)).size === list.length,
  { error: "embed names must be unique" },
).optional();

const line = z.string().trim().min(1).max(500).refine((s) => !/[\r\n]/.test(s), {
  error: "must be a single line",
});
/** A label, an assignee, a path — anything that becomes a CLI argument must not lead with `-`. */
const token = z.string().trim().min(1).max(200).refine((s) => !s.startsWith("-"), {
  error: "must not begin with a dash",
});
const sha = z.string().regex(/^[0-9a-f]{40}$/, { error: "must be a 40-character object id" });

export const SeedSchema = z.object({
  /** Reserved: the bridge always seeds with scope `all` (see core/service.ts). */
  scope: z.literal("all").optional(),
}).optional();

export const CreateIssueSchema = z.object({
  title: line,
  body: z.string().max(MAX_BODY).default(""),
  labels: z.array(token).max(32).optional(),
  /** The description's files. */
  embeds,
});

export const CloseIssueSchema = z.object({
  reason: z.enum(["solved", "other"]).default("solved"),
}).optional();

export const CommentSchema = z.object({
  body: z.string().trim().min(1).max(MAX_BODY),
  replyTo: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  embeds,
});

export const EditCommentSchema = z.object({
  body: z.string().trim().min(1).max(MAX_BODY),
  /** The comment's files after the edit — an edit replaces them, as it replaces the text. */
  embeds,
});

export const ReactionSchema = z.object({
  /** One emoji. Radicle stores the grapheme itself, not a `:name:`. */
  reaction: z.string().trim().min(1).max(16),
  active: z.boolean().default(true),
});

export const ReviewSchema = z.object({
  summary: z.string().max(MAX_BODY).optional(),
  verdict: z.enum(["accept", "reject"]).optional(),
  remarks: z.array(z.object({
    path: token.max(400),
    /** 1-based, as every forge API counts. Converted to Radicle's 0-based range in the core. */
    line: z.number().int().min(1).max(10_000_000),
    side: z.enum(["old", "new"]).default("new"),
    body: z.string().trim().min(1).max(MAX_BODY),
  })).max(200).default([]),
  /** The summary's files. */
  summaryEmbeds: embeds,
}).refine((r) => !r.summaryEmbeds?.length || (r.summary ?? "").trim() !== "", {
  error: "summaryEmbeds needs a summary to hang on",
});

export const LabelsSchema = z.object({
  labels: z.array(token).min(1).max(32),
});

/** The JSON half of `POST /v1/repos/:rid/changes` — the bundle rides beside it. */
export const SubmitChangeSchema = z.object({
  title: line,
  description: z.string().max(MAX_BODY).default(""),
  baseSha: sha,
  headSha: sha,
  draft: z.boolean().default(false),
  /** An existing change request to add a revision to: a full COB id or a unique prefix. */
  changeRef: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  /** The description's files. */
  embeds,
});

/**
 * Where a job run's detail lives. `rad-job` parses it with the `url` crate and stores it as the
 * run's `log`, and Desktop renders it as a link — so it is an absolute URL, on one line, and
 * never an argument a CLI could read as a flag. `urn:` is accepted for a deployment with no web
 * address to point at (the `url` crate takes it; measured).
 */
const logUrl = z.string().trim().min(1).max(2000).refine((s) => {
  if (/\s/.test(s)) return false;
  try {
    const url = new URL(s);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "urn:";
  } catch {
    return false;
  }
}, { error: "must be an absolute http(s) or urn URL" });

/** How many superseded runs one record call may finish. */
export const MAX_SUPERSEDED = 100;

/** `POST /v1/repos/:rid/jobs/runs`. No uuid: `rad-job` mints the run's own, so the log URL is
 * the caller's idempotency key — one per suite generation. Strict: a field this does not know is
 * a caller that means something this route would not do. */
export const RecordRunSchema = z.strictObject({
  commit: sha,
  log: logUrl,
  finish: z.enum(["succeeded", "failed"]).optional(),
  /** The log URLs of runs this one replaces (older generations of the same suite): each of
   * ours still going is finished as failed first, under the same lock. */
  supersedes: z.array(logUrl).max(MAX_SUPERSEDED).optional(),
  /** Answer the run with this log if there is one, and record none if there is not. */
  existingOnly: z.boolean().optional(),
});
