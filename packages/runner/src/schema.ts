// The ingest boundary.
// Every payload that arrives as JSON is parsed against a schema here
// before it may travel as a core type.
//
// Invariants:
// - nothing downstream ever sees an unchecked cast:
//   a value becomes a core type only by surviving a schema in this file
// - each schema is pinned to its interface with `satisfies z.ZodType<...>`,
//   so a drift between the two is a compile error — core/types.ts stays the source of truth
// - zod never reaches src/core; the architecture guard keeps the core dependency-free
// - no value that rides an argv may begin with '-' — refs, SHAs, branch names, and the
//   harness's provider/model/thinking; a leading dash is a flag smuggled onto a command line,
//   and it is refused here rather than downstream.
//   Names git itself refuses (spaces, '~', '^', ':', '..', ...) are also rejected here,
//   so bad caller input is a clean validation rejection instead of a mid-run git failure
// - spec.title is a single line: it becomes the commit subject verbatim,
//   and an interior newline would silently split it into subject + body,
//   truncating the reported subject
// - id is a single path-safe slug: it names on-disk outputs (progress, transcript),
//   so a '/' or '..' that could escape or nest those paths is refused here
// - every string is length-bounded (MAX_LEN); an unbounded payload field is a memory-DoS vector
// - a repo's path is one directory name under the checkout root, an RFC 1035 label: it is
//   joined onto a filesystem path and printed into the agent's prompt, so nothing that could
//   nest, escape or read as markup is accepted, and no two entries may share one

import { z } from "@zod/zod";
import { ENV_PREFIX, MODEL_ENDPOINT_ENV } from "./core/brand.ts";
import { isLineName } from "@ryph/shared/lines";
import { isGitRefName, MAX_REF_NAME } from "@ryph/shared/refs";
import {
  DESCRIPTION_CONTROL,
  dropDetail,
  isSkillPath,
  MAX_DESCRIPTION_CHARS,
  MAX_LISTED_SKILLS,
  MAX_LISTING_BYTES,
  MAX_REPORTED_SKILL_DROPS,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_NAME,
  MAX_SKILL_PATH,
  reportableDrops,
  SKILL_NAME,
  skillDrop,
} from "./helpers/skills.ts";
import type {
  DeclaredChecks,
  InboundMessage,
  InjectedContext,
  MemoryBrief,
  RepoEntry,
  RunEnvironment,
  RunLifetime,
  RunServices,
  RunSkills,
  RunSpec,
  SkillBundle,
  SkillDrop,
  WorkItem,
} from "./core/types.ts";

/** The brand-scoped names the credentials channel may set, as a set for the exact-match test
 * in `RunCredentialsSchema`. Nothing else beginning with the prefix ever gets through. */
const HARNESS_PROVISIONED = new Set<string>(Object.values(MODEL_ENDPOINT_ENV));

// A generous ceiling — large enough for a full task's instructions, small enough to bound a
// hostile payload. Deliberately one flat value for now; split per-field if a field needs tighter.
const MAX_LEN = 100_000;

const nonEmpty = z.string().trim().min(1).max(MAX_LEN);

const singleLine = nonEmpty.refine((s) => !/[\r\n]/.test(s), {
  error: "must be a single line",
});

// A chat room's name or a bot's handle: what the platforms allow is far shorter than this.
const chatLine = z.string().trim().min(1).max(128).refine((s) => !/[\r\n]/.test(s), {
  error: "must be a single line",
});

// For values handed to a child process as argv a leading dash would let the value be parsed as a flag.
const flagSafe = singleLine.refine((s) => !s.startsWith("-"), {
  error: "must not start with '-'",
});

// A ref name as @ryph/shared/refs judges one, so the common invalid names die at ingest.
const gitName = z.string().trim().min(1).max(MAX_REF_NAME).refine(isGitRefName, {
  error: "not a valid git ref name",
});

// id becomes a path segment for run outputs, so it must be one clean slug: no '/' to nest, no
// '..' to escape, no leading '-' to smuggle a flag. `+` implies non-empty; `.trim()` is moot
// since the pattern already forbids whitespace.
const slug = z
  .string()
  .max(MAX_LEN)
  .regex(/^[A-Za-z0-9._-]+$/, {
    error: "must be a slug (letters, digits, '.', '_', '-')",
  })
  .refine((s) => !s.startsWith("-"), { error: "must not start with '-'" })
  .refine((s) => !s.includes(".."), { error: "must not contain '..'" });

