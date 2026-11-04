import type { HistoryEvent } from "$lib/api/types";
import { BROWSER_SERVER } from "$lib/utils/browser-tools";

/**
 * How often a live run's page re-reads its whole load when nothing in the stream asked it to.
 *
 * The load is the task's detail, the run's inbox, two or three history reads and the bill, and
 * the stream already carries the transcript as it happens. So the page re-reads when the stream
 * says something the load holds has moved (`DetailCues`) and otherwise only this often, as a
 * backstop for what reaches no stream at all: a patch a person approved, the skills report.
 */
export const RUN_REFRESH_MS = 15_000;

/** Whether an `inbound` event carries a message from the run's inbox, which has a `seq`. */
export function isInboxDelivery(payload: unknown): boolean {
  return typeof (payload as { seq?: unknown } | null)?.seq === "number";
}

/** An MCP tool, `<server slug>__<tool>`, other than the browser's: the platform's, the forge's,
 * memory's and chat's, whose effects (patches, suites, forge writes, proposals) the load carries. */
function recordedTool(name: string): boolean {
  return name.includes("__") && !name.startsWith(`${BROWSER_SERVER}__`);
}

/**
 * Reads the live tail for events that change what only the load carries: an inbox message
 * reaching the agent (its row, as who said what, is the load's), and the answer to a call of an
 * MCP tool that records something — a patch submitted, checks asked for, a comment posted. Pi's
 * own tools and the browser's answer far more often and change nothing the load holds.
 *
 * Stateful: a tool's answer names only its call, so the calls worth an answer are remembered.
 */
export class DetailCues {
  readonly #awaited = new Set<string>();

  /** Whether this event means the load is behind. */
  wants(event: Pick<HistoryEvent, "kind" | "payload">): boolean {
    const payload = event.payload as { toolCallId?: unknown; toolName?: unknown } | null;
    switch (event.kind) {
      case "inbound":
        return isInboxDelivery(event.payload);
      case "tool_use":
        if (
          typeof payload?.toolCallId === "string" && typeof payload.toolName === "string" &&
          recordedTool(payload.toolName)
        ) {
          this.#awaited.add(payload.toolCallId);
        }
        return false;
      case "tool_result":
        return typeof payload?.toolCallId === "string" && this.#awaited.delete(payload.toolCallId);
      default:
        return false;
    }
  }
}
