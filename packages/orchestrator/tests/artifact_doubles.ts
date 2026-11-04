// An in-memory `ArtifactStore`, the fast double beside memory_store.ts — held to the same
// contract as the drizzle store by tests/artifact_store_test.ts — and an in-process
// `ArtifactHtmlPreparer`, the real sanitizer without its process (whose own suite is
// tests/artifact_html_test.ts).

import {
  type Artifact,
  ARTIFACT_PUBLISH_WINDOW_MS,
  type ArtifactVersionInfo,
  MAX_ARTIFACT_ATTEMPTS_PER_HOUR,
  MAX_ARTIFACT_VERSIONS,
  mayVersion,
} from "../src/core/artifacts.ts";
import { isTerminal } from "../src/core/lifecycle.ts";
import type { ArtifactStore } from "../src/ports/artifact_store.ts";
import type { ArtifactHtmlPreparer } from "../src/ports/artifact_html.ts";
import { prepareArtifactHtml } from "../src/helpers/artifact_html.ts";
import {
  DEFAULT_ARTIFACT_HTML_IN_FLIGHT,
  outcomeOf,
} from "../src/adapters/artifact_html/process_preparer.ts";
import type { TaskStore } from "../src/ports/task_store.ts";

interface Version extends ArtifactVersionInfo {
  html: string;
  servedHtml: string;
  images: Array<{ ref: string; attachmentId: string }>;
}

/** `tasks` is where the run's state is read, as the drizzle store reads it under its lock. */
export function memoryArtifactStore(
  tasks: Pick<TaskStore, "getRun">,
): ArtifactStore & { rows: Map<string, Artifact>; versionRows: Map<string, Version[]> } {
  const rows = new Map<string, Artifact>();
  const versionRows = new Map<string, Version[]>();
  const live = (id: string) => {
    const row = rows.get(id);
    return row !== undefined && row.deletedAt === null ? row : null;
  };
  /** Every run's attempts (the drizzle store's `artifact_publish_attempts`). */
  const attempts = new Map<string, string[]>();
  /** The current version of a live artifact `runId` created, with this title and document. */
  const sameCreated = (runId: string, title: string, html: string) =>
    [...rows.values()]
      .filter((r) => r.originRunId === runId && r.deletedAt === null)
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))
      .find((r) => {
        const head = (versionRows.get(r.id) ?? []).find((v) => v.version === r.currentVersion);
        return head !== undefined && head.title === title && head.html === html;
      }) ?? null;
  return {
    rows,
    versionRows,
    async recordAttempt(runId, at) {
      const run = await tasks.getRun(runId);
      if (run === null || isTerminal(run)) return { kind: "concluded" };
      const since = Date.parse(at) - ARTIFACT_PUBLISH_WINDOW_MS;
      const recent = (attempts.get(runId) ?? []).filter((t) => Date.parse(t) > since).sort();
      if (recent.length >= MAX_ARTIFACT_ATTEMPTS_PER_HOUR) {
        attempts.set(runId, recent);
        const freeing = recent[recent.length - MAX_ARTIFACT_ATTEMPTS_PER_HOUR];
        return {
          kind: "rate_limited",
          retryAt: new Date(Date.parse(freeing) + ARTIFACT_PUBLISH_WINDOW_MS).toISOString(),
        };
      }
      attempts.set(runId, [...recent, at]);
      return { kind: "recorded" };
    },
    createdByRunWith(runId, title, html) {
      const same = sameCreated(runId, title, html);
      return Promise.resolve(same === null ? null : { id: same.id, version: same.currentVersion });
    },
    async publish(input) {
      const run = await tasks.getRun(input.runId);
      if (run === null || isTerminal(run)) return { kind: "concluded" };
      let id = input.newId;
      let version = 1;
      if (input.artifactId === null) {
        const same = sameCreated(input.runId, input.title, input.html);
        if (same !== null) return { kind: "unchanged", id: same.id, version: same.currentVersion };
        rows.set(id, {
          id,
          title: input.title,
          agentId: input.agentId,
          originRunId: input.runId,
          requestedBy: input.requestedBy,
          requestOrigin: input.requestOrigin,
          originChatroomId: input.chatroomId,
          originConversation: input.conversation,
          currentVersion: 1,
          createdAt: input.at,
          updatedAt: input.at,
          deletedAt: null,
        });
      } else {
        const row = live(input.artifactId);
        const existing = versionRows.get(input.artifactId) ?? [];
        if (row === null || !mayVersion(row, existing.map((v) => v.taskId), input)) {
          return { kind: "not_found" };
        }
        id = row.id;
        const head = existing.find((v) => v.version === row.currentVersion);
        if (head !== undefined && head.title === input.title && head.html === input.html) {
          return { kind: "unchanged", id, version: row.currentVersion };
        }
        if (row.currentVersion >= MAX_ARTIFACT_VERSIONS) return { kind: "too_many_versions" };
        version = row.currentVersion + 1;
        rows.set(id, { ...row, title: input.title, currentVersion: version, updatedAt: input.at });
      }
      versionRows.set(id, [...versionRows.get(id) ?? [], {
        version,
        title: input.title,
        runId: input.runId,
        taskId: input.taskId,
        requestedBy: input.requestedBy,
        bytes: input.bytes,
        createdAt: input.at,
        html: input.html,
        servedHtml: input.servedHtml,
        images: [...input.images],
      }]);
      return { kind: "published", id, version, created: input.artifactId === null };
    },
    get(id) {
      return Promise.resolve(live(id));
    },
    versions(id) {
      if (live(id) === null) return Promise.resolve([]);
      return Promise.resolve(
        (versionRows.get(id) ?? []).map((
          { version, title, runId, taskId, requestedBy, bytes, createdAt },
        ) => ({ version, title, runId, taskId, requestedBy, bytes, createdAt })),
      );
    },
    versionContent(id, version) {
      if (live(id) === null) return Promise.resolve(null);
      const row = (versionRows.get(id) ?? []).find((r) => r.version === version);
      return Promise.resolve(
        row === undefined
          ? null
          : { html: row.html, servedHtml: row.servedHtml, images: row.images },
      );
    },
    list({ limit, before }) {
      const sorted = [...rows.values()]
        .filter((r) => r.deletedAt === null)
        .filter((r) =>
          before === null || r.updatedAt < before.updatedAt ||
          (r.updatedAt === before.updatedAt && r.id < before.id)
        )
        .sort((x, y) =>
          y.updatedAt.localeCompare(x.updatedAt) || (y.id < x.id ? -1 : y.id > x.id ? 1 : 0)
        );
      return Promise.resolve(sorted.slice(0, limit));
    },
    delete(id, at) {
      const row = live(id);
      if (row === null) return Promise.resolve(false);
      rows.set(id, { ...row, title: "", deletedAt: at });
      versionRows.delete(id);
      return Promise.resolve(true);
    },
    forRuns(runIds) {
      const wanted = new Set(runIds);
      return Promise.resolve(
        [...rows.values()]
          .filter((r) => r.deletedAt === null)
          .map((artifact) => ({
            artifact,
            versions: (versionRows.get(artifact.id) ?? [])
              .filter((r) => wanted.has(r.runId))
              .map(({ version, runId, createdAt }) => ({ version, runId, createdAt })),
          }))
          .filter((r) => r.versions.length > 0)
          .sort((x, y) =>
            x.artifact.createdAt.localeCompare(y.artifact.createdAt) ||
            x.artifact.id.localeCompare(y.artifact.id)
          ),
      );
    },
  };
}

