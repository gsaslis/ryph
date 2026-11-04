// What the GitHub App must be subscribed to and granted, checked against what it is — the
// README's "Permissions" and "Event subscriptions" tables as data, so the forge can say at boot
// what is missing instead of failing silently (an App registered before `Push` was listed got no
// `branch.updated` for weeks, and nothing logged).
//
// Pure: the App's settings and each installation's arrive as facts, so every rule is a table test.
// Two levels are compared because they can disagree. The App is what the owner ticked; an
// installation is what the account it sits on accepted. A new permission is ticked on the App at
// once but only reaches an installation when its account accepts it, and until then the
// installation receives none of the events that ride on it.
//
// Invariants:
// - a gap names what it costs, in the README's words, so the log line is the whole diagnosis
// - required and optional are told apart: a missing optional permission is a feature the
//   deployment does without, not a fault
// - a gap is reported where it can be fixed: the App's own under `app`, and under an installation
//   only what the App has and that account has not accepted, never the App's gaps again
// - extra events are reported, never a fault: the door consumes them unparsed, so they only add
//   mailroom rows nothing acts on. They are the App's to untick, so only `app` lists them

/** GitHub's own levels. `admin` covers `write`, `write` covers `read`. */
export type PermissionLevel = "read" | "write" | "admin";

/** One subscription, as GitHub describes it: on the App itself, or on one installation. */
export interface AppSubscription {
  events: string[];
  permissions: Record<string, string>;
}

export interface InstallationSubscription extends AppSubscription {
  id: string;
  /** The org or user it sits on. */
  account: string;
  accountType: "Organization" | "User";
}

export interface AppSubscriptions {
  app: AppSubscription;
  installations: InstallationSubscription[];
}

interface Need {
  name: string;
  /** What it costs when missing, as the README puts it. */
  spends: string;
  required: boolean;
}

interface PermissionNeed extends Need {
  level: PermissionLevel;
  /** Org permissions mean nothing on a personal account; account permissions live on the App. */
  on: "repo" | "org" | "account";
}

export const REQUIRED_EVENTS: readonly Need[] = [
  { name: "issue_comment", spends: "`/ryph` commands in issue and PR comments", required: true },
  {
    name: "pull_request_review_comment",
    spends: "`/ryph` written inline on a PR's diff",
    required: true,
  },
  {
    name: "pull_request",
    spends: "merged/closed PRs and checks on PR pushes",
    required: true,
  },
  {
    name: "push",
    spends: "default-branch environment builds on push (only the hourly reconcile notices)",
    required: true,
  },
  { name: "check_run", spends: '"Re-run" on ryph\'s check runs', required: true },
  { name: "check_suite", spends: '"Re-run all checks" on ryph\'s check runs', required: true },
];

export const REQUIRED_PERMISSIONS: readonly PermissionNeed[] = [
  {
    name: "contents",
    level: "write",
    on: "repo",
    required: true,
    spends: "fetching bases and pushing a run's branch",
  },
  {
    name: "pull_requests",
    level: "write",
    on: "repo",
    required: true,
    spends: "opening PRs and every PR tool",
  },
  {
    name: "issues",
    level: "write",
    on: "repo",
    required: true,
    spends: "progress comments and every issue tool",
  },
  {
    name: "metadata",
    level: "read",
    on: "repo",
    required: true,
    spends: "the collaborator-permission check",
  },
  {
    name: "checks",
    level: "write",
    on: "repo",
    required: false,
    spends: "posting ryph's checks as check runs, and reading other CI's",
  },
  {
    name: "statuses",
    level: "read",
    on: "repo",
    required: false,
    spends: "reading commit statuses for get_change_request",
  },
  {
    name: "members",
    level: "read",
    on: "org",
    required: false,
    spends: '"members of this org may sign up"',
  },
  {
    name: "email_addresses",
    level: "read",
    on: "account",
    required: false,
    spends: "matching a sign-in to verified addresses",
  },
];

export interface SubscriptionGap {
  kind: "event" | "permission";
  name: string;
  /** For a permission: the level needed, and the one held ("none" when absent). */
  need?: PermissionLevel;
  have?: string;
  required: boolean;
  spends: string;
}

export interface SubscriptionReport {
  /** `app`, or `installation <id> (<account>)`. */
  scope: string;
  gaps: SubscriptionGap[];
  /** Events subscribed to that nothing acts on. */
  extraEvents: string[];
}

const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** Whether a held level covers a needed one; an unknown level covers nothing. */
export function covers(have: string | undefined, need: PermissionLevel): boolean {
  return (RANK[have ?? ""] ?? 0) >= RANK[need];
}

/**
 * Every gap, per scope: the App first, then each installation. A scope with no gaps and no extra
 * events is left out, so an empty answer means everything is in place.
 */
export function subscriptionReports(subs: AppSubscriptions): SubscriptionReport[] {
  const gapsOf = (sub: AppSubscription, perms: readonly PermissionNeed[]): SubscriptionGap[] => {
    const gaps: SubscriptionGap[] = [];
    for (const need of REQUIRED_EVENTS) {
      if (!sub.events.includes(need.name)) {
        gaps.push({ kind: "event", name: need.name, required: need.required, spends: need.spends });
      }
    }
    for (const need of perms) {
      const have = sub.permissions[need.name];
      if (!covers(have, need.level)) {
        gaps.push({
          kind: "permission",
          name: need.name,
          need: need.level,
          have: have ?? "none",
          required: need.required,
          spends: need.spends,
        });
      }
    }
    return gaps;
  };

  const reports: SubscriptionReport[] = [];
  const appGaps = gapsOf(subs.app, REQUIRED_PERMISSIONS);
  const known = new Set(REQUIRED_EVENTS.map((e) => e.name));
  const extraEvents = subs.app.events.filter((e) => !known.has(e)).sort();
  if (appGaps.length > 0 || extraEvents.length > 0) {
    reports.push({ scope: "app", gaps: appGaps, extraEvents });
  }
  const onApp = new Set(appGaps.map((g) => `${g.kind}:${g.name}`));
  for (const inst of subs.installations) {
    // Account permissions are the App's alone, and an org permission means nothing on a person.
    const perms = REQUIRED_PERMISSIONS.filter((p) =>
      p.on === "repo" || (p.on === "org" && inst.accountType === "Organization")
    );
    const gaps = gapsOf(inst, perms).filter((g) => !onApp.has(`${g.kind}:${g.name}`));
    if (gaps.length > 0) {
      reports.push({ scope: `installation ${inst.id} (${inst.account})`, gaps, extraEvents: [] });
    }
  }
  return reports;
}

/** One gap as a log fragment: `push (default-branch environment builds …)`. */
export function describeGap(gap: SubscriptionGap): string {
  const what = gap.kind === "event" ? gap.name : `${gap.name}: ${gap.need} (has ${gap.have})`;
  return `${what} — ${gap.spends}`;
}
