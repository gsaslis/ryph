import {
  type HistoryEvent,
  type RunMessage,
  type SystemPayload,
  systemPayloadSchema,
} from "$lib/api/types";
import { systemPayloadLabel } from "$lib/utils/environments";
import { backgroundNoticeOf, noticeFailed, noticeSentence } from "$lib/utils/background";
import { endLabel, subagentNoticeOf } from "$lib/utils/subagents";
import { formatElapsed } from "$lib/utils/format";

export interface PlatformNoticeSummary {
  label: string;
  detail?: string;
  failed: boolean;
  checksState?: "passed" | "failed" | "error" | "cancelled";
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

export function isPlatformInbound(payload: unknown): boolean {
  const data = record(payload);
  return data.kind === "system" && record(data.sender).kind === "platform";
}

export function isInboxNotice(message: RunMessage): boolean {
  return message.kind === "system" && (message.sender.kind === "platform" ||
    (message.sender.kind === "user" && message.payload?.kind === "finish"));
}

export interface PlatformNoticeAction {
  label: string;
  href: string;
  external: boolean;
}

/** Only explicit HTTP(S) forge links may leave the app; patch IDs are path segments. */
export function inboxNoticeActions(payload: SystemPayload | null): PlatformNoticeAction[] {
  if (payload?.kind === "checks") {
    return payload.suiteId
      ? [{
        label: "View checks",
        href: `/checks/${encodeURIComponent(payload.suiteId)}`,
        external: false,
      }]
      : [];
  }
  if (payload?.kind !== "patch" && payload?.kind !== "environment") return [];
  const actions: PlatformNoticeAction[] = [];
  if (payload.patchId !== "") {
    actions.push({
      label: "View patch",
      href: `/patches/${encodeURIComponent(payload.patchId)}`,
      external: false,
    });
  }
  if (payload.kind === "patch" && payload.forgeUrl) {
    try {
      const url = new URL(payload.forgeUrl);
      if (
        (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ) {
        actions.push({ label: "Open change request", href: url.href, external: true });
      }
    } catch {
      // Invalid metadata must not turn a platform notice into an unsafe navigation.
    }
  }
  return actions;
}

/** The root marker adds no identity; named repository paths do. Originals stay in Details. */
const compactPath = (path: string): string | undefined => path === "." ? undefined : path;

/** Summaries come only from metadata, never from agent-facing prose. */
export function inboxNoticeSummary(payload: SystemPayload | null): PlatformNoticeSummary {
  if (payload === null) return { label: "Platform update", failed: false };
  switch (payload.kind) {
    case "patch":
      return {
        label: systemPayloadLabel(payload),
        detail: [compactPath(payload.path), payload.reason].filter(Boolean).join(" · ") ||
          undefined,
        failed: ["held", "failed", "rejected", "conflict", "conflicted", "missed"].includes(
          payload.state,
        ),
      };
    case "environment":
      return {
        label: systemPayloadLabel(payload),
        detail: compactPath(payload.path),
        failed: payload.status === "failed",
      };
    case "released":
      return {
        label: systemPayloadLabel(payload),
        detail: compactPath(payload.path),
        failed: false,
      };
    case "checks":
      return {
        label: systemPayloadLabel(payload),
        detail:
          [compactPath(payload.path), payload.commit.slice(0, 10)].filter(Boolean).join(" · ") ||
          undefined,
        failed: payload.state === "failed" || payload.state === "error",
        checksState: payload.state,
      };
    case "finish":
      return { label: "finished the run", failed: false };
    default:
      return { label: "Platform update", failed: false };
  }
}

export function runnerChecksPayload(payload: unknown): SystemPayload | null {
  if (!isPlatformInbound(payload)) return null;
  const parsed = systemPayloadSchema.safeParse(record(payload).payload);
  return parsed.success && parsed.data.kind === "checks" ? parsed.data : null;
}

/** Null means this is not a platform inbound; human/agent-authored events stay untouched. */
export function runnerNoticeSummary(payload: unknown): PlatformNoticeSummary | null {
  const data = record(payload);
  if (!isPlatformInbound(payload)) return null;
  const checks = runnerChecksPayload(payload);
  if (checks) return inboxNoticeSummary(checks);
  const background = backgroundNoticeOf(payload);
  if (background) {
    return {
      label: `${background.label} ${noticeSentence(background)}`,
      failed: noticeFailed(background),
    };
  }
  const subagent = subagentNoticeOf(payload);
  if (subagent) {
    const end = endLabel(subagent.reason);
    return {
      label: `Subagent ${subagent.label} ${end.label.toLowerCase()} after ${
        formatElapsed(subagent.durationMs)
      }`,
      failed: end.tone === "failed",
    };
  }
  const wake = record(data.wake);
  if (
    typeof wake.afterMinutes === "number" && Number.isFinite(wake.afterMinutes) &&
    wake.afterMinutes >= 0
  ) {
    return { label: `Wake-up after ${wake.afterMinutes} min`, failed: false };
  }
  const late = record(data.checksLate);
  if (
    late.owed === null ||
    (typeof late.owed === "number" && Number.isInteger(late.owed) && late.owed >= 0)
  ) {
    return {
      label: "Check verdicts overdue",
      detail: late.owed === null
        ? "Outstanding verdict count unavailable"
        : `${late.owed} verdict${late.owed === 1 ? "" : "s"} outstanding`,
      failed: true,
    };
  }
  return { label: "Platform update", failed: false };
}

/** Keep both originals if the historian's text differs from the delivered message. */
export function runnerNoticeDetails(event: Pick<HistoryEvent, "text" | "payload">): string {
  const text = record(event.payload).text;
  const original = typeof text === "string" ? text : "";
  return [...new Set([event.text ?? "", original].filter((part) => part !== ""))].join("\n\n");
}
