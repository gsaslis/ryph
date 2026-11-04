// `ChangeTransport` on Radicle: verify the bundle exactly as the GitHub transport does, then
// hand the bytes to the node's bridge, which does the one thing only a process sharing the
// node's volume can — `git push rad`.
//
// The verification is not skipped because the bridge repeats it. It is the PROVENANCE ANCHOR:
// this side holds the head intake recorded, and checking it where the bytes leave is the
// invariant the port names. The bridge's own check is against the same claim, one trust
// boundary further on.
//
// Invariants (the port's, kept here):
// - the head that leaves is checked against the head intake recorded, BEFORE the upload
// - delivering the same bundle twice converges on one change request: with `existingRef` the
//   bridge answers `created: false` for an identical head rather than writing a second
//   revision, and without one there is nothing to collide with — a Radicle change request has
//   no branch identity to adopt
// - terminality is named on every failure: a 4xx from the bridge is a refusal about THIS
//   bundle, a 5xx or a dead socket is a neighbour restarting

import { type FileHandle, open } from "node:fs/promises";
import type {
  ChangeDelivery,
  ChangeDeliveryOutcome,
  ChangeTransport,
} from "../../ports/change_transport.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { RepoCache } from "../../ports/repo_cache.ts";
import { type Git, makeGit } from "../../helpers/git_exec.ts";
import { stageBundle, TerminalSubmitError } from "../../helpers/submit.ts";
import { authorizationValue } from "../repo_cache/local_fs.ts";

export interface RadicleChangeTransportOptions {
  /** `RYPH_RADICLE_URL` — the bridge beside our node. */
  baseUrl: string;
  /** `RYPH_RADICLE_TOKEN`. */
  token: string;
  /** Seeds the base objects from local disk when it holds them — the fast path. */
  cache: RepoCache;
  diag: Diagnostics;
  /** A traced hermetic git; the bridge-credentialed one is derived from it. */
  git?: Git;
  requestTimeoutMs?: number;
}

/** A bundle push is real git over a socket; the generic per-request deadline is not its size. */
const DEFAULT_TIMEOUT_MS = 300_000;

/** How much of the bundle is in memory at a time. */
const CHUNK_BYTES = 64 * 1024;

/**
 * The submission as a `multipart/form-data` STREAM: the `meta` JSON, then the bundle read from
 * disk a chunk at a time, then the closing boundary.
 *
 * Not `FormData` + `Blob`, which would hold a hundred-megabyte bundle in memory, and not a
 * header, for the reason `deliver` gives where it calls this.
 *
 * The descriptor's whole life is in here. `abort` is the caller's only obligation, and only on
 * the path where the body was never sent: every other ending — sent whole, cancelled by the
 * runtime, cancelled by a timeout — closes it through the stream.
 */