/** How many repositories one run may check out. A ceiling on the prompt's layout block and the
 * clone loop, not a product limit anyone should meet. */
const MAX_REPOS = 20;

/** A directory name under the checkout root: an RFC 1035 label, like a service name. */
const repoPath = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, {
  error: "must be a DNS label (a-z, 0-9 and '-', at most 63 chars)",
});

export const RepoEntrySchema = z.object({
  connectedRepoId: slug,
  name: singleLine,
  url: nonEmpty,
  ref: gitName,
  targetRef: gitName.optional(),
  forkHead: z.boolean().optional(),
  provider: z.enum(["github", "gitlab", "radicle", "local"]).optional(),
  path: repoPath,
  branchNamespace: gitName,
  description: z.string().max(MAX_LEN).nullable(),
}) satisfies z.ZodType<RepoEntry>;

/** A clock in milliseconds: at least a minute (a run cannot usefully wait less) and at most a
 * day (a forgotten run holds live credentials for as long as this says). */
const idleMs = z.number().int().min(60_000).max(24 * 60 * 60_000);

/** How long the run waits once the agent settles. Required: the control plane always says. */
export const RunLifetimeSchema = z.object({
  idleMs,
  attendedIdleMs: idleMs,
}) satisfies z.ZodType<RunLifetime>;

/** How many images one task or one message may carry — the control plane's cap, restated (and
 * pinned to it by tests/images_test.ts, as the four types below are). */
export const MAX_ATTACHMENTS = 10;

/** An image by id, as the control plane names one: its own minted id (it rides a URL path) and
 * one of the four types it sniffed. */
export const AttachmentRefSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/, { error: "not an attachment id" }),
  mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
});

/** What `POST /v1/runs/:id/runner/images/resolve` answers: the refs the run keeps, and not. */
export const ImageRefsAnswerSchema = z.object({
  images: z.array(z.object({ ref: z.string() })),
  unknown: z.array(z.string()),
});

export const WorkItemSchema = z.object({
  id: slug,
  agent: z.object({ name: nonEmpty, email: z.email() }),
  // Both null while the task awaits its prompt; never one without the other.
  spec: z.union([
    z.object({ title: singleLine, instructions: nonEmpty }),
    z.object({ title: z.null(), instructions: z.null() }),
  ]),
  lifetime: RunLifetimeSchema,
  repos: z.array(RepoEntrySchema).min(1).max(MAX_REPOS).refine(
    (repos) => new Set(repos.map((r) => r.path)).size === repos.length,
    { error: "every repo needs its own path" },
  ),
  // Defaulted: an absent workspace is a repo on its own, which is the ordinary run.
  workspace: z.object({ name: singleLine, description: z.string().max(MAX_LEN).nullable() })
    .nullable().default(null),
  // Printed into the agent's system prompt and into the framing of every chat message, OUTSIDE
  // any fence — so one line each, and short: a group title is a name, not a paragraph.
  chat: z.object({
    kind: z.enum(["telegram", "zulip", "slack", "discord"]),
    roomTitle: chatLine,
    botHandle: chatLine,
    quiet: z.literal(true).optional(),
  }).optional(),
  // Defaulted, as every key added to the spec is, so a run provisioned before the key existed
  // still boots. The control plane refuses a patch from such an agent whatever the runner says.
  canOpenPatches: z.boolean().default(true),
  // Off unless the control plane says on: the control plane refuses a publish from an agent
  // whose switch is off whatever the runner says.
  canPublishArtifacts: z.boolean().default(false),
  // Absent on every run someone may follow, which is all but an automation's with no response.
  unattended: z.literal(true).optional(),
  // Present only on a run a person started on the run page.
  interactive: z.literal(true).optional(),
  // Absent on a task that came with no images, which is nearly every one.
  attachments: z.array(AttachmentRefSchema).max(MAX_ATTACHMENTS).optional(),
  // Absent on every run whose agent has no browser, or whose deployment could not give it one.
  browser: z.object({ port: z.number().int().min(1).max(65535) }).optional(),
  harness: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("echo") }),
    z.object({
      kind: z.literal("pi"),
      provider: flagSafe.optional(),
      model: flagSafe.optional(),
      // Any flag-safe level, not only the ones this runner knows: the runner is baked into
      // environment images and can be older than the control plane, which may offer a level a
      // newer pi added. Refusing it here would fail the whole run; the pi adapter drops it with
      // a warning instead (adapters/harness/pi.ts `piArgs`).
      thinking: flagSafe.optional(),
    }),
  ]),
}) satisfies z.ZodType<WorkItem>;

