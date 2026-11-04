// The bridge's HTTP surface. Internal only, one shared bearer, dialed by the forge alone.
//
// Shape rules, kept everywhere:
// - every answer is JSON, failures included
// - a refusal ABOUT THE INPUT is the caller's 4xx and names why; anything else is a 500 that
//   names nothing and leaves the cause in the diagnostics
// - a `CapabilityError` is a 403 carrying `{error, capability, reason}` — the one refusal an
//   AGENT reads rather than an operator. A missing Radicle permission is not a server fault and
//   must never arrive as one
// - ids in a path may be a full 40-hex COB id or any unique prefix of one; an ambiguous prefix
//   is a 409 naming the ambiguity, never a silent pick

import { mkdir, open, rm } from "node:fs/promises";
import type { RadExec } from "../ports/rad.ts";
import type { NodeControl } from "../ports/node.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import {
  CapabilityError,
  FORGE_CAPABILITY_UNAVAILABLE,
  RefusedError,
  REPO_BLOCKED,
  REPO_UNAVAILABLE,
  RepoBlockedError,
  RepoUnavailableError,
} from "../core/types.ts";
import { NodeUnavailableError } from "../ports/node.ts";
import type { RadicleService, ThreadKind } from "../core/service.ts";
import type { ServiceGate } from "@ryph/sealed";
import { multipartBoundary, MultipartError, readMultipart } from "../helpers/multipart.ts";
import { normalizeRid } from "../helpers/ids.ts";
import { makeTempFile } from "../helpers/temp_file.ts";
import {
  CloseIssueSchema,
  CommentSchema,
  CompareChangeSchema,
  CreateIssueSchema,
  EditCommentSchema,
  LabelsSchema,
  MAX_EMBEDS_JSON,
  ReactionSchema,
  RecordRunSchema,
  ReviewSchema,
  SubmitChangeSchema,
} from "../schema.ts";
import {
  describeIssues,
  json,
  MAX_JSON_BODY_BYTES,
  parseBody,
  type Route,
  route,
} from "@ryph/shared/http";

/** A write that may carry embeds: its text, and up to `MAX_EMBEDS` files base64 beside it. */
const MAX_WRITE_BODY = MAX_JSON_BODY_BYTES + MAX_EMBEDS_JSON;

export interface BridgeConfig {
  /** Where the git gateway's per-repo mirrors live. */
  exportDir: string;
  /** Where an uploaded bundle is spooled before it is verified. */
  scratchDir: string;
  maxBundleBytes: number;
  maxUploadPackBytes: number;
  /** Whether `info/refs` asks the node for a fetch first. */
  fetchBeforeAdvertise: boolean;
  gitFetchTimeoutMs: number;
  /**
   * `info/refs` skips that fetch when the repository was fetched this recently — by the pull,
   * a seed, or an earlier clone. Zero asks every time.
   */
  gitFetchFreshMs: number;
}

/**
 * The header the forge names the mode it was told the bridge runs in. A user-mode bridge
 * refuses to SEED for a forge that says anything else: such a forge reports a deployment's
 * bridge to the control plane, which then lets anyone with `repos:connect` attach a repository
 * that every write is signed for as one person. Fail closed — the forge is the one to fix.
 */
export const BRIDGE_MODE_HEADER = "x-ryph-radicle-mode";

export interface BridgeHttpDeps {
  service: RadicleService;
  node: NodeControl;
  exec: RadExec;
  authenticate: ServiceGate;
  diag: Diagnostics;
  config: BridgeConfig;
  /** Absent: a deployment's. */
  mode?: "deployment" | "user";
}

/**
 * The one place a thrown error becomes a status. Nothing below it needs a try/catch.
 *
 * And the one place a repository OUT OF SCOPE is refused, for every route that names one but
 * the seed pair — which is how a repository comes into scope, and goes out of it. Only a
 * user-mode bridge ever has such a repository: its node holds everything its owner has, private
 * repositories included, and the token that reaches this surface must reach the connected ones
 * and nothing else. A 404, as for a repository the node does not hold at all.
 */
