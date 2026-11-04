// Assembles the forge's doors into one pure handler. Everything the handlers need arrives
// as AppDeps — no globals, no env reads — so a test builds the whole gateway from fakes (or
// real adapters on temp dirs) and drives it with plain Request objects.
//
// Mounted: doors ① (git wire protocol, read-only) and ② (bundle intake) always; ③'s inward
// face (the orchestrator-driven service surface) when the forge registries and the service token
// are given — each provider's own connect routes (GitHub's, GitLab's, Radicle's, local's) answer
// 501 where that provider is not configured; ⑤ (the agents' tool surface, reached through the
// mcp-gateway) only when a forge is configured AND the gateway has a credential to present.

import type { KeyStore } from "../ports/key_store.ts";
import type { RepoCache } from "../ports/repo_cache.ts";
import type { PatchStore } from "../ports/patch_store.ts";
import type { ForgeRegistry } from "../ports/forge_api.ts";
import type { ChangeTransportRegistry } from "../ports/change_transport.ts";
import type { GithubAppApi, GithubUserApi } from "../ports/github_app.ts";
import type { RadicleBridgeApi } from "../ports/radicle_bridge.ts";
import type { GitlabConnectApi } from "../ports/gitlab.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { RunImages } from "../ports/run_images.ts";
import { makeRouter, type Route } from "@ryph/shared/http";
import { gitRoutes } from "./git.ts";
import { patchRoutes } from "./patches.ts";
import { serviceRoutes } from "./service.ts";
import { toolRoutes } from "./tools.ts";
import type { ToolService } from "../core/tool_service.ts";

export interface AppConfig {
  /** Hard cap on an upload-pack request body (inflated). ~50 B/ref: the 10 MiB default
   * matches git http-backend's and breaks only above ~209k refs — a conscious number. */
  maxUploadPackBytes: number;
  /** Hard cap on an uploaded bundle. */
  maxBundleBytes: number;
  /** Where intake stages bundles before validation; swept by the composition root on boot. */
  stagingDir: string;
  /** How long one merge containment read may take; 90 s by default (service.ts). */
  mergeContainmentBudgetMs?: number;
}

export interface AppDeps {
  keys: KeyStore;
  cache: RepoCache;
  patches: PatchStore;
  diag: Diagnostics;
  /** Door ③'s API clients, one per forge a connected repo may name. Null: no forge is
   * configured — the service surface is dark. */
  forges?: ForgeRegistry | null;
  /** How a bundle becomes a change request, one per forge. Required alongside `forges`. */
  transports?: ChangeTransportRegistry | null;
  /** GitHub's own connect surface — installations and OAuth. Null when no App is configured,
   * which includes a forge in GitHub user mode. */
  githubApp?: GithubAppApi | null;
  /** GitHub user mode's connect surface — the token's login and the repos it reaches. Null
   * unless the forge acts as one person; never set together with `githubApp`. */
  githubUser?: GithubUserApi | null;
  /** Radicle's own connect surface — seeding and identity documents. Null when no bridge is
   * configured (RYPH_RADICLE_URL unset). */
  radicle?: RadicleBridgeApi | null;
  /** GitLab's connect surface — the mode, projects, OAuth and webhook tokens. Null when no
   * GitLab is configured (no RYPH_GITLAB_* set). */
  gitlab?: GitlabConnectApi | null;
  /** RYPH_LOCAL_REPO_ROOT, real or not: the directory a `local` repo must resolve inside. Null
   * or absent: the local provider is off, and its describe route answers 501. */
  localRoot?: string | null;
  /** Where the image refs in a body the orchestrator sends (`runId` set) are resolved. Null or
   * absent: such a body is refused. */
  images?: RunImages | null;
  /** The shared service credential the orchestrator presents. Required to mount door ③. */
  serviceToken?: string | null;
  /** Door ⑤: the tool service, and the credential the mcp-gateway presents to reach it
   * (RYPH_FORGE_GATEWAY_TOKEN). Null: the tool surface is dark. */
  tools?: { service: ToolService; gatewayToken: string } | null;
  config: AppConfig;
  /** The clock, in epoch milliseconds; `Date.now` unless a test drives it. */
  now?: () => number;
}

export function makeHandler(
  deps: AppDeps,
  extraRoutes: Route[] = [],
): (req: Request) => Promise<Response> {
  return makeRouter([
    ...extraRoutes,
    ...gitRoutes(deps),
    ...patchRoutes(deps),
    ...(deps.forges && deps.transports && deps.serviceToken
      ? serviceRoutes(
        deps,
        deps.serviceToken,
        deps.forges,
        deps.transports,
        { app: deps.githubApp ?? null, user: deps.githubUser ?? null },
        deps.radicle ?? null,
        deps.localRoot ?? null,
        deps.gitlab ?? null,
      )
      : []),
    ...(deps.tools
      ? toolRoutes({ service: deps.tools.service, diag: deps.diag }, deps.tools.gatewayToken)
      : []),
  ]);
}