export const MemoryBriefSchema = z.object({
  text: z.string().max(MAX_LEN),
  memoryIds: z.array(z.string().min(1).max(64)).max(1000),
  evidence: z.array(z.object({
    memoryId: z.string().min(1).max(64),
    sha: z.string().regex(/^[0-9a-f]{7,64}$/, { error: "not a commit sha" }),
    // Paths are handed to git as pathspecs, so nothing that could read as an option ('-') and
    // nothing that could read as pathspec MAGIC (':'): ":/" alone matches the whole repository,
    // which would turn one memory's staleness check into "everything changed". The diff also
    // runs with --literal-pathspecs (helpers/checkout.ts), so magic is inert either way —
    // this refusal is the half that keeps a leading '-' or ':' from ever being frozen onto a run.
    paths: z.array(
      z.string().min(1).max(1024).refine((p) => !p.startsWith("-") && !p.startsWith(":"), {
        error: "not a path",
      }),
    ).min(1).max(50),
    path: repoPath.nullable(),
  })).max(1000),
}) satisfies z.ZodType<MemoryBrief>;

export const InjectedContextSchema = z.object({
  systemPrompt: z.string().max(MAX_LEN).optional(),
  brief: MemoryBriefSchema.optional(),
}) satisfies z.ZodType<InjectedContext>;

/**
 * The services the platform launched beside this run. Defaulted to null rather than required:
 * an orchestrator that predates the field omits it, and during a rolling deploy that has to
 * mean "this run has none" and not "the spec will not parse".
 */
export const RunServicesSchema = z.object({
  list: z.array(z.object({
    // An RFC 1035 label, because it is a hostname — and the runner dials it, so a value that
    // could carry anything else is a value that could dial somewhere else.
    name: z.string().regex(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/, { error: "not a DNS label" }),
    port: z.number().int().min(1).max(65535),
    image: z.string().max(512),
  })).max(20),
  stale: z.boolean(),
}) satisfies z.ZodType<RunServices>;

const commitSha = z.string().regex(/^[0-9a-f]{7,64}$/, { error: "not a commit sha" });

/**
 * The machine the run was launched on. Every string here is either something the runner acts
 * on (`baked`) or something it prints into the agent's environment block, so each is bounded
 * and single-line; the toolchain versions came out of a build that ran repo-authored code, and
 * are quoted, never trusted, when rendered (helpers/machine.ts).
 */
export const RunEnvironmentSchema = z.object({
  id: z.string().min(1).max(200),
  image: singleLine.max(1_000),
  baked: z.boolean(),
  commits: z.record(repoPath, commitSha).refine((c) => Object.keys(c).length <= MAX_REPOS, {
    error: `at most ${MAX_REPOS} commits`,
  }),
  builtAt: z.iso.datetime({ offset: true }).nullable(),
  toolchains: z.record(
    z.string().regex(/^[a-z0-9][a-z0-9_.+-]{0,31}$/, { error: "not a toolchain name" }),
    singleLine.max(200),
  ).refine((t) => Object.keys(t).length <= 32, { error: "at most 32 toolchains" }),
  ref: singleLine.max(1_000).nullable(),
}) satisfies z.ZodType<RunEnvironment>;

/** One repo's declared checks, as `GET /v1/runs/:id/checks/declared` answers them for the
 * prompt. Bounded, since it lands in the system prompt; a command is quoted there flattened to
 * one line, and everything else must already be one. */
const DeclaredChecksSchema = z.object({
  path: repoPath,
  // Display only: the platform's run-facing name for the repo — a forge address, or a local
  // repository's folder name (at most NAME_MAX, 255 bytes), never the host path. 500 holds
  // either; a path arriving here would be a platform bug, and refusing it keeps it out of the
  // prompt.
  repoRef: singleLine.max(500),
  checksRef: singleLine.max(1_000),
  setup: z.array(z.string().max(10_000)).max(32),
  checks: z.array(z.object({
    name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, {
      error: "not a check name",
    }),
    run: z.string().max(10_000),
    timeoutSeconds: z.number().int().nonnegative(),
    services: z.array(singleLine.max(100)).max(32),
  })).max(32),
}) satisfies z.ZodType<DeclaredChecks>;

