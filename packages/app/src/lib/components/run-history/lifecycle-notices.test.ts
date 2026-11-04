import { describe, expect, it } from "vitest";
import type { RunEvent, RunMessage } from "$lib/api/types";
import { RunHistory } from "./run-history.svelte";

const event: RunEvent = {
  runId: "run-1",
  at: "2026-10-14T12:00:00Z",
  kind: "patch-submitted",
  detail: "linkless-forge-patch-id",
};
const notice = {
  id: "message-1",
  seq: 1,
  runId: event.runId,
  kind: "system",
  sender: { kind: "platform" },
  text: "Patch submitted",
  createdAt: event.at,
  deliveredAt: null,
  attachments: [],
  payload: {
    kind: "patch",
    patchId: "patch-1",
    path: "repo",
    headSha: "commit-1",
    generation: 1,
    state: "submitted",
    forgeUrl: null,
    reason: null,
    hookPaths: [],
  },
} satisfies RunMessage;

describe("submission lifecycle notices", () => {
  it("shows the platform submission once, without its low-level lifecycle line", () => {
    const history = new RunHistory(event.runId);
    history.setDetail({
      lifecycle: [event],
      messages: [notice],
      result: null,
      egressNote: null,
      live: false,
    });
    expect(history.rows.map((row) => row.kind)).toEqual(["message"]);
    const row = history.rows[0];
    expect(row.kind === "message" && row.message.id).toBe(notice.id);
  });

  it("omits only submission lifecycle rows even before the inbox arrives, without mutating events", () => {
    const history = new RunHistory(event.runId);
    const lifecycle = [event, {
      ...event,
      kind: "patch-submit-failed",
    }, {
      ...event,
      kind: "patch-approved",
    }];
    const detail = { lifecycle, result: null, egressNote: null, live: false };
    const notes = () => history.rows.flatMap((row) => row.kind === "machine" ? row.events : []);
    history.setDetail({ ...detail, messages: [] });
    expect(notes().map((note) => note.kind)).toEqual(["patch-submit-failed", "patch-approved"]);
    expect(lifecycle).toHaveLength(3);
    expect(lifecycle[0]).toBe(event);
    history.setDetail({ ...detail, messages: [notice] });
    expect(notes().map((note) => note.kind)).toEqual(["patch-submit-failed", "patch-approved"]);
    expect(history.rows.filter((row) => row.kind === "message")).toHaveLength(1);
  });
});
