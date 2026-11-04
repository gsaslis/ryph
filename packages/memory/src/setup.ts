// The package's startup contract for the mounted deployment: one call builds every half — the
// management routes, the orchestrator-facing access object, the MCP data handler the gateway
// forwards to, and the consolidator the composition root ticks — over the ONE store the root
// provides. No env reads, no sockets, no timers: the root owns those.

import { makeServiceGate, mintId, sha256Hex } from "@ryph/sealed";
import { json, type Route } from "@ryph/shared/http";
import { repoFileFetcher } from "./adapters/fetch/repo_file.ts";
import { urlFetcher } from "./adapters/fetch/url.ts";
import {
  type ConsolidateStats,
  makeMemoryService,
  type MemoryDiag,
  type MemoryService,
} from "./core/service.ts";
import { makeMemoryDataHandler } from "./http/data.ts";
import { internalMemoryRoutes } from "./http/internal.ts";
import { memoryRoutes } from "./http/routes.ts";
import type { Authenticate } from "@ryph/auth/gates";
import type { Embedder } from "./ports/embedder.ts";
import type { ModelClient } from "./ports/model.ts";
import type { MemoryStore } from "./ports/store.ts";

export interface MemorySetupDeps {
  store: MemoryStore;
  /** The user-surface gate for the management routes, provided by the mounting host. */
  authenticate: Authenticate;
  /**
   * The credential the MCP gateway presents on the data route (RYPH_MEMORY_GATEWAY_TOKEN).
   * Null: the data route refuses everything — no gateway can reach the tools.
   */
  gatewayToken: string | null;
  /**
   * The credential a REMOTE orchestrator presents on the internal surface (RYPH_MEMORY_TOKEN).
   * Null: the internal routes are not built — the single process holds `access` directly.
   */
  serviceToken?: string | null;
  /**
   * The platform's model, for the consolidator's judgement and the ingest extractor. Null: the
   * trivial consolidator and a pointer-only ingest, both saying so. The root builds it over the
   * model proxy with a platform credential — in-process from the proxy's issuer, or over HTTP
   * from its internal platform route.
   */
  model?: ModelClient | null;
  /** Embeddings for hybrid search. Null: full-text only (RYPH_MEMORY_EMBEDDINGS=off). */
  embedder?: Embedder | null;
  /** The deployment's GitLab instance (RYPH_GITLAB_URL), whose repo files an ingest may read
   * beside gitlab.com's and GitHub's. Null or absent: gitlab.com alone. */
  gitlabUrl?: string | null;
  now(): Date;
  diag: MemoryDiag;
}

export interface MemorySetup {
  service: MemoryService;
  /** The management surface, for the host's route table. */
  routes: Route[];
  /** The service-authed surface a remote orchestrator dials; empty without a service token. */
  internalRoutes: Route[];
  /**
   * The MCP data handler: answers the memory MCP path, null for any other. The gateway's
   * platform entry dials this — in-process under the single binary, over HTTP standalone.
   */
  dataHandler: (req: Request) => Promise<Response | null>;
  /** One consolidation pass; the root ticks it on an interval. */
  consolidate(): Promise<ConsolidateStats>;
  /** One embeddings backfill batch; the root ticks it while `remaining` is positive. */
  backfillEmbeddings(): Promise<{ embedded: number; remaining: number }>;
  /** Once at boot: an extraction the last process died under is marked failed. */
  recoverIngests(): Promise<number>;
  /** At shutdown, before the store closes: waits for the extractions running behind ingests,
   * then stops any page conversion still in its worker. */
  drain(): Promise<void>;
}

export function setup(deps: MemorySetupDeps): MemorySetup {
  const url = urlFetcher();
  const service = makeMemoryService({
    store: deps.store,
    now: deps.now,
    diag: deps.diag,
    mintId,
    model: deps.model ?? null,
    embedder: deps.embedder ?? null,
    fetchers: {
      url,
      "repo-file": repoFileFetcher({ gitlabUrl: deps.gitlabUrl ?? null }),
    },
    hash: sha256Hex,
  });
  const gatewayGate = deps.gatewayToken === null
    ? () => Promise.resolve(json(503, { error: "the memory data route has no gateway token" }))
    : makeServiceGate(deps.gatewayToken);
  return {
    service,
    routes: memoryRoutes({
      service,
      authenticate: deps.authenticate,
      now: deps.now,
      diag: deps.diag,
    }),
    internalRoutes: deps.serviceToken
      ? internalMemoryRoutes({
        service,
        authenticate: makeServiceGate(deps.serviceToken),
        diag: deps.diag,
      })
      : [],
    dataHandler: makeMemoryDataHandler({
      service,
      authenticate: gatewayGate,
      now: deps.now,
      diag: deps.diag,
    }),
    consolidate: () => service.consolidate(),
    backfillEmbeddings: () => service.backfillEmbeddings(),
    recoverIngests: () => service.recoverIngests(),
    drain: async () => {
      await service.drain();
      url.close();
    },
  };
}