/** What `GET /v1/runs/:id/checks/declared` answers. */
export const DeclaredChecksAnswerSchema = z.object({
  declared: z.array(DeclaredChecksSchema).max(MAX_REPOS),
  // The repo paths whose checks file could not be read, or "*" when the whole read failed.
  unread: z.array(z.union([z.literal("*"), repoPath])).max(MAX_REPOS),
});

/** A skill name: the control plane's grammar (its core/skills.ts `SKILL_NAME`), restated for
 * the other end of the wire. It becomes a directory name under the run's skills root. */
const skillName = z.string().max(MAX_SKILL_NAME).regex(SKILL_NAME, {
  error: "not a skill name",
});

/** A skill's content digest, as the control plane computes it. */
const skillDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/, { error: "not a skill digest" });

/**
 * The skills the control plane froze onto the run. A description is listed to the model in the
 * harness's own XML (escaped there) and was validated by the control plane; it is bounded and
 * checked again here because the runner writes it into the frontmatter pi parses.
 */
export const RunSkillsSchema = z.object({
  skills: z.array(z.object({
    name: skillName,
    description: z.string().min(1).max(MAX_DESCRIPTION_CHARS).refine(
      (d) => !DESCRIPTION_CONTROL.test(d),
      { error: "must not hold control characters" },
    ),
    source: z.enum(["catalogue", "org"]),
    digest: skillDigest,
  })).max(MAX_LISTED_SKILLS).refine(
    (skills) => new Set(skills.map((s) => s.name)).size === skills.length,
    { error: "every skill needs its own name" },
  ),
  workingRepos: z.boolean(),
  budget: z.object({
    skills: z.number().int().min(0).max(MAX_LISTED_SKILLS),
    listingBytes: z.number().int().min(0).max(MAX_LISTING_BYTES),
  }),
}) satisfies z.ZodType<RunSkills>;

/** What base64 text decodes to, in bytes, without decoding it. */
function base64Bytes(text: string): number {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - padding;
}

/**
 * One frozen skill's files. Every path is relative and plain (it is joined onto the run's skills
 * directory), and the counts and the total size are bounded here, before anything is decoded;
 * whether the bytes match the digest the run was frozen with is checked once they are
 * (helpers/skills.ts).
 */
export const SkillBundleSchema = z.object({
  files: z.array(z.object({
    path: z.string().max(MAX_SKILL_PATH).refine(isSkillPath, {
      error: "not a path inside a skill",
    }),
    executable: z.boolean(),
    // All of a skill's bytes at most, base64-encoded.
    content: z.string().max(Math.ceil(MAX_SKILL_BYTES / 3) * 4),
  })).min(1).max(MAX_SKILL_FILES).refine(
    (files) => files.reduce((sum, f) => sum + base64Bytes(f.content), 0) <= MAX_SKILL_BYTES,
    { error: `the skill is over ${MAX_SKILL_BYTES} bytes` },
  ),
}) satisfies z.ZodType<SkillBundle>;

/** What `GET /v1/runs/:id/spec` answers — the run's complete input, fetched on boot. */
export const RunSpecSchema = z.object({
  workItem: WorkItemSchema,
  injectedContext: InjectedContextSchema.nullable(),
  services: RunServicesSchema.nullable().default(null),
  // Defaulted like services: absent means no environment was resolved, and the run clones.
  environment: RunEnvironmentSchema.nullable().default(null),
  // Defaulted like the two above: absent means a control plane that runs no checks.
  checks: z.object({ enabled: z.boolean() }).nullable().default(null),
  // Read on its own (readRunSkills): its limits are restated from the control plane, and a
  // runner baked into an older environment image may meet a newer one. A section this runner
  // cannot read costs the run its skills, never the run.
  skills: z.unknown().optional(),
}) satisfies z.ZodType<RunSpec>;

/**
 * The most a skills section may take as JSON: every allowed entry at its longest, each description
 * character escaped as `\uXXXX`, with room to spare. A section past it is refused before its
 * schema runs, so fields this runner does not know cannot carry an unbounded payload through.
 */
