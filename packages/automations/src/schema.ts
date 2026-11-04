// Request validation for the CRUD surface. Strict like every user-facing schema in this
// codebase: an unknown key on a hand-written request is a typo worth refusing loudly.
// A secret is accepted here in one shape only — pasted, on create or rotate, for a sender that
// generates its own and will not take ours (PagerDuty, Sentry, incident.io). It is written to
// the row and never echoed back; every other secret is minted server-side.

import { z } from "@zod/zod";
import { DEFAULT_ATTENDED_IDLE_MS, DEFAULT_IDLE_MS } from "./core/types.ts";
import { parsePath } from "./core/formats.ts";

const MAX_LEN = 100_000;
const nonEmpty = z.string().trim().min(1).max(MAX_LEN);
const singleLine = nonEmpty.refine((s) => !/[\r\n]/.test(s), {
  error: "must be a single line",
});
const mintedId = singleLine.max(200).regex(/^[A-Za-z0-9._-]+$/, { error: "not a valid id" });
// The same pragmatic subset the orchestrator refuses: this is the LAST validation a ref meets
// in a single-process composition (the events door is called directly, without its zod), and a
// ref eventually rides an argv — a leading '-' must die at creation, not at fire time.
const gitName = singleLine.max(200)
  .refine((s) => !s.startsWith("-"), { error: "must not start with '-'" })
  .refine(
    (s) =>
      !/[\s~^:?*[\\]|\.\.|@\{/.test(s) &&
      !s.endsWith("/") &&
      !s.endsWith(".lock"),
    { error: "not a valid git ref name" },
  );

const RateLimitSchema = z.strictObject({
  maxPerWindow: z.number().int().min(1).max(600),
  windowMs: z.number().int().min(1_000).max(24 * 60 * 60_000),
});

/** A secret pasted from the sender's settings: printable ASCII, long enough to be a real one,
 * short enough to be nothing else. Verbatim — not trimmed, since a signing secret's every
 * character counts (the app trims a paste before sending it). */
export const PastedSecretSchema = z.string().min(16).max(512).regex(/^[\x20-\x7e]+$/, {
  error: "must be printable ASCII",
});

/** What a caller chooses about verification. The secret is minted unless one is pasted; the
 * defaults are the headers most senders can produce without ceremony. */
const VerificationInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("hmac-sha256"),
    header: singleLine.max(100).default("x-ryph-signature"),
    prefix: z.string().max(20).default("sha256="),
    secret: PastedSecretSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("secret-header"),
    header: singleLine.max(100).default("authorization"),
    // `Bearer ` for a sender that fills `authorization` the standard way.
    prefix: z.string().max(20).default(""),
    secret: PastedSecretSchema.optional(),
  }),
  // Fixed headers, so nothing to choose but the secret — the sender's, always.
  z.strictObject({
    kind: z.literal("standard-webhooks"),
    secret: PastedSecretSchema.optional(),
  }),
]);

/** One path into a fire's JSON body, as the format's path syntax spells it. */
const mappingPath = singleLine.max(200).refine((p) => parsePath(p) !== null, {
  error: 'not a valid path (dot-separated keys, [0] for an index, ["a.b"] for a dotted key)',
});
const mappingPaths = z.array(mappingPath).max(10).default([]);
const mappingValues = z.array(singleLine.max(100)).max(50).default([]);

/** A custom format's mapping. Bounded on every axis: it is evaluated on every fire. */
export const SignalMappingSchema = z.strictObject({
  status: mappingPaths,
  firing: mappingValues,
  resolved: mappingValues,
  update: mappingValues,
  key: mappingPaths,
  title: mappingPaths,
});

/** How a webhook trigger's fires are read: a preset by name, or the owner's own mapping. */
export const FormatInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum([
      "raw",
      "alertmanager",
      "grafana",
      "grafana-irm",
      "pagerduty",
      "opsgenie",
      "sentry",
      "incident-io",
      "datadog",
    ]),
  }),
  z.strictObject({ kind: z.literal("custom"), mapping: SignalMappingSchema }),
]);

const TriggerInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("webhook"),
    // Raw for an API caller who names none: the fire is carried, not read — every signal
    // unknown, exactly what an automation did before formats existed.
    format: FormatInputSchema.default({ kind: "raw" }),
    verification: VerificationInputSchema,
    rateLimit: RateLimitSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("schedule"),
    cron: singleLine.max(100),
    timezone: singleLine.max(100).default("UTC"),
  }),
]);

/** What the runs check out: a connected repo at a ref (null: its default branch), or a
 * workspace at its saved refs. */
export const TargetInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("repo"),
    connectedRepoId: mintedId,
    // A branch: a run on a pull request's head (`refs/pull/42/head`, or its local spelling
    // `pull/…`) runs someone else's code, and only a `/ryph` in that pull request starts one.
    ref: gitName.refine(
      (s) =>
        (!s.startsWith("refs/") || s.startsWith("refs/heads/")) && !s.startsWith("pull/") &&
        !s.startsWith("refs/heads/pull/"),
      { error: "must name a branch, not a tag or a pull request ref" },
    ).nullable().default(null),
  }),
  z.strictObject({ kind: z.literal("workspace"), workspaceId: mintedId }),
]);

/** An idle clock: at least a minute (a run cannot answer faster than a person types), at most
 * a day (a forgotten run holds live credentials for exactly this long). */
const idleMs = z.number().int().min(60_000).max(24 * 60 * 60_000);

/** A platform channel id, as the chat service's channel list spells it: Zulip's stream_id, a
 * number, as a string, Slack's `C…`, or Discord's snowflake (a string: it is past 2^53). Not a
 * minted id — the platform mints it, so only its
 * length is ours. */
const channelId = singleLine.max(200);

/** The response policy, as a caller writes it: a chatroom (or none), the channel a room with
 * channels opens each response's conversation in (null elsewhere — the routes check which), the
 * two idle clocks, defaulted to five and thirty minutes, which open response a fire joins, and
 * whether the opening line carries the alert (off unless asked for), and whether the responses
 * share one conversation (each its own unless asked for — the routes check it has a channel).
 * `correlation` has no default HERE because its default depends on the trigger (a schedule's
 * fires each get their own, a keyed format's join per key) — the routes fill it in, and refuse
 * `key` on a schedule. Null clears the policy on a PATCH. */
export const ResponseInputSchema = z.strictObject({
  chatroomId: mintedId.nullable().default(null),
  channelId: channelId.nullable().default(null),
  idleMs: idleMs.default(DEFAULT_IDLE_MS),
  attendedIdleMs: idleMs.default(DEFAULT_ATTENDED_IDLE_MS),
  correlation: z.enum(["fire", "automation", "key"]).optional(),
  postAlert: z.boolean().default(false),
  conversation: z.enum(["per-response", "shared"]).default("per-response"),
});

export const CreateAutomationSchema = z.strictObject({
  name: singleLine.max(200),
  trigger: TriggerInputSchema,
  agentId: mintedId,
  target: TargetInputSchema,
  instructions: nonEmpty,
  response: ResponseInputSchema.nullable().optional(),
});

/** The recipe's revisable half. Trigger *kind* is not revisable — a webhook automation stays
 * one; delete and recreate to change its nature. */
export const UpdateAutomationSchema = z.strictObject({
  name: singleLine.max(200).optional(),
  agentId: mintedId.optional(),
  target: TargetInputSchema.optional(),
  instructions: nonEmpty.optional(),
  response: ResponseInputSchema.nullable().optional(),
  rateLimit: RateLimitSchema.optional(),
  // A webhook's only; the routes refuse it on a schedule, as they do a rate limit.
  format: FormatInputSchema.optional(),
  cron: singleLine.max(100).optional(),
  timezone: singleLine.max(100).optional(),
});

/** The rotate body: a pasted secret, or nothing (an empty body too) to mint a fresh one. */
export const RotateSecretSchema = z.strictObject({
  secret: PastedSecretSchema.optional(),
});

export type CreateAutomationInput = z.infer<typeof CreateAutomationSchema>;
export type UpdateAutomationInput = z.infer<typeof UpdateAutomationSchema>;
export type ResponseInput = z.infer<typeof ResponseInputSchema>;