function multipartBody(
  metaJson: string,
  bundlePath: string,
): { boundary: string; stream: ReadableStream<Uint8Array>; abort(): Promise<void> } {
  const encoder = new TextEncoder();
  // Random per request, and re-rolled in the (impossible) case that the metadata contains it:
  // `title` and `description` are the agent's words, and a part separator they could spell
  // would let them forge a part.
  let boundary = "";
  do {
    boundary = `ryph${crypto.randomUUID().replaceAll("-", "")}`;
  } while (metaJson.includes(boundary));

  const head = encoder.encode(
    `--${boundary}\r\n` +
      `content-disposition: form-data; name="meta"\r\n` +
      `content-type: application/json\r\n\r\n` +
      `${metaJson}\r\n` +
      `--${boundary}\r\n` +
      `content-disposition: form-data; name="bundle"; filename="change.bundle"\r\n` +
      `content-type: application/octet-stream\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

  let file: FileHandle | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      file?.close().catch(() => {});
    } catch {
      // Already gone; there is nothing a failing close tells anybody here.
    }
  };

  let stage: "head" | "file" | "tail" = "head";
  const buffer = new Uint8Array(CHUNK_BYTES);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stage === "head") {
        file = await open(bundlePath, "r");
        stage = "file";
        controller.enqueue(head);
        return;
      }
      if (stage === "file") {
        const { bytesRead } = await file!.read(buffer, 0, buffer.length, null);
        if (bytesRead > 0) {
          controller.enqueue(buffer.slice(0, bytesRead));
          return;
        }
        close();
        stage = "tail";
        controller.enqueue(tail);
        return;
      }
      controller.close();
    },
    cancel() {
      close();
    },
  });

  return {
    boundary,
    stream,
    abort: async () => {
      close();
      await stream.cancel().catch(() => {});
    },
  };
}

export function radicleChangeTransport(opts: RadicleChangeTransportOptions): ChangeTransport {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const { diag } = opts;
  const gitExec = opts.git ?? makeGit(diag);
  // The base is fetched from the bridge's own git door when the cache cannot seed it, and that
  // door takes the same bearer as everything else here.
  const authedGit = makeGit(diag, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${new URL(base).origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: ${
      authorizationValue({ origin: base, token: opts.token, scheme: "bearer" })
    }`,
  });

  return {
    async deliver(change: ChangeDelivery): Promise<ChangeDeliveryOutcome> {
      const rid = change.repo.repoRef;
      const failed = (message: string, terminal: boolean): ChangeDeliveryOutcome => ({
        kind: "failed",
        message,
        terminal,
      });
      // The RID is not a git URL; the bridge's read-only door is where the base comes from.
      // Derived here rather than carried, for the reason `ForgeApi.upstreamUrl` exists.
      const upstreamUrl = `${base}/v1/repos/${encodeURIComponent(rid)}/git`;

      let staged;
      try {
        staged = await stageBundle({
          upstreamUrl,
          cacheDir: (await opts.cache.find({ url: upstreamUrl }, change.baseBranch))?.dir ?? null,
          baseBranch: change.baseBranch,
          branchName: change.branchName,
          expectedHeadSha: change.headSha,
          bundlePath: change.bundlePath,
          git: gitExec,
          authedGit,
        });
      } catch (err) {
        const terminal = err instanceof TerminalSubmitError;
        diag.warn("transport.stage_failed", { repo: rid, terminal, err: String(err) });
        return failed(
          `verifying the bundle failed: ${err instanceof Error ? err.message : err}`,
          terminal,
        );
      }

      let baseSha: string;
      try {
        // The commit the change asks to merge into: the fork point, not the base branch's tip,
        // which can have moved on while the run worked. Radicle records it on the revision
        // (`patch.base`), and a base the run did not build on would make every diff wrong.
        baseSha = await gitExec(
          staged.dir,
          "merge-base",
          `refs/heads/${change.baseBranch}`,
          staged.headSha,
        );
      } catch (err) {
        await staged.dispose();
        diag.warn("transport.no_merge_base", { repo: rid, err: String(err) });
        return failed(
          `the run's commits do not share a base with ${change.baseBranch}`,
          true,
        );
      }
      await staged.dispose();

      const meta = {
        title: change.title,
        description: change.description,
        baseSha,
        headSha: staged.headSha,
        draft: change.draft,
        ...(change.existingRef === null ? {} : { changeRef: change.existingRef }),
        // The description's images: the bridge stores each as an embed of the revision, which
        // the description already links by blob id. Base64 in the meta part, beside the text.
        ...(change.embeds.length === 0
          ? {}
          : { embeds: change.embeds.map((e) => ({ name: e.name, data: e.bytes.toBase64() })) }),
      };

      // Multipart, and NEVER a header: `title` and `description` are the agent's own words,
      // and a header value is a ByteString. A typographic apostrophe, an em dash or an emoji
      // in a title makes `fetch` throw at construction — which the catch below would report as
      // "the bridge is unreachable", non-terminal, and so retried forever — and a description
      // near its 65_000-character cap outgrows the header block a server will accept, coming
      // back as a bare 400 that reads as terminal. In the body both are simply bytes. The
      // bundle still streams: the parts are assembled as a stream, not a `FormData`.
      const upload = multipartBody(JSON.stringify(meta), change.bundlePath);
      let res: Response;
      try {
        res = await fetch(`${base}/v1/repos/${encodeURIComponent(rid)}/changes`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.token}`,
            "content-type": `multipart/form-data; boundary=${upload.boundary}`,
          },
          body: upload.stream,
          signal: AbortSignal.timeout(opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (err) {
        // The descriptor is closed here and not in a `finally`: on the success path the stream
        // owns it and closes it when the body has been sent. A throw before or during the send
        // leaves it open, and a leaked descriptor per retry is a file table that fills up.
        await upload.abort();
        diag.warn("transport.bridge_unreachable", { repo: rid, err: String(err) });
        return failed(`the Radicle bridge is unreachable: ${err}`, false);
      }

      const body = ((await res.json().catch(() => null)) ?? {}) as {
        ref?: unknown;
        url?: unknown;
        created?: unknown;
        error?: unknown;
      };
      if (res.status !== 200 || typeof body.ref !== "string") {
        const message = typeof body.error === "string"
          ? body.error
          : `the Radicle bridge answered ${res.status}`;
        // A 4xx is about THIS bundle — an unknown change request, a head that does not match,
        // a capability the key does not hold — and no retry re-shapes it. Everything else is
        // the node or its bridge having a bad minute.
        const terminal = res.status >= 400 && res.status < 500 && res.status !== 408 &&
          res.status !== 429;
        diag.warn("transport.bridge_refused", { repo: rid, status: res.status, terminal });
        return failed(message, terminal);
      }

      diag.debug("transport.delivered", {
        repo: rid,
        change: body.ref,
        created: body.created === true,
      });
      // A deployment with no explorer template has no web address for a change request, and
      // the bridge says so with null rather than inventing one.
      return {
        kind: "delivered",
        ref: body.ref,
        url: typeof body.url === "string" ? body.url : "",
      };
    },
  };
}