export const MAX_SKILLS_SECTION_CHARS = 256 * 1024;

/**
 * The spec's skills section, read apart from the rest of the spec. Absent or null means none
 * were frozen. A section this runner refuses is read as none, with why, and with a drop for
 * every entry that still names a frozen skill plainly enough for the trail to place it.
 */
export function readRunSkills(
  raw: unknown,
): { skills: RunSkills | null; refused: null } | {
  skills: null;
  refused: { reason: string; dropped: SkillDrop[] };
} {
  if (raw === undefined || raw === null) return { skills: null, refused: null };
  // Counted and measured before anything is parsed: a section over the count or the size it may
  // hold is refused without reading its entries, so a malformed one costs no more work than an
  // allowed one.
  const entries = typeof raw === "object" && "skills" in raw && Array.isArray(raw.skills)
    ? raw.skills as unknown[]
    : [];
  const counted = entries.length <= MAX_LISTED_SKILLS;
  const chars = counted ? (JSON.stringify(raw)?.length ?? 0) : 0;
  let reason: string;
  if (!counted) {
    reason = dropDetail(
      `the run's skills could not be read: skills: ${entries.length} entries, at most ${MAX_LISTED_SKILLS}`,
    );
  } else if (chars > MAX_SKILLS_SECTION_CHARS) {
    reason = dropDetail(
      `the run's skills could not be read: ${chars} characters, at most ${MAX_SKILLS_SECTION_CHARS}`,
    );
  } else {
    const parsed = RunSkillsSchema.safeParse(raw);
    if (parsed.success) return { skills: parsed.data, refused: null };
    const issue = parsed.error.issues[0];
    reason = dropDetail(
      `the run's skills could not be read: ${issue.path.join(".") || "skills"}: ${issue.message}`,
    );
  }
  // Only as many entries are looked at as one report carries; the rest are counted, not read.
  const inspected = entries.slice(0, MAX_REPORTED_SKILL_DROPS);
  const dropped = reportableDrops(
    inspected.flatMap((entry): SkillDrop[] => {
      const one = z.object({ name: skillName, source: z.enum(["catalogue", "org"]) }).safeParse(
        entry,
      );
      return one.success
        ? [skillDrop({
          source: one.data.source,
          name: one.data.name,
          reason: "invalid",
          detail: reason,
        })]
        : [];
    }),
    entries.length - inspected.length,
  );
  return { skills: null, refused: { reason, dropped } };
}

/**
 * What `GET /v1/runs/:id/credentials` answers — the env the harness needs to call its model
 * backend (a run-scoped virtual key and the proxy address, typically). A generic map on
 * purpose: the variable names are the provider registry's business, so a new provider is no
 * wire-contract change. Names are shaped like env vars must be, and the runner refuses any
 * attempt to override its own contract (`${ENV_PREFIX}_*`) or knobs (RUNNER_*) — the
 * credentials channel provisions the harness, it does not reconfigure the runner.
 *
 * `MODEL_ENDPOINT_ENV`'s three names are the one carve-out, and they are allowed by EXACT
 * MATCH rather than by loosening the prefix, so the invariant above still reads as true: none
 * of the three configures this runner. They describe a custom model endpoint — its virtual
 * key, the proxy address to dial, the endpoint's declared models — and the harness adapter is
 * their only reader. They wear the brand prefix precisely because it is load-bearing: it is
 * what puts them inside `runChildEnv`'s scrub, so a repo's setup steps never see the virtual
 * key of a custom endpoint, where a built-in's ANTHROPIC_API_KEY they do see.
 */
