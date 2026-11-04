// Subjects, audiences and the scope a run is entitled to — the pure half of "an agent cannot
// read another agent's private notes or propose under a repo it is not working on".

import type { Audience, Subject } from "./types.ts";

/**
 * The canonical spelling of a repository, so `https://github.com/Acme/App.git`, `.../acme/app`
 * and `git@github.com:acme/app.git` are one subject. Host and path, lowercased, no scheme, no
 * `.git`, no trailing slash. A local path stays a path, exactly as given.
 */
/**
 * How a repository is named in text a run reads. A `local` repository's address is a path on
 * the host, which is not the agent's to see, so it goes by its folder name; every other
 * address is a URL or an id the agent already holds.
 */
export function repoLabel(url: string): string {
  return url.startsWith("/") ? url.slice(url.lastIndexOf("/") + 1) : url;
}

export function canonicalRepo(url: string): string {
  // A `local` repository's address is its absolute real path, already canonical — the forge
  // resolved it once at connect time, so one repository has one spelling. Nothing about a URL
  // applies to it: on a case-sensitive disk `/srv/App` and `/srv/app` are two repositories, and
  // `/srv/app.git` is a directory of its own, so lower-casing or stripping `.git` would let two
  // repositories share a subject — the boundary that keeps one's notes out of the other. Even
  // edge whitespace is part of the name, so not even a trim.
  if (url.startsWith("/")) return url;
  let s = url.trim();
  // A Radicle repository id is not a URL and not case-insensitive: it is base58, where case is
  // meaning. Lower-casing one produces an id that resolves to nothing, and two repositories
  // that differ only in case would share a subject — which is the boundary that keeps one
  // agent's notes out of another repository.
  if (/^rad:z[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return s;
  const scp = s.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp && !s.includes("://")) s = `${scp[1]}/${scp[2]}`;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^[^@/]+@/, ""); // userinfo
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  return s.toLowerCase();
}

export function repoSubject(url: string): Subject {
  return { kind: "repo", url: canonicalRepo(url) };
}

export const ORG: Subject = { kind: "org" };
export const EVERYONE: Audience = { kind: "all" };

export function sameSubject(a: Subject, b: Subject): boolean {
  return a.kind === "org" ? b.kind === "org" : b.kind === "repo" && a.url === b.url;
}

export function sameAudience(a: Audience, b: Audience): boolean {
  return a.kind === "all" ? b.kind === "all" : b.kind === "agent" && a.agentId === b.agentId;
}

/** A subject as a stable string key — for maps, topic-index lines and the UI's filter. */
export function subjectKey(s: Subject): string {
  return s.kind === "org" ? "org" : `repo:${s.url}`;
}

export function audienceKey(a: Audience): string {
  return a.kind === "all" ? "all" : `agent:${a.agentId}`;
}

/** The inverse of subjectKey; null for anything that is not one. */
export function parseSubjectKey(key: string): Subject | null {
  if (key === "org") return ORG;
  if (key.startsWith("repo:") && key.length > "repo:".length) {
    return { kind: "repo", url: canonicalRepo(key.slice("repo:".length)) };
  }
  return null;
}

export function parseAudienceKey(key: string): Audience | null {
  if (key === "all") return EVERYONE;
  if (key.startsWith("agent:") && key.length > "agent:".length) {
    return { kind: "agent", agentId: key.slice("agent:".length) };
  }
  return null;
}

/** What a run may read and write: the subjects it works on, for the audiences it belongs to. */
export interface RunScope {
  agentId: string;
  /** Only this agent's audience; shared memories are outside the scope. */
  agentOnly?: boolean;
  /** The run's repos, canonical, in checkout order. Empty when the run has no repo subject. */
  repos: string[];
}

export function subjectsOf(scope: RunScope): Subject[] {
  return [ORG, ...scope.repos.map((url): Subject => ({ kind: "repo", url }))];
}

/** The run's repo subjects alone — what "only about my repositories" narrows a search to. */
export function repoSubjectsOf(scope: RunScope): Subject[] {
  return scope.repos.map((url): Subject => ({ kind: "repo", url }));
}

export function audiencesOf(scope: RunScope): Audience[] {
  const own: Audience = { kind: "agent", agentId: scope.agentId };
  return scope.agentOnly ? [own] : [EVERYONE, own];
}

export function inScope(scope: RunScope, subject: Subject, audience: Audience): boolean {
  return subjectsOf(scope).some((s) => sameSubject(s, subject)) &&
    audiencesOf(scope).some((a) => sameAudience(a, audience));
}

export type SubjectResolution =
  | { kind: "ok"; subject: Subject }
  /** No subject fits: the reason, written for the agent that asked. */
  | { kind: "none"; reason: string };

/**
 * A tool argument's `subject` — "org" or "repo" — resolved within the run's scope, with `repo`
 * naming WHICH repository when the run holds several. The agent can only narrow within its
 * scope, never name a repo outside it: `repo` is matched against the run's own repos, by the
 * canonical URL or by the `owner/name` the checkout calls it. With one repo the name is
 * implied; with several and none named, a repo claim is refused rather than guessed, because
 * filing a fact under the wrong repository is worse than asking again.
 */
export function resolveSubjectHint(
  scope: RunScope,
  hint: "org" | "repo" | undefined,
  repo?: string,
): SubjectResolution {
  if (hint === "org") return { kind: "ok", subject: ORG };
  if (repo !== undefined && repo.trim() !== "") {
    const found = matchRepo(scope, repo);
    if (found === null) {
      return {
        kind: "none",
        reason: scope.repos.length === 0
          ? "this run works on no repository, so it cannot name one"
          : `this run does not hold "${repo}"; it holds: ${scope.repos.map(repoLabel).join(", ")}`,
      };
    }
    return { kind: "ok", subject: { kind: "repo", url: found } };
  }
  if (scope.repos.length === 0) {
    return hint === "repo"
      ? {
        kind: "none",
        reason: "this run works on no repository, so it cannot propose a repo memory",
      }
      : { kind: "ok", subject: ORG };
  }
  if (scope.repos.length === 1) {
    return { kind: "ok", subject: { kind: "repo", url: scope.repos[0] } };
  }
  return {
    kind: "none",
    reason: `this run holds several repositories — say which with \`repo\`: ${
      scope.repos.map(repoLabel).join(", ")
    }`,
  };
}

/** The run's repo a hint names: its canonical URL, or its `owner/name` as the checkout calls it. */
export function matchRepo(scope: RunScope, hint: string): string | null {
  const wanted = canonicalRepo(hint);
  const exact = scope.repos.find((url) => url === wanted);
  if (exact !== undefined) return exact;
  // A local repository answers to its folder name exactly as spelled on disk: the name it is
  // shown by, and case matters there.
  const byName = scope.repos.filter((url) =>
    url.startsWith("/") ? repoLabel(url) === hint.trim() : url.endsWith(`/${wanted}`)
  );
  return byName.length === 1 ? byName[0] : null;
}

export function resolveAudienceHint(
  scope: RunScope,
  hint: "all" | "agent" | undefined,
): Audience {
  return scope.agentOnly || hint === "agent" ? { kind: "agent", agentId: scope.agentId } : EVERYONE;
}
