import type { GitlabHook } from "$lib/api/repos";
import { formatRelativeTime } from "$lib/utils/format";

/** One value to paste, with a copy button beside it; `value` null where it is not known. */
export type HookValue = { label: string; value: string | null };

/** One step of setting up a GitLab project's webhook, in GitLab's own words. */
export type HookStep = {
  text: string;
  /** The menu path to follow on GitLab, in its own labels. */
  path?: string[];
  link?: { href: string; label: string };
  values?: HookValue[];
  /** Checkboxes to tick, as GitLab labels them. */
  ticks?: string[];
  note?: string;
};

/**
 * The project's own webhooks settings page: `<web url>/-/hooks`, which GitLab serves for every
 * project. Null where the web URL is not one a browser can open.
 */
export function hooksPageUrl(webUrl: string | null): string | null {
  if (!webUrl) return null;
  try {
    const url = new URL(webUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}/-/hooks`;
  } catch {
    return null;
  }
}

/**
 * How a Maintainer adds Ryph's webhook to one GitLab project: the URL and the secret token derived
 * for that project, the three triggers Ryph reads, and SSL verification left on. The push trigger
 * is narrowed to the default branch, named to copy, in a step of its own: Ryph acts on that
 * branch's pushes alone, and every other branch's would spend the project's delivery budget, past
 * which deliveries are dropped.
 */
export function gitlabHookSteps(hook: GitlabHook, webUrl: string | null): HookStep[] {
  const page = hooksPageUrl(webUrl);
  return [
    {
      text: "On GitLab, open the project's webhooks and add a new one.",
      path: ["Settings", "Webhooks", "Add new webhook"],
      link: page ? { href: page, label: "Open the project's webhooks" } : undefined,
    },
    {
      text: "Paste the URL and the secret token.",
      values: [
        { label: "URL", value: hook.url },
        { label: "Secret token", value: hook.token },
      ],
      note: hook.url === null
        ? "This deployment has no public address set (RYPH_APP_URL), so it has no webhook URL yet. Ask an administrator to set it."
        : "The token works for this project only.",
    },
    {
      text: "Under Trigger, tick these three.",
      ticks: ["Push events", "Comments", "Merge request events"],
    },
    {
      text: hook.pushBranchFilter
        ? `Under Push events, choose Wildcard pattern and enter the ${hook.pushBranchFilter} branch.`
        : "Under Push events, choose Wildcard pattern and enter the project's default branch.",
      values: [{ label: "Branch filter", value: hook.pushBranchFilter }],
      note: hook.pushBranchFilter
        ? "Ryph only acts on pushes to this branch. Pushes to other branches would use up the project's delivery budget."
        : "The project has no default branch yet. Enter it once it has one.",
    },
    {
      text: "Leave SSL verification on, then save the webhook.",
      note: "GitLab's Test button can send a push event to check it arrives.",
    },
  ];
}

/** Whether GitLab has delivered with the webhook's current token, as the repo page words it, and
 * what was dropped over the project's budgets, if anything. */
export type HookDelivery = {
  seen: boolean;
  text: string;
  hint: string | null;
  dropped: string | null;
};

/** Deliveries dropped over the project's budgets at the current token, as the repo page counts
 * them: GitLab was told they arrived, so it keeps the webhook on, and their events were lost.
 * Comments have a budget of their own, apart from every other event, and are counted apart: a
 * dropped /ryph comment is a command nothing else brings back. */
export type HookDrops = { comments: number; other: number; lastAt: string | null };

const counted = (n: number, one: string, many: string) => n === 1 ? `1 ${one}` : `${n} ${many}`;

/**
 * The webhook's health from its last admitted delivery. None yet is how a project looks before a
 * Maintainer adds the webhook, or after a rotation until the new values are pasted in. Deliveries
 * with no merge request event among them may mean that trigger isn't ticked: merges arrive only
 * as merge request events.
 */
export function hookDelivery(
  lastDeliveryAt: string | null,
  lastMergeRequestDeliveryAt: string | null,
  drops: HookDrops = { comments: 0, other: 0, lastAt: null },
): HookDelivery {
  const what = [
    drops.comments === 0 ? null : counted(drops.comments, "comment", "comments"),
    drops.other === 0 ? null : counted(drops.other, "other event", "other events"),
  ].filter((part) => part !== null);
  const dropped = what.length === 0 ? null : [
    `${what.join(" and ")} dropped`,
    drops.lastAt === null ? "" : `, the last ${formatRelativeTime(drops.lastAt)}`,
    ". GitLab sent more than the project's limit a minute, so they didn't reach Ryph.",
    drops.comments === 0 ? "" : " Post any /ryph comment among them again.",
  ].join("");
  if (lastDeliveryAt === null) {
    return {
      seen: false,
      text: "No delivery seen yet",
      hint:
        "GitLab sends nothing until the webhook is added. Until then, /ryph comments don't reach Ryph and merges are checked slowly.",
      dropped,
    };
  }
  return {
    seen: true,
    text: `Last delivery ${formatRelativeTime(lastDeliveryAt)}`,
    hint: lastMergeRequestDeliveryAt === null
      ? "No merge request event seen yet. If Merge request events isn't ticked on the webhook, merges are only checked slowly."
      : null,
    dropped,
  };
}