export const RunCredentialsSchema = z.object({
  env: z.record(
    z.string().regex(/^[A-Z][A-Z0-9_]*$/, { error: "not an env var name" })
      .refine(
        (name) =>
          HARNESS_PROVISIONED.has(name) ||
          (!name.startsWith(`${ENV_PREFIX}_`) && !name.startsWith("RUNNER_")),
        { error: "must not override runner configuration" },
      ),
    z.string().max(MAX_LEN),
  ),
  // The tool half, present only for a run whose agent has a tool policy: one virtual token for
  // the MCP gateway and the gateway endpoint per server in the run's scope. The slug becomes a
  // key in the harness's MCP config and a tool-name prefix, hence the tight grammar (the
  // gateway's own); the URL is dialed verbatim by the harness's MCP client.
  //
  // `http` is accepted, because a local or compose deployment dials the gateway over the
  // container network — but it puts the run's virtual bearer on the wire in cleartext, so
  // main.ts says so at warn level when one arrives. Userinfo is refused outright: nothing
  // legitimate issues a gateway URL with credentials in it, and the error paths that name a
  // URL's `host` would quietly drop them.
  mcp: z.object({
    token: z.string().min(1).max(MAX_LEN),
    servers: z.array(z.object({
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/, { error: "not a server slug" }),
      name: singleLine,
      url: z.url({ protocol: /^https?$/ }).refine(
        (url) => {
          const parsed = new URL(url);
          return parsed.username === "" && parsed.password === "";
        },
        { error: "must not carry userinfo" },
      ),
    })).min(1).max(32),
  }).optional(),
});

/**
 * The one-shot bootstrap exchange's answer (`POST /v1/runs/:id/bootstrap`): the run's own
 * contract — its bearers and the addresses they go to — which the launch environment does not
 * carry. The mirror of `RunCredentialsSchema`: every name is brand-scoped, which keeps all of it
 * inside `runChildEnv`'s scrub, and the run bearer is the one name it must carry.
 */
export const RunBootstrapSchema = z.object({
  env: z.record(
    z.string().regex(new RegExp(`^${ENV_PREFIX}_[A-Z0-9_]+$`), {
      error: "not a runner contract name",
    }),
    z.string().max(MAX_LEN),
  ).refine((env) => (env[`${ENV_PREFIX}_RUN_TOKEN`] ?? "") !== "", {
    error: `carries no ${ENV_PREFIX}_RUN_TOKEN`,
  }),
});

/** The credentials fetch's answer, past the ingest boundary. */
export type RunCredentials = z.infer<typeof RunCredentialsSchema>;

/** Who said a message in the run's inbox. Every arm is data the runner names in a framing. */
const MessageSenderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string().min(1).max(200) }),
  z.object({
    kind: z.literal("chat"),
    name: z.string().max(200),
    id: z.string().max(200),
  }),
  z.object({ kind: z.literal("automation"), fireId: z.string().min(1).max(200) }),
  z.object({
    kind: z.literal("forge"),
    login: z.string().min(1).max(200),
    repoRef: z.string().min(1).max(400),
    thread: z.string().min(1).max(200),
  }),
  z.object({ kind: z.literal("platform") }),
]);

/** A line of a repo (@ryph/shared/lines): the cue is routed to (path, line), so it is held to the
 * line grammar the runner mints branches by. */
const lineName = z.string().refine(isLineName, { error: "not a line name" });

/** A system message's structured cue. The path is a checkout path, so it is held to the same
 * grammar as an entry's: the runner looks it up among its clones and nowhere else. */
const PatchPayloadSchema = z.object({
  kind: z.literal("patch"),
  patchId: z.string().min(1).max(200),
  path: repoPath,
  line: lineName,
  headSha: z.string().regex(/^[0-9a-f]{7,64}$/, { error: "not a commit sha" }),
  generation: z.number().int().min(1).max(10_000),
  state: z.enum([
    "submitted",
    "approved",
    "rejected",
    "merged",
    "closed",
    "failed",
    "superseded",
    "held",
    "missed",
  ]),
  forgeUrl: z.string().max(2_000).nullable(),
  reason: z.string().max(MAX_LEN).nullable(),
  // A branch the runner FETCHES (`git fetch origin -- <onto>`): held to the ref grammar every
  // other ref the runner hands git is, whoever sent it.
  onto: gitName.optional(),
  // On a merge, always: what the agent's rebase starts past. A commit the runner hands git, so
  // held to the sha grammar.
  landedHead: z.string().regex(/^[0-9a-f]{7,64}$/, { error: "not a commit sha" }).optional(),
  // With `held`: the git hook files that hold the patch for a person, as the forge capped them.
  hookPaths: z.array(z.string().min(1).max(4_096)).max(50).optional(),
}).refine(
  (p) => p.state !== "merged" || p.landedHead !== undefined,
  { error: "a merge names its landed head", path: ["landedHead"] },
);

/** A release: the change request the repo worked merged with nothing of the run's on it. `onto`
 * is fetched like a merge's, so it is held to the same grammar. */
