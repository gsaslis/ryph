import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import { runMessageSchema, systemPayloadSchema } from "$lib/api/types";
import PlatformNotice from "./platform-notice.svelte";
import {
  inboxNoticeActions,
  inboxNoticeSummary,
  isInboxNotice,
  runnerChecksPayload,
  runnerNoticeDetails,
  runnerNoticeSummary as readRunnerNotice,
} from "./platform-notice";

const runnerNoticeSummary = (payload: Record<string, unknown>) =>
  readRunnerNotice({ sender: { kind: "platform" }, ...payload });

const patch = {
  kind: "patch",
  patchId: "p1",
  path: "repo",
  headSha: "abc",
  generation: 1,
  state: "held",
  forgeUrl: null,
  reason: "Hook changes require approval",
};

const checks = {
  kind: "checks" as const,
  suiteId: "cs-1",
  path: "ryph",
  commit: "0123456789abcdef",
  state: "passed" as const,
  partial: false,
};

describe("platform summaries", () => {
  it.each(["passed", "failed", "error", "cancelled"])("names checks %s", (state) => {
    const payload = systemPayloadSchema.parse({ ...checks, state });
    expect(inboxNoticeSummary(payload)).toEqual({
      label: state === "error" ? "Checks could not complete" : `Checks ${state}`,
      detail: "ryph · 0123456789",
      failed: state === "failed" || state === "error",
      checksState: state,
    });
  });
  it("recognizes checks in history without trusting prose or non-platform senders", () => {
    const inbound = { kind: "system", sender: { kind: "platform" }, payload: checks };
    expect(readRunnerNotice(inbound)).toEqual(inboxNoticeSummary(checks));
    expect(runnerChecksPayload(inbound)).toEqual(checks);
    expect(runnerChecksPayload({ ...inbound, sender: { kind: "user" } })).toBeNull();
    expect(runnerChecksPayload({ ...inbound, payload: { ...checks, state: "unknown" } }))
      .toBeNull();
    expect(readRunnerNotice({ ...inbound, payload: null, text: "Checks passed" })).toEqual({
      label: "Platform update",
      failed: false,
    });
  });
  it("distinguishes selected checks and omits the root marker", () => {
    expect(inboxNoticeSummary({ ...checks, partial: true, path: "." })).toMatchObject({
      label: "Selected checks passed",
      detail: "0123456789",
    });
    expect(inboxNoticeActions({ ...checks, suiteId: "cs/1" })).toEqual([
      { label: "View checks", href: "/checks/cs%2F1", external: false },
    ]);
    expect(inboxNoticeActions({ ...checks, suiteId: "" })).toEqual([]);
    expect(
      runMessageSchema.parse({
        id: "m",
        runId: "r",
        seq: 1,
        kind: "system",
        sender: { kind: "platform" },
        text: "Full results",
        createdAt: "2026-01-01T00:00:00Z",
        payload: checks,
      }).payload,
    ).toEqual(checks);
  });
  it("omits root path markers but retains named paths and failure reasons", () => {
    const payloads = [
      { ...patch, reason: null },
      { kind: "environment", patchId: "p1", headSha: "abc", environmentId: null, status: "failed" },
      { kind: "released", onto: "abc", forgeRef: "42" },
    ];
    for (const payload of payloads) {
      expect(inboxNoticeSummary(systemPayloadSchema.parse({ ...payload, path: "." })).detail)
        .toBeUndefined();
      expect(
        inboxNoticeSummary(systemPayloadSchema.parse({ ...payload, path: "services/api" })).detail,
      ).toBe("services/api");
    }
    expect(
      inboxNoticeSummary(
        systemPayloadSchema.parse({ ...patch, path: ".", reason: "Push rejected" }),
      ).detail,
    ).toBe("Push rejected");
    expect(
      inboxNoticeSummary(
        systemPayloadSchema.parse({ ...patch, path: "services/api", reason: "Push rejected" }),
      ).detail,
    ).toBe("services/api · Push rejected");
  });
  it.each(["held", "submitted", "rejected", "failed", "missed"])(
    "names patch %s and preserves its reason",
    (state) => {
      const summary = inboxNoticeSummary(systemPayloadSchema.parse({ ...patch, state }));
      expect(summary.label).toContain(
        state === "held" ? "approval" : state === "missed" ? "not in merge" : state,
      );
      expect(summary.detail).toBe("repo · Hook changes require approval");
    },
  );
  it.each(["ready", "failed", "superseded", "skipped"])("summarises environment %s", (status) => {
    const summary = inboxNoticeSummary(
      systemPayloadSchema.parse({
        kind: "environment",
        patchId: "p1",
        path: "repo",
        headSha: "abc",
        environmentId: null,
        status,
      }),
    );
    expect(summary.label).toContain("environment");
    expect(summary.failed).toBe(status === "failed");
    expect(summary.detail).toBe("repo");
  });
  it("covers released and finish without reading message prose", () => {
    expect(
      inboxNoticeSummary(
        systemPayloadSchema.parse({ kind: "released", path: "repo", onto: "abc", forgeRef: "1" }),
      ),
    ).toMatchObject({ label: "change request merged", detail: "repo" });
    expect(inboxNoticeSummary({ kind: "finish" }).label).toBe("finished the run");
    expect(inboxNoticeSummary(null)).toEqual({ label: "Platform update", failed: false });
  });
  it("uses wake/check metadata and never guesses from text", () => {
    expect(runnerNoticeSummary({ kind: "system", wake: { afterMinutes: 5, note: "a long note" } }))
      .toEqual({ label: "Wake-up after 5 min", failed: false });
    expect(runnerNoticeSummary({ kind: "system", checksLate: { owed: 2 } })).toMatchObject({
      label: "Check verdicts overdue",
      detail: "2 verdicts outstanding",
      failed: true,
    });
    expect(runnerNoticeSummary({ kind: "system", checksLate: { owed: null } })?.detail).toContain(
      "unavailable",
    );
    for (
      const payload of [{ text: "Wake-up after 5 min; build failed" }, { wake: {} }, {
        checksLate: { owed: "3" },
      }, { futureNotice: {} }]
    ) {
      expect(runnerNoticeSummary({ kind: "system", ...payload })).toEqual({
        label: "Platform update",
        failed: false,
      });
    }
    expect(runnerNoticeSummary({ kind: "user", text: "Build failed" })).toBeNull();
    expect(runnerNoticeSummary({ kind: "chat", wake: { afterMinutes: 5 } })).toBeNull();
  });
  it("keeps failure information in background and subagent summaries", () => {
    expect(
      runnerNoticeSummary({
        kind: "system",
        background: {
          id: "bg-1",
          label: "Tests",
          reason: "exited",
          exitCode: 1,
          signal: null,
          durationMs: 1000,
        },
      }),
    ).toMatchObject({ label: "Tests exited 1 after 1s", failed: true });
    expect(
      runnerNoticeSummary({
        kind: "system",
        subagent: { id: "sa-1", label: "Review", reason: "failed", durationMs: 1000 },
      }),
    ).toMatchObject({ failed: true });
  });
});