/** The sanitizer, run on the caller's thread: what the process runs, without the process. The
 * slot rules are the process preparer's (one per owner, `maxInFlight` at once, one by default as in
 * production); `hold` keeps every prepare waiting until it is resolved, so a test can see a slot
 * taken. */
export function inProcessArtifactHtml(
  opts: { maxInFlight?: number } = {},
): ArtifactHtmlPreparer & {
  /** How many documents went into the sanitizer. */
  prepared: () => number;
  /** Holds every later prepare until the returned function is called. */
  hold: () => () => void;
} {
  const owners = new Set<string>();
  let count = 0;
  let gate: Promise<void> | null = null;
  return {
    prepared: () => count,
    hold() {
      let open = () => {};
      gate = new Promise((resolve) => open = resolve);
      return () => {
        gate = null;
        open();
      };
    },
    reserve(owner) {
      if (owners.has(owner)) return { kind: "owner_busy" };
      if (owners.size >= (opts.maxInFlight ?? DEFAULT_ARTIFACT_HTML_IN_FLIGHT)) {
        return { kind: "busy" };
      }
      owners.add(owner);
      let started = false;
      return {
        kind: "slot",
        release() {
          if (!started) owners.delete(owner);
        },
        async prepare(html) {
          started = true;
          count++;
          try {
            if (gate !== null) await gate;
            return outcomeOf(prepareArtifactHtml(html), 0);
          } finally {
            owners.delete(owner);
          }
        },
      };
    },
    close() {},
  };
}
