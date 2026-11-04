// How the memory pages name things a person reads: a subject by its short repo name and forge, a
// kind or a trust level in words. Pure, so the list and the detail page say the same thing.

import type { ForgeProvider, MemoryKind, MemorySubject, MemoryTrust } from "$lib/api/types";
import { shortenRid } from "$lib/utils/forge";

/** The host of a GitLab instance URL, lowercased as the service spells it, or null. */
export function gitlabHostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A subject as a row shows it. The service spells repos canonically: `github.com/o/r`,
 * `gitlab.com/group/sub/project` (or the deployment's own GitLab host, `gitlabHost`, which the
 * caller passes where it knows it), `rad:…`, or a local repo's absolute path. The forge's host is
 * dropped from the label; any other host stays, so the label never passes for a GitHub address.
 */
export function subjectDisplay(
  subject: MemorySubject | null,
  gitlabHost: string | null = null,
): { label: string; full: string; provider: ForgeProvider | null } {
  if (subject === null) return { label: "The run's repository", full: "", provider: null };
  if (subject.kind === "org") return { label: "Org-wide", full: "The whole org", provider: null };
  const url = subject.url;
  if (url.startsWith("rad:")) return { label: shortenRid(url), full: url, provider: "radicle" };
  if (url.startsWith("/")) return { label: url, full: url, provider: "local" };
  const path = url.replace(/^https?:\/\//, "");
  const host = path.slice(0, path.indexOf("/") === -1 ? path.length : path.indexOf("/"));
  const rest = path.slice(host.length + 1);
  if (host === "github.com") return { label: rest, full: url, provider: "github" };
  if (host === "gitlab.com" || (gitlabHost !== null && host === gitlabHost)) {
    return { label: rest, full: url, provider: "gitlab" };
  }
  return { label: path, full: url, provider: null };
}

export const KIND_LABEL: Record<MemoryKind, string> = {
  fact: "Fact",
  procedure: "Procedure",
  gotcha: "Gotcha",
  decision: "Decision",
  preference: "Preference",
  pointer: "Pointer",
};

export const TRUST_LABEL: Record<MemoryTrust, string> = {
  pinned: "Pinned",
  human: "From a person",
  ingested: "From a document",
  agent: "From an agent",
};

export const STATUS_LABEL = {
  canon: "Canon",
  "needs-verification": "Needs verification",
  retired: "Retired",
} as const;
