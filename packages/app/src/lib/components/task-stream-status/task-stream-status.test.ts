import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import TaskStreamStatus from "./task-stream-status.svelte";

const props = { retry: vi.fn(), backTo: "/tasks?status=live#recent" };

describe("task stream status", () => {
  it("is quiet while healthy, suspended, or before the recovery delay", () => {
    for (const state of ["live", "suspended", "connecting", "retrying"] as const) {
      const { body } = render(TaskStreamStatus, { props: { ...props, state } });
      expect(body).not.toContain("Reconnecting");
      expect(body).not.toContain("Live updates interrupted");
      expect(body).toContain('role="status"');
      expect(body).not.toContain("<button");
    }
  });

  it("offers a compact red retry indicator only after recovery has failed", () => {
    const { body } = render(TaskStreamStatus, { props: { ...props, state: "failed" } });
    expect(body).toContain('aria-label="Live updates interrupted — retry"');
    expect(body).toContain("text-destructive");
    expect(body).toContain("<button");
    expect(body).toContain('data-slot="tooltip-trigger"');
    expect(body).not.toContain("animate-spin");
    expect(body).not.toContain('data-slot="alert"');
    expect(body).not.toContain("sign in again");
    expect(body.match(/role="status"/g)).toHaveLength(1);
    expect(body).not.toContain('role="alert"');
  });

  it("offers sign-in with the current location rather than an ineffective retry", () => {
    const { body } = render(TaskStreamStatus, { props: { ...props, state: "auth-required" } });
    expect(body).toContain('aria-label="Session expired — sign in again"');
    expect(body).toContain("text-destructive");
    expect(body).not.toContain("animate-spin");
    expect(body).toContain('href="/login?backTo=%2Ftasks%3Fstatus%3Dlive%23recent"');
    expect(body).not.toContain("Live updates interrupted — retry");
  });
});