function guarded(routes: Route[], deps: BridgeHttpDeps, scoped = true): Route[] {
  return routes.map((r) => ({
    ...r,
    handler: async (req, params) => {
      const gate = await deps.authenticate(req);
      if (gate) return gate;
      try {
        if (scoped && params.rid !== undefined && !(await deps.service.inScope(ridOf(params)))) {
          return json(404, { error: `${params.rid} is not a repository connected to ryph` });
        }
        return await r.handler(req, params);
      } catch (err) {
        if (err instanceof CapabilityError) {
          return json(403, {
            error: FORGE_CAPABILITY_UNAVAILABLE,
            capability: err.capability,
            reason: err.reason,
          });
        }
        if (err instanceof RepoUnavailableError) {
          // 409 rather than 404: the RID is well formed and the node was asked — what is in
          // conflict is the network's willingness to hand it over. The body carries everything
          // the caller needs to explain BOTH readings of that, including the command a delegate
          // of a private repository would run.
          return json(409, {
            error: REPO_UNAVAILABLE,
            rid: err.rid,
            did: err.did,
            command: `rad id update --allow ${err.did}`,
            seeds: err.seeds,
            triedSeeds: err.triedSeeds,
            reason: err.reason,
          });
        }
        if (err instanceof RepoBlockedError) {
          // The person's own decision about their node: 409, with the command that lifts it.
          return json(409, {
            error: REPO_BLOCKED,
            rid: err.rid,
            command: err.command,
            reason: err.message,
          });
        }
        if (err instanceof NodeUnavailableError) {
          // Not this request's fault and not ours: the node is down, and asking again later is
          // the whole remedy.
          return json(503, { error: "the radicle-node is not reachable" });
        }
        if (err instanceof RefusedError) return json(err.status, { error: err.message });
        deps.diag.warn("radicle.route_failed", {
          method: r.method,
          path: new URL(req.url).pathname,
          err: String(err),
        });
        return json(500, { error: "internal error" });
      }
    },
  }));
}

/** The RID out of a path, normalized. Throws a `RefusedError` the guard turns into a 400. */
function ridOf(params: Record<string, string>): string {
  try {
    return normalizeRid(params.rid);
  } catch {
    throw new RefusedError(`${JSON.stringify(params.rid)} is not a repository id`);
  }
}

/** The cap on the `meta` part. `prBody` is 65_000 characters and a title rides beside it, and
 * so may the description's embeds. */
const MAX_META_BYTES = 256 * 1024 + MAX_EMBEDS_JSON;

/**
 * The bundle and its JSON meta, out of the one accepted framing: `multipart/form-data` with a
 * `bundle` file part and a `meta` JSON part.
 *
 * There used to be a second framing — `application/octet-stream` with the JSON in an
 * `x-ryph-change` header — and it is gone rather than deprecated. A header value is a
 * ByteString: an agent-authored title holding a typographic apostrophe, an em dash or an emoji
 * cannot be put in one at all (the sender throws before a socket is opened), and a long
 * description crosses the 64 KiB a server accepts in a header block and comes back as a bare
 * 400. Both failures land on the caller as "unreachable" or "refused" with no way to tell.
 * Multipart carries the same metadata in the body, where it is just bytes — and it streams
 * here, so nothing was traded for it (`helpers/multipart.ts`).
 */
async function readSubmission(
  req: Request,
  config: BridgeConfig,
): Promise<{ meta: unknown; bundlePath: string }> {
  const boundary = multipartBoundary(req.headers.get("content-type") ?? "");
  if (boundary === null) {
    throw new RefusedError(
      "a submission is multipart/form-data with a `bundle` file part and a `meta` JSON part",
    );
  }
  // The cheap refusal first: a body that ANNOUNCES more than the cap never reaches the parser.
  // A chunked body announces nothing, which is why the parser counts as well.
  const announced = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(announced) && announced > config.maxBundleBytes + MAX_META_BYTES) {
    throw new RefusedError(`the bundle exceeds ${config.maxBundleBytes} bytes`, 413);
  }

  await mkdir(config.scratchDir, { recursive: true });
  const bundlePath = await makeTempFile(config.scratchDir, ".bundle");
  const file = await open(bundlePath, "w");
  let read: { fields: Record<string, string>; fileBytes: number | null };
  try {
    read = await readMultipart(
      req.body,
      boundary,
      "bundle",
      async (chunk) => {
        let offset = 0;
        while (offset < chunk.length) {
          offset += (await file.write(chunk.subarray(offset))).bytesWritten;
        }
      },
      { maxFileBytes: config.maxBundleBytes, maxFieldBytes: MAX_META_BYTES },
    );
  } catch (err) {
    await file.close().catch(() => {});
    await rm(bundlePath).catch(() => {});
    if (err instanceof MultipartError) {
      throw new RefusedError(err.message, err.tooLarge ? 413 : 400);
    }
    throw err;
  } finally {
    // Already closed on the failure path above.
    await file.close().catch(() => {});
  }

  const fail = async (why: string): Promise<never> => {
    await rm(bundlePath).catch(() => {});
    throw new RefusedError(why);
  };
  if (read.fileBytes === null) await fail("the multipart body has no `bundle` file part");
  if (read.fields.meta === undefined) await fail("the multipart body has no `meta` JSON part");
  try {
    return { meta: JSON.parse(read.fields.meta), bundlePath };
  } catch {
    return await fail("the `meta` part is not valid JSON");
  }
}

