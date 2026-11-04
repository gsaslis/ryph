import { z } from "zod";
import { apiCall, ApiError } from "./call";
import {
  type ForgeProvider,
  forgeProviderSchema,
  type GithubMode,
  githubModeSchema,
  type GitlabMode,
  gitlabModeSchema,
  type RadicleIdentity,
  radicleIdentitySchema,
  type RadicleMode,
  radicleModeSchema,
} from "./types";

/** The forges this deployment serves, and how it is on GitHub, GitLab and Radicle when they are
 * among them. */
export interface Forges {
  providers: ForgeProvider[];
  github: GithubMode | null;
  /** Present exactly when `providers` lists `gitlab`. */
  gitlab: GitlabMode | null;
  radicle: RadicleMode | null;
}

/**
 * Which forges this deployment serves, and whether its GitHub is an App or one person's token.
 * GitHub alone is the ordinary answer — a Radicle node is an optional platform service — and
 * every screen that would otherwise offer a choice reads this rather than a build flag.
 */
export async function getForges(f = fetch): Promise<Forges> {
  const res = await apiCall(f, "/v1/forge-providers");
  return z.object({
    providers: z.array(forgeProviderSchema),
    github: githubModeSchema.nullable(),
    gitlab: gitlabModeSchema.nullable(),
    radicle: radicleModeSchema.nullable().default(null),
  }).refine((f) => (f.gitlab !== null) === f.providers.includes("gitlab"), {
    message: "gitlab is described exactly when it is listed",
    path: ["gitlab"],
  }).parse(res);
}

/** `getForges`, for the screens that only ask which forges there are. */
export async function getForgeProviders(f = fetch): Promise<ForgeProvider[]> {
  return (await getForges(f)).providers;
}

/** The login a user-mode deployment acts as on GitHub; null in App mode or without GitHub. */
export function githubUserLogin(forges: Pick<Forges, "github"> | null): string | null {
  return forges?.github?.mode === "user" ? forges.github.login : null;
}

/** Whether Radicle here is one person's own node and identity, so every patch is signed as them. */
export function radicleUserMode(forges: Pick<Forges, "radicle"> | null): boolean {
  return forges?.radicle?.mode === "user";
}

/**
 * ryph's own Radicle node: the DID it signs as, and the commands a maintainer runs to follow it.
 * Null when this deployment has no node — the caller decides whether that is worth saying.
 */
export async function getRadicleIdentity(f = fetch): Promise<RadicleIdentity | null> {
  try {
    return radicleIdentitySchema.parse(await apiCall(f, "/v1/radicle/identity"));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Is this a repository address a browser can actually open?
 *
 * A connected repo's `url` is a web address on GitHub and nothing at all on Radicle: a RID is
 * not a URL, and a deployment with no explorer has no page for the repository to link to. An
 * `href` built from anything else is a link that goes nowhere, so a screen asks this before it
 * renders one.
 */
export function isWebLink(url: string | null | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//.test(url);
}