const ReleasedPayloadSchema = z.object({
  kind: z.literal("released"),
  path: repoPath,
  line: lineName,
  generation: z.number().int().min(1).max(10_000),
  onto: gitName,
  forgeRef: z.string().min(1).max(200),
});

/** An environment build's result: carried, never acted on — the runner frames the text only. */
const EnvironmentPayloadSchema = z.object({
  kind: z.literal("environment"),
  patchId: z.string().min(1).max(200),
  path: repoPath,
  headSha: z.string().regex(/^[0-9a-f]{7,64}$/, { error: "not a commit sha" }),
  environmentId: z.string().min(1).max(200).nullable(),
  status: z.enum(["ready", "failed", "superseded", "skipped"]),
});

/** A person finished the run from its page: the cue alone, nothing beside it to read. */
const FinishPayloadSchema = z.object({ kind: z.literal("finish") });

const ChecksPayloadSchema = z.object({
  kind: z.literal("checks"),
  suiteId: z.string().min(1).max(200),
  state: z.enum(["passed", "failed", "error", "cancelled"]),
  path: repoPath,
  commit: z.string().regex(/^[0-9a-f]{7,64}$/, { error: "not a commit sha" }),
  partial: z.boolean(),
});

const SystemPayloadSchema = z.discriminatedUnion("kind", [
  PatchPayloadSchema,
  ReleasedPayloadSchema,
  EnvironmentPayloadSchema,
  FinishPayloadSchema,
  ChecksPayloadSchema,
]);

/** The payload kinds this runner acts on or carries. */
const KNOWN_PAYLOAD_KINDS: ReadonlySet<unknown> = new Set([
  "patch",
  "released",
  "environment",
  "finish",
  "checks",
]);

/**
 * A message's payload, read so a control plane a version ahead cannot wedge the inbox: a kind
 * this runner does not know — or anything that is not a payload at all — reads as none, and the
 * message still arrives by its text, which is complete on its own. A KNOWN kind is held to its
 * schema here, and one that fails it (a patch cue naming a bad path, say) is dropped by
 * `parseInboundMessages` as well, never quietly: the message still arrives by its text, with no
 * payload, and the drop is reported as degraded, which the inbox client logs.
 */
const InboundPayloadSchema = z.preprocess(
  (value) =>
    value !== null && typeof value === "object" &&
      KNOWN_PAYLOAD_KINDS.has((value as { kind?: unknown }).kind)
      ? value
      : null,
  SystemPayloadSchema.nullable(),
);

/**
 * What `GET /v1/runs/:id/messages` answers: the inbox past the runner's cursor. The text is
 * bounded (the control plane refuses more at its own door) and reaches the agent only inside
 * the platform's framing — never as an instruction.
 */
export const InboundMessageSchema = z.object({
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(["user", "chat", "alert", "system"]),
  sender: MessageSenderSchema,
  text: z.string().max(MAX_LEN),
  payload: InboundPayloadSchema,
  attachments: z.array(AttachmentRefSchema).max(MAX_ATTACHMENTS),
  createdAt: z.string().max(64),
}) satisfies z.ZodType<InboundMessage>;

export const InboundMessagesSchema = z.object({
  messages: z.array(InboundMessageSchema).max(1_000),
}) satisfies z.ZodType<{ messages: InboundMessage[] }>;

/** One message the inbox answer carried that could not be taken as sent. */
export interface InboundDegradation {
  seq: unknown;
  /** Images that do not hold to their schema dropped (the rest kept), `onto` dropped from a
   * patch cue, the payload dropped (the text still delivered), or the whole message taken for
   * its text alone, or replaced by a line saying it could not be read. */
  what: "attachments" | "onto" | "payload" | "message";
  issues: string;
}

/**
 * The inbox answer, message by message, so a control plane a version ahead — or one bad message —
 * can never wedge the inbox: a patch cue whose `onto` is refused loses only that (the runner then
 * infers the branch); a payload that fails its schema (an unknown `state`, say) is dropped and the
 * message still arrives by its text, which is complete on its own; a message that is no message
 * at all takes its place as a line saying so. Each is reported, for the caller to log. The
 * envelope itself is still strict.
 */