describe("notice ownership and actions", () => {
  it("leaves human system messages alone except explicit finish attribution", () => {
    const human = runMessageSchema.parse({
      id: "m",
      runId: "r",
      seq: 1,
      kind: "system",
      sender: { kind: "user", userId: "u", name: "Ada" },
      text: "My system message",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(isInboxNotice(human)).toBe(false);
    expect(isInboxNotice({ ...human, payload: { kind: "finish" } })).toBe(true);
    expect(isInboxNotice({ ...human, sender: { kind: "platform" } })).toBe(true);
    expect(readRunnerNotice({ kind: "system", text: "No known sender" })).toBeNull();
    expect(
      readRunnerNotice({ kind: "system", sender: { kind: "user" }, wake: { afterMinutes: 5 } }),
    ).toBeNull();
  });
  it("offers patch links and only safe external change-request links", () => {
    const payload = systemPayloadSchema.parse({
      ...patch,
      patchId: "p/1",
      forgeUrl: "https://forge.example/pr/42",
    });
    expect(inboxNoticeActions(payload)).toEqual([
      { label: "View patch", href: "/patches/p%2F1", external: false },
      { label: "Open change request", href: "https://forge.example/pr/42", external: true },
    ]);
    for (
      const forgeUrl of [
        "javascript:alert(1)",
        "data:text/html,test",
        "//evil.example",
        "not a URL",
        "https://user:secret@example.com",
      ]
    ) {
      expect(inboxNoticeActions(systemPayloadSchema.parse({ ...patch, forgeUrl }))).toHaveLength(1);
    }
    expect(
      inboxNoticeActions(
        systemPayloadSchema.parse({
          kind: "environment",
          patchId: "p1",
          path: "repo",
          headSha: "abc",
          environmentId: "env1",
          status: "failed",
        }),
      ),
    ).toEqual([{ label: "View patch", href: "/patches/p1", external: false }]);
    expect(inboxNoticeActions(null)).toEqual([]);
    expect(inboxNoticeActions({ kind: "finish" })).toEqual([]);
  });
});

describe("original details", () => {
  it("retains delivered text and historian framing without requiring a linked record", () => {
    expect(
      runnerNoticeDetails({
        text: "Framed original",
        payload: { text: "Full answer\noutput\n<untrusted>" },
      }),
    ).toBe("Framed original\n\nFull answer\noutput\n<untrusted>");
    expect(runnerNoticeDetails({ text: "same", payload: { text: "same" } })).toBe("same");
    expect(runnerNoticeDetails({ text: null, payload: { text: "Full answer" } })).toBe(
      "Full answer",
    );
  });
  const props = {
    summary: { label: "Tests exited 1", failed: true },
    at: "2026-01-01T00:00:00Z",
    details: "Original <script>unsafe</script>\nlast line",
    ontoggle: () => {},
  };
  it.each(["passed", "failed", "error", "cancelled"])(
    "renders check verdict %s and preserves details",
    (state) => {
      const summary = inboxNoticeSummary(systemPayloadSchema.parse({ ...checks, state }));
      const { body } = render(PlatformNotice, { props: { ...props, summary, open: true } });
      expect(body).toContain(summary.label);
      expect(body).toContain("ryph · 0123456789");
      expect(body).toContain("Original &lt;script>unsafe&lt;/script>");
      expect(body).toContain('aria-expanded="true"');
      if (state === "passed") expect(body).toContain("text-success");
      if (state === "failed" || state === "error") expect(body).toContain("text-destructive");
    },
  );
  it("is collapsed by default with visible failure summary and a keyboard-accessible trigger", () => {
    const { body } = render(PlatformNotice, { props });
    expect(body).toContain("Tests exited 1");
    expect(body).toContain("text-destructive");
    expect(body).toContain("Details");
    expect(body).toContain('aria-expanded="false"');
    expect(body).toMatch(/hidden="" data-state="closed" data-collapsible-content/);
  });
  it.each(["patch approved", "environment built", "no environment build", "preview server ready"])(
    "capitalizes the first letter of %s without changing the original details",
    (label) => {
      const { body } = render(PlatformNotice, {
        props: { ...props, summary: { label, failed: false }, details: label, open: true },
      });
      expect(body).toContain(`${label.charAt(0).toUpperCase()}${label.slice(1)}</bdi>`);
      expect(body).toContain(`${label}</pre>`);
    },
  );
  it("shows the full escaped original when expanded", () => {
    const { body } = render(PlatformNotice, { props: { ...props, open: true } });
    expect(body).toContain('aria-expanded="true"');
    expect(body).toContain("Original &lt;script>unsafe&lt;/script>\nlast line");
    expect(body).not.toContain("<script>unsafe</script>");
  });
});
