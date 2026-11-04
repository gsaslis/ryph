// A remote Ryph owns execution policy. Only this adapter sees its PAT; requests carry a
// short-lived access token, never redirects, and bundles are opened anew for a 401 retry.
import { z } from "@zod/zod";
import { bundleKeyOf, MAX_CHECK_LOG_BYTES, MAX_OWN_PODS } from "../../core/check_types.ts";
import type { RemoteChecksConfig } from "../../core/remote_checks_config.ts";
import { SIZE_CLASS_NAME } from "../../core/run_sizes.ts";
import type { ConnectedRepo } from "../../core/types.ts";
import { RemoteChecksError } from "../../ports/remote_checks.ts";
import type {
  RemoteCheckReference,
  RemoteChecks,
  RemoteCheckSnapshot,
} from "../../ports/remote_checks.ts";

const id = z.string().regex(/^[a-z]+-[a-z0-9]{1,64}$/);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const checkName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
const sizeClassName = z.string().regex(SIZE_CLASS_NAME);
const text = z.string().max(65_536);
const nullableText = text.nullable();
const resultSchema = z.object({
  suiteId: id,
  generation: z.number().int().positive(),
  name: checkName,
  state: z.enum([
    "queued",
    "running",
    "passed",
    "failed",
    "timed_out",
    "setup_failed",
    "error",
    "cancelled",
  ]),
  exitCode: z.number().int().nullable(),
  startedAt: nullableText,
  finishedAt: nullableText,
  logKey: nullableText,
  logTail: nullableText,
  watchedChanged: z.boolean().nullable(),
  forgeRef: nullableText,
  inheritedFrom: nullableText,
});
const suiteSchema = z.object({
  remote: z.null().optional(),
  id,
  connectedRepoId: id,
  commit: sha,
  checksRef: text,
  checksCommit: sha,
  checksBlob: sha,
  checksPath: text,
  definition: z.object({
    setup: z.array(z.object({ run: text })).max(32),
    checks: z.array(
      z.object({
        name: checkName,
        run: text,
        timeoutSeconds: z.number().int().positive().nullable(),
        services: z.array(text).max(32),
        watch: z.array(text).max(32),
        pod: z.literal("own").optional(),
        size: sizeClassName.optional(),
      }).refine((c) => c.size === undefined || c.pod === "own", "size only with pod: own"),
    )
      .max(32)
      .refine(
        (checks) => checks.filter((c) => c.pod === "own").length <= MAX_OWN_PODS,
        `at most ${MAX_OWN_PODS} checks with pod: own`,
      ),
    keep: z.array(text).max(32).optional(),
    partial: z.literal(true).optional(),
  }),
  environmentKey: text,
  inputsKey: text,
  networkScope: z.object({}).passthrough(),
  environmentId: nullableText,
  image: nullableText,
  services: z.array(z.object({}).passthrough()).max(32),
  source: z.object({ branchName: text, baseRef: text }).passthrough(),
  state: z.enum(["waiting", "queued", "running", "passed", "failed", "error", "cancelled"]),
  generation: z.number().int().positive(),
  reason: nullableText,
  attempts: z.number().int().nonnegative(),
  ryphChanged: z.boolean().nullable(),
  leaseUntil: nullableText,
  waitingSince: nullableText,
  nextAttemptAt: nullableText,
  launchedAt: nullableText,
  finishedAt: nullableText,
  createdAt: text,
  updatedAt: text,
});
const fileSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    text,
    path: z.enum([".ryph/checks.yml", ".ryph/checks.yaml"]),
    commit: sha,
    blob: sha,
    ryphTree: sha.nullable(),
    dockerfile: z.boolean(),
    services: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("file"), text }),
      z.object({ kind: z.literal("absent") }),
      z.object({ kind: z.literal("invalid"), detail: text }),
    ]),
  }),
  z.object({ kind: z.literal("absent"), commit: sha }),
  z.object({ kind: z.literal("invalid"), commit: sha.nullable(), detail: text }),
  z.object({ kind: z.literal("unavailable"), detail: text }),
]);
const snapshotSchema = z.object({
  requestId: id,
  suite: suiteSchema.nullable(),
  results: z.array(resultSchema).max(32),
  note: text.optional(),
  refused: z.boolean().optional(),
});