export function parseInboundMessages(
  body: unknown,
): { ok: true; messages: InboundMessage[]; degraded: InboundDegradation[] } | {
  ok: false;
  issues: string;
} {
  const envelope = z.object({ messages: z.array(z.unknown()).max(1_000) }).safeParse(body);
  if (!envelope.success) return { ok: false, issues: describeIssues(envelope.error) };
  const messages: InboundMessage[] = [];
  const degraded: InboundDegradation[] = [];
  for (const raw of envelope.data.messages) {
    const parsed = InboundMessageSchema.safeParse(raw);
    if (parsed.success) {
      messages.push(parsed.data);
      continue;
    }
    const sent = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    // Bad images go first, and alone: the ones that hold to their schema stay with the message.
    const images = Array.isArray(sent.attachments)
      ? sent.attachments.filter((a) => AttachmentRefSchema.safeParse(a).success)
        .slice(0, MAX_ATTACHMENTS)
      : [];
    const record: Record<string, unknown> = { ...sent, attachments: images };
    // A control plane from before images sends none: an empty list, and nothing dropped.
    const imagesDropped = sent.attachments !== undefined &&
      (!Array.isArray(sent.attachments) || sent.attachments.length !== images.length);
    const noteImages = (keptAll = true) => {
      if (imagesDropped || (!keptAll && images.length > 0)) {
        degraded.push({ seq: sent.seq, what: "attachments", issues: describeIssues(parsed.error) });
      }
    };
    const payload = record.payload;
    const attempts: Array<[InboundDegradation["what"], unknown]> = [["attachments", record]];
    if (payload !== null && typeof payload === "object" && "onto" in payload) {
      const { onto: _dropped, ...rest } = payload as Record<string, unknown>;
      attempts.push(["onto", { ...record, payload: rest }]);
    }
    attempts.push(["payload", { ...record, payload: null }]);
    let taken = false;
    for (const [what, attempt] of attempts) {
      const again = InboundMessageSchema.safeParse(attempt);
      if (!again.success) continue;
      messages.push(again.data);
      noteImages();
      if (what !== "attachments") {
        degraded.push({ seq: record.seq, what, issues: describeIssues(parsed.error) });
      }
      taken = true;
      break;
    }
    if (taken) continue;
    // Not a message this runner can read as sent (a kind or a sender a newer control plane
    // speaks). With a seq it still takes its place — the cursor moves past it, and no poll keeps
    // answering it: its own text and its valid images when the text is a bounded string, else a
    // line saying it could not be read — either way framed as from a sender this runner cannot
    // identify, never as the platform's. With no seq it cannot be placed, and the answer is
    // malformed.
    const seq = InboundMessageSchema.shape.seq.safeParse(record.seq);
    if (!seq.success) return { ok: false, issues: describeIssues(parsed.error) };
    const text = InboundMessageSchema.shape.text.safeParse(record.text);
    const createdAt = InboundMessageSchema.shape.createdAt.safeParse(record.createdAt);
    const readable = text.success && text.data.trim() !== "";
    messages.push({
      seq: seq.data,
      kind: "system",
      // Never `platform`: a placeholder must not pass for the platform's word (a verdict hold
      // takes a platform message as its turn).
      sender: { kind: "unidentified" },
      text: readable ? text.data : "A message arrived that this runner could not read.",
      payload: null,
      attachments: readable ? images : [],
      createdAt: createdAt.success ? createdAt.data : "",
    });
    // A placeholder carries none of the message's images: their dropping is said too.
    noteImages(readable);
    degraded.push({ seq: record.seq, what: "message", issues: describeIssues(parsed.error) });
  }
  return { ok: true, messages, degraded };
}

/**
 * The harness layer's manifest, `/opt/ryph/harness.json` (images/harness/Dockerfile): what the
 * layer this runner shipped in carries. Read at boot so a run whose harness kind the layer does
 * not carry is refused by name, instead of failing mid-harness on a binary that is not there.
 * Keys beyond these are the layer's business (versions, digests) and pass unread.
 */
export const HarnessManifestSchema = z.object({
  runner: singleLine,
  harnessKinds: z.array(
    z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, {
      error: "not a harness kind",
    }),
  ).min(1).max(32),
  builtAt: singleLine,
});

/** The manifest, past the ingest boundary. */
export type HarnessManifest = z.infer<typeof HarnessManifestSchema>;

/** One line per issue, each naming the path that failed: `agent.email: expected string`. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)
    .join("; ");
}