export function bridgeRoutes(deps: BridgeHttpDeps): Route[] {
  const { service } = deps;

  const thread = (kind: ThreadKind) => kind;

  const routes: Route[] = [
    route("GET", "/v1/identity", async () => json(200, await service.identity())),

    route("GET", "/v1/repos/:rid", async (_req, params) => {
      return json(200, await service.repo(ridOf(params)));
    }),

    // ── issues ──────────────────────────────────────────────────────────────────────────────
    route("GET", "/v1/repos/:rid/issues", async (req, params) => {
      const url = new URL(req.url);
      return json(
        200,
        await service.listIssues(ridOf(params), {
          state: url.searchParams.get("state") ?? undefined,
          labels: url.searchParams.getAll("label"),
          limit: numberParam(url, "limit", 50),
          offset: numberParam(url, "offset", 0),
        }),
      );
    }),

    route("GET", "/v1/repos/:rid/issues/:id", async (_req, params) => {
      return json(200, { issue: await service.getIssue(ridOf(params), params.id) });
    }),

    route("POST", "/v1/repos/:rid/issues", async (req, params) => {
      const body = await parseBody(req, CreateIssueSchema, { maxBytes: MAX_WRITE_BODY });
      if (!body.ok) return body.res;
      return json(201, { issue: await service.createIssue(ridOf(params), body.data) });
    }),

    route("POST", "/v1/repos/:rid/issues/:id/close", async (req, params) => {
      const body = await parseBody(req, CloseIssueSchema, { emptyIs: undefined });
      if (!body.ok) return body.res;
      return json(200, {
        issue: await service.closeIssue(ridOf(params), params.id, body.data?.reason ?? "solved"),
      });
    }),

    // ── change requests ─────────────────────────────────────────────────────────────────────
    route("GET", "/v1/repos/:rid/changes", async (req, params) => {
      const url = new URL(req.url);
      return json(
        200,
        await service.listChanges(ridOf(params), {
          state: url.searchParams.get("state") ?? undefined,
          labels: url.searchParams.getAll("label"),
          limit: numberParam(url, "limit", 50),
          offset: numberParam(url, "offset", 0),
        }),
      );
    }),

    route("GET", "/v1/repos/:rid/changes/:id", async (_req, params) => {
      return json(200, { change: await service.getChange(ridOf(params), params.id) });
    }),

    // The hunks, separately from the change request itself: they run to megabytes on a large
    // change, so a read of the object alone stays cheap. The forge reads them beside the stat
    // when an agent opens a change request (so it learns which lines a remark may anchor to)
    // and again when it checks a review's remarks.
    route("GET", "/v1/repos/:rid/changes/:id/diff", async (_req, params) => {
      return json(200, await service.changeDiff(ridOf(params), params.id));
    }),

    route("GET", "/v1/repos/:rid/changes/:id/compare", async (req, params) => {
      const parsed = CompareChangeSchema.safeParse(
        Object.fromEntries(new URL(req.url).searchParams),
      );
      if (!parsed.success) return json(400, { error: describeIssues(parsed.error) });
      return json(200, await service.compareChange(ridOf(params), params.id, parsed.data));
    }),

    route("POST", "/v1/repos/:rid/changes", async (req, params) => {
      const rid = ridOf(params);
      const { meta, bundlePath } = await readSubmission(req, deps.config);
      try {
        const parsed = SubmitChangeSchema.safeParse(meta);
        if (!parsed.success) return json(400, { error: describeIssues(parsed.error) });
        return json(200, await service.submitChange(rid, { ...parsed.data, bundlePath }));
      } finally {
        await rm(bundlePath).catch(() => {});
      }
    }),

    route("POST", "/v1/repos/:rid/changes/:id/reviews", async (req, params) => {
      const body = await parseBody(req, ReviewSchema, { maxBytes: MAX_WRITE_BODY });
      if (!body.ok) return body.res;
      return json(201, await service.submitReview(ridOf(params), params.id, body.data));
    }),

    // ── jobs (xyz.radworks.job): ryph's check suites, recorded where Radicle looks for CI ─────
    // One run per suite generation, signed by this node.
    route("GET", "/v1/repos/:rid/jobs", async (req, params) => {
      const commit = new URL(req.url).searchParams.get("commit") ?? "";
      if (!/^[0-9a-f]{40}$/.test(commit)) {
        return json(400, { error: "commit: must be a 40-character object id" });
      }
      return json(200, await service.listJobs(ridOf(params), commit));
    }),

    route("POST", "/v1/repos/:rid/jobs/runs", async (req, params) => {
      const body = await parseBody(req, RecordRunSchema);
      if (!body.ok) return body.res;
      // `{recorded: false}`: asked for an existing run only, and there is none.
      return json(200, (await service.recordRun(ridOf(params), body.data)) ?? { recorded: false });
    }),
  ];

  // ── comments, labels: the same two shapes over both thread kinds ──────────────────────────
  for (const [segment, kind] of [["issues", "issue"], ["changes", "change"]] as const) {
    routes.push(
      route(`POST`, `/v1/repos/:rid/${segment}/:id/comments`, async (req, params) => {
        const body = await parseBody(req, CommentSchema, { maxBytes: MAX_WRITE_BODY });
        if (!body.ok) return body.res;
        const created = await service.addComment(
          ridOf(params),
          thread(kind),
          params.id,
          body.data,
        );
        return json(201, { comment: created });
      }),
      route(
        `PATCH`,
        `/v1/repos/:rid/${segment}/:id/comments/:commentId`,
        async (req, params) => {
          const body = await parseBody(req, EditCommentSchema, { maxBytes: MAX_WRITE_BODY });
          if (!body.ok) return body.res;
          return json(200, {
            comment: await service.editComment(
              ridOf(params),
              thread(kind),
              params.id,
              params.commentId,
              body.data,
            ),
          });
        },
      ),
      route(
        `POST`,
        `/v1/repos/:rid/${segment}/:id/comments/:commentId/reactions`,
        async (req, params) => {
          const body = await parseBody(req, ReactionSchema);
          if (!body.ok) return body.res;
          return json(201, {
            reaction: await service.reactToComment(
              ridOf(params),
              thread(kind),
              params.id,
              params.commentId,
              body.data,
            ),
          });
        },
      ),
      // A file the object embeds, base64 in JSON like every other answer here: the forge
      // reads a thread's images through this, and only a file the object itself names.
      route(`GET`, `/v1/repos/:rid/${segment}/:id/embeds/:oid`, async (_req, params) => {
        const embed = await service.readEmbed(ridOf(params), thread(kind), params.id, params.oid);
        return json(200, {
          embed: {
            name: embed.name,
            oid: embed.oid,
            size: embed.bytes.length,
            data: embed.bytes.toBase64(),
          },
        });
      }),
      route(`POST`, `/v1/repos/:rid/${segment}/:id/labels`, async (req, params) => {
        const body = await parseBody(req, LabelsSchema);
        if (!body.ok) return body.res;
        return json(200, {
          labels: await service.addLabels(
            ridOf(params),
            thread(kind),
            params.id,
            body.data.labels,
          ),
        });
      }),
    );
  }

  // How a repository comes into scope and goes out of it, so the scope check is not theirs.
  const seeding: Route[] = [
    route("POST", "/v1/repos/:rid/seed", async (req, params) => {
      if (deps.mode === "user" && req.headers.get(BRIDGE_MODE_HEADER) !== "user") {
        return json(409, {
          error: "bridge_mode_mismatch",
          reason: "this bridge acts as one person (user mode), and the forge calling it was not " +
            "told so — set RYPH_RADICLE_MODE=user on the forge, so connecting a repository is " +
            "held to repos:manage-all",
        });
      }
      return json(200, await service.seed(ridOf(params)));
    }),

    route("DELETE", "/v1/repos/:rid/seed", async (_req, params) => {
      return json(200, await service.unseed(ridOf(params)));
    }),
  ];

  return [...guarded(seeding, deps, false), ...guarded(routes, deps)];
}

function numberParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}