export { RemoteChecksError };

async function boundedText(res: Response, max: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        await reader.cancel();
        throw new RemoteChecksError(0, "remote checks response exceeded its size limit");
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new RemoteChecksError(
      0,
      "remote checks response could not be read within its size limit",
    );
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The forge host a repo is on, sent as `?host=` beside its address exactly as `ryph check` sends
 * its remote's: `owner/name` can be connected on GitHub and on GitLab at once, and the receiver
 * refuses such an address without a host (409) rather than guess. github.com for GitHub; for
 * GitLab, the host of the project's URL, which is this deployment's GitLab instance. Absent for
 * any other forge, whose addresses never collide with those two.
 */
export function repoHost(repo: Pick<ConnectedRepo, "provider" | "url">): string | null {
  if (repo.provider === "github") return "github.com";
  if (repo.provider !== "gitlab") return null;
  try {
    return new URL(repo.url).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function remoteChecksClient(config: RemoteChecksConfig, options: {
  readBundle(key: string): Promise<ReadableStream<Uint8Array> | null>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): RemoteChecks {
  const endpoint = config.url.replace(/\/+$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeout = options.timeoutMs ?? 120_000;
  let access: { token: string; expires: number } | null = null;
  let exchanging: Promise<string> | null = null;
  const fetchRemote = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetcher(`${endpoint}/api${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new RemoteChecksError(0, "could not reach the remote checks instance");
    }
  };
  const json = async (res: Response): Promise<unknown> => {
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new RemoteChecksError(res.status, `remote checks request refused (HTTP ${res.status})`);
    }
    try {
      return JSON.parse(await boundedText(res, 2 * 1024 * 1024));
    } catch {
      throw new RemoteChecksError(0, "remote checks returned an invalid response");
    }
  };
  const exchange = async (): Promise<string> => {
    if (access && access.expires > Date.now()) return access.token;
    if (exchanging) return await exchanging;
    exchanging = (async () => {
      const answer = z.object({
        accessToken: z.string().min(1).max(16_384),
        expiresIn: z.number().positive(),
      })
        .safeParse(
          await json(
            await fetchRemote("/v1/auth/token", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ token: config.token }),
            }),
          ),
        );
      if (!answer.success) {
        throw new RemoteChecksError(0, "remote checks token exchange was invalid");
      }
      access = {
        token: answer.data.accessToken,
        expires: Date.now() + Math.max(0, answer.data.expiresIn - 30) * 1000,
      };
      return access.token;
    })();
    try {
      return await exchanging;
    } finally {
      exchanging = null;
    }
  };
  const send = async (
    method: string,
    path: string,
    body?: () => Promise<BodyInit>,
    contentType?: string,
  ): Promise<Response> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await exchange();
      let payload: BodyInit | undefined;
      try {
        payload = await body?.();
      } catch {
        throw new RemoteChecksError(0, "could not prepare the commit for remote checks");
      }
      const res = await fetchRemote(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(contentType ? { "content-type": contentType } : {}),
        },
        body: payload,
        ...(payload instanceof ReadableStream ? { duplex: "half" } : {}),
      } as RequestInit);
      if (res.status !== 401 || attempt === 1) return res;
      await res.body?.cancel().catch(() => {});
      if (payload instanceof ReadableStream) await payload.cancel().catch(() => {});
      access = null;
    }
    throw new RemoteChecksError(401, "remote checks token was refused");
  };
  const matches = (remote: RemoteCheckReference) => {
    if (remote.endpoint !== endpoint) {
      throw new RemoteChecksError(0, "this suite belongs to a different remote checks instance");
    }
  };
  const read = async (remote: RemoteCheckReference): Promise<RemoteCheckSnapshot> => {
    matches(remote);
    const parsed = snapshotSchema.safeParse(
      await json(
        await send("GET", `/v1/check-delegations/${encodeURIComponent(remote.requestId)}`),
      ),
    );
    if (!parsed.success || parsed.data.requestId !== remote.requestId) {
      throw new RemoteChecksError(0, "remote checks returned an invalid delegation snapshot");
    }
    const snapshot = parsed.data as unknown as RemoteCheckSnapshot;
    if (
      snapshot.results.some((r) =>
        r.suiteId !== snapshot.suite?.id || r.generation !== snapshot.suite?.generation
      ) ||
      new Set(snapshot.results.map((r) => r.name)).size !== snapshot.results.length ||
      snapshot.results.some((r) =>
        !snapshot.suite?.definition.checks.some((c) => c.name === r.name)
      )
    ) {
      throw new RemoteChecksError(0, "remote checks returned inconsistent results");
    }
    return snapshot;
  };
  return {
    endpoint,
    async readChecksFile(repo, ref) {
      try {
        const query = new URLSearchParams({ repo: repo.repoRef, base: ref });
        const host = repoHost(repo);
        if (host !== null) query.set("host", host);
        const parsed = fileSchema.safeParse(
          await json(await send("GET", `/v1/check-delegations/declaration?${query}`)),
        );
        return parsed.success
          ? parsed.data
          : { kind: "unavailable", detail: "remote checks returned an invalid declaration" };
      } catch {
        return { kind: "unavailable", detail: "could not read checks from the remote instance" };
      }
    },
    async submit({ request, repo }) {
      // A run's or a person's ask of a failed suite retries its failures there as it would here;
      // a patch's or a push's only reads the answer, so it says nothing and the remote keeps it.
      const retryFailed = request.kind === "tool" || request.kind === "local";
      const common = {
        repo: repo.repoRef,
        branch: request.source.branchName,
        base: request.checksRef,
        delegationId: request.id,
        ...(request.source.checks ? { checks: request.source.checks } : {}),
        ...(retryFailed ? { retryFailed: true as const } : {}),
      };
      const host = repoHost(repo);
      const key = bundleKeyOf(request.source);
      let res: Response;
      if (key === null) {
        res = await send(
          "POST",
          `/v1/check-delegations${host === null ? "" : `?${new URLSearchParams({ host })}`}`,
          () => Promise.resolve(JSON.stringify({ ...common, commit: request.commit })),
          "application/json",
        );
      } else {
        const query = new URLSearchParams({
          repo: common.repo,
          branch: common.branch,
          base: common.base,
          delegationId: common.delegationId,
        });
        if (retryFailed) query.set("retryFailed", "true");
        if (host !== null) query.set("host", host);
        for (const name of common.checks ?? []) query.append("check", name);
        res = await send("POST", `/v1/check-delegations/bundle?${query}`, async () => {
          const stream = await options.readBundle(key);
          if (stream === null) {
            throw new RemoteChecksError(
              404,
              "the commit's bundle is no longer available for remote checks",
            );
          }
          return stream;
        }, "application/octet-stream");
      }
      // A refused ask still has a durable receiver request. Read that record to distinguish
      // 'no checks' from a transport failure; other non-success statuses remain transport errors.
      if (res.status === 422) res = new Response(res.body, { status: 200 });
      const answer = z.object({ request: z.object({ id }) }).safeParse(await json(res));
      if (!answer.success) {
        throw new RemoteChecksError(0, "remote checks returned an invalid request identity");
      }
      return await read({ endpoint, requestId: answer.data.request.id, suiteId: null });
    },
    read,
    async cancel(remote) {
      matches(remote);
      const res = await send(
        "DELETE",
        `/v1/check-delegations/${encodeURIComponent(remote.requestId)}`,
      );
      if (res.status === 404 || res.status === 204) {
        await res.body?.cancel().catch(() => {});
        return;
      }
      await json(res);
    },
    async log(remote, generation, name) {
      matches(remote);
      if (remote.suiteId === null) return null;
      const query = new URLSearchParams({ generation: String(generation), check: name });
      const res = await send(
        "GET",
        `/v1/check-suites/${encodeURIComponent(remote.suiteId)}/log?${query}`,
      );
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      if (!res.ok) {
        await json(res);
        return null;
      }
      return await boundedText(res, MAX_CHECK_LOG_BYTES);
    },
  };
}
