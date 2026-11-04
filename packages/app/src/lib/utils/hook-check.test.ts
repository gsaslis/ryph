import { describe, expect, it } from "vitest";
import {
  type Patch,
  patchSchema,
  patchWithContextSchema,
  runMessageSchema,
  systemPayloadSchema,
} from "$lib/api/types";
import { ApiError } from "$lib/api/call";
import {
  approvalHookPaths,
  approvalRefusal,
  approvalRefusalMessage,
  approveBlock,
  heldFiles,
  heldNoticeLine,
  HOOK_CHECKING_LABEL,
  HOOK_CONFIRM_BODY,
  HOOK_TOO_MANY,
  HOOK_WARNING_BODY,
  hookCheckNotice,
  isCheckingHooks,
  isHeld,
  isHeldNotice,
  isLocalPatch,
  refusalNeedsReview,
  snapshotHookFiles,
} from "./hook-check";

const wire = {
  id: "p-0123456789",
  state: "pending_approval",
  connectedRepoId: "cr-1",
  runId: "r-1",
  taskId: "t-1",
  setId: "s-1",
  path: "app",
  line: "work",
  branchName: "ryph/t-1",
  headSha: "abc1234",
  bundleKey: "k",
  attempts: 0,
  nextAttemptAt: null,
  lastError: null,
  approvedBy: null,
  approvedAt: null,
  forgeRef: null,
  forgeUrl: null,
  landed: null,
  supersededByPatchId: null,
  createdAt: "2026-10-06T00:00:00Z",
  updatedAt: "2026-10-06T00:00:00Z",
};

const patch = (over: Partial<Patch> = {}): Patch => ({ ...patchSchema.parse(wire), ...over });
const hooks = (touched: string[], more = false) => ({ touched, hooksPaths: [".husky"], more });

describe("the hook fields on the wire", () => {
  it("default when an older control plane leaves them out", () => {
    const parsed = patchSchema.parse(wire);
    expect(parsed.hookCheck).toBeNull();
    expect(parsed.hooksPending).toBe(false);
    expect(parsed.provider).toBeNull();
  });

  it("parse when present, on a task's patch and the queue's", () => {
    const sent = { ...wire, provider: "local", hookCheck: hooks([".husky/pre-commit"], true) };
    expect(patchSchema.parse(sent).hookCheck).toEqual(hooks([".husky/pre-commit"], true));
    const queued = patchWithContextSchema.parse({
      ...sent,
      hooksPending: true,
      taskTitle: null,
      agentName: null,
      repoRef: null,
      summary: null,
      commits: [],
    });
    expect(queued.provider).toBe("local");
    expect(queued.hooksPending).toBe(true);
  });

  it("read a held notice, and an older patch notice without hook paths", () => {
    const base = {
      kind: "patch",
      patchId: "p-0123456789",
      path: "app",
      headSha: "abc1234",
      generation: 1,
      forgeUrl: null,
      reason: null,
    };
    const held = systemPayloadSchema.parse({
      ...base,
      state: "held",
      hookPaths: [".husky/post-checkout"],
    });
    expect(isHeldNotice(held)).toBe(true);
    const older = systemPayloadSchema.parse({ ...base, state: "submitted" });
    expect(older.kind === "patch" && older.hookPaths).toEqual([]);
    expect(isHeldNotice(older)).toBe(false);
    expect(isHeldNotice(null)).toBe(false);
    const message = runMessageSchema.parse({
      id: "m-1",
      runId: "r-1",
      seq: 1,
      kind: "system",
      sender: { kind: "platform" },
      text: "held",
      payload: { ...base, state: "held", hookPaths: [".husky/post-checkout"] },
      createdAt: "2026-10-06T00:00:00Z",
    });
    expect(isHeldNotice(message.payload)).toBe(true);
  });
});

describe("a held patch", () => {
  it("waits on approval with hook files found", () => {
    expect(isHeld(patch({ hookCheck: hooks([".husky/post-checkout"]) }))).toBe(true);
  });

  it("is not one with no hook files, none checked, or a decision made", () => {
    expect(isHeld(patch())).toBe(false);
    expect(isHeld(patch({ hookCheck: hooks([]) }))).toBe(false);
    expect(isHeld(patch({ state: "queued", hookCheck: hooks([".husky/pre-commit"]) }))).toBe(
      false,
    );
    expect(isHeld(patch({ state: "rejected", hookCheck: hooks([".husky/pre-commit"]) }))).toBe(
      false,
    );
  });

  it("names its files, and whether there are more", () => {
    expect(heldFiles(patch({ hookCheck: hooks(["a", "b"], true) }))).toEqual({
      files: ["a", "b"],
      more: true,
    });
    expect(heldFiles(patch({ state: "submitted", hookCheck: hooks(["a"], true) }))).toEqual({
      files: [],
      more: false,
    });
  });
});

describe("a patch still being checked", () => {
  it("is checking until the check is in", () => {
    expect(isCheckingHooks(patch({ hooksPending: true }))).toBe(true);
    expect(isCheckingHooks(patch())).toBe(false);
  });

  it("stops saying so once held", () => {
    expect(isCheckingHooks(patch({ hooksPending: true, hookCheck: hooks(["a"]) }))).toBe(false);
  });
});

describe("approving names the hook files on screen", () => {
  const capture = () => {
    const seen: { body?: unknown } = {};
    const f = ((_url: string, init?: RequestInit) => {
      seen.body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      return Promise.resolve(
        new Response(JSON.stringify({ patch: { ...wire, state: "queued" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    return { f, seen };
  };

  it("sends the files it was given, and nothing when there are none to name", async () => {
    const { approvePatch } = await import("$lib/api/patches");
    const named = capture();
    await approvePatch(named.f, "p-0123456789", undefined, [".husky/pre-commit"]);
    expect(named.seen.body).toEqual({ hookPaths: [".husky/pre-commit"] });

    const plain = capture();
    await approvePatch(plain.f, "p-0123456789");
    expect(plain.seen.body).toBeUndefined();
  });
});

describe("whether Approve can be pressed", () => {
  it("waits while the files are checked", () => {
    expect(approveBlock(patch({ provider: "local", hooksPending: true }))).toEqual({
      reason: "checking",
      label: HOOK_CHECKING_LABEL,
    });
  });

  it("never for a patch with more hook files than it names", () => {
    expect(approveBlock(patch({ hookCheck: hooks(["a"], true) }))).toEqual({
      reason: "hidden",
      label: HOOK_TOO_MANY,
    });
  });

  it("otherwise, held or not", () => {
    expect(approveBlock(patch())).toBeNull();
    expect(approveBlock(patch({ hookCheck: hooks(["a"]) }))).toBeNull();
    expect(approveBlock(patch({ provider: "local", hookCheck: hooks([]) }))).toBeNull();
  });
});

describe("the hook files an approval names", () => {
  it("are the dialog's copy, taken when it opened, whatever the patch says now", () => {
    const opened = patch({ hookCheck: hooks([".husky/pre-commit"]) });
    const shown = snapshotHookFiles(opened);
    expect(shown).toEqual([".husky/pre-commit"]);
    // A refresh behind the open dialog finds another file: the copy and what is sent keep still.
    const later = patch({ hookCheck: hooks([".husky/pre-commit", ".husky/post-checkout"]) });
    expect(approvalHookPaths(later, shown)).toEqual([".husky/pre-commit"]);
    expect(shown).toEqual([".husky/pre-commit"]);
  });

  it("are a copy, so changing the patch's list later changes nothing", () => {
    const touched = [".husky/pre-commit"];
    const shown = snapshotHookFiles(patch({ hookCheck: { touched, hooksPaths: [], more: false } }));
    touched.push(".husky/post-merge");
    expect(shown).toEqual([".husky/pre-commit"]);
  });

  it("are none for a patch that is not held", () => {
    expect(snapshotHookFiles(patch())).toBeNull();
    expect(snapshotHookFiles(patch({ state: "queued", hookCheck: hooks(["a"]) }))).toBeNull();
  });

  it("are empty for any other patch on this machine, and left out elsewhere", () => {
    expect(approvalHookPaths(patch({ provider: "local", hookCheck: hooks([]) }), null)).toEqual([]);
    // A repo that is gone has no provider; its hook check still marks it as one on this machine.
    expect(approvalHookPaths(patch({ provider: null, hookCheck: hooks([]) }), null)).toEqual([]);
    expect(approvalHookPaths(patch({ provider: "github" }), null)).toBeUndefined();
  });

  it("knows a patch on this machine without its provider", () => {
    expect(isLocalPatch(patch({ provider: "local" }))).toBe(true);
    expect(isLocalPatch(patch({ hookCheck: hooks([]) }))).toBe(true);
    expect(isLocalPatch(patch({ hooksPending: true }))).toBe(true);
    expect(isLocalPatch(patch())).toBe(false);
  });
});

describe("a refused approval", () => {
  const refused = (status: number, body: unknown) => new ApiError(status, body, "refused");

  it("is read off a 409's code", () => {
    expect(approvalRefusal(refused(409, { code: "too_many_hook_files", error: "x" }))).toBe(
      "too_many_hook_files",
    );
    expect(approvalRefusal(refused(409, { code: "diff_basis_moved" }))).toBe("diff_basis_moved");
    expect(approvalRefusal(refused(409, { code: "patch_changed" }))).toBe("patch_changed");
  });

  it("knows a patch that was held or replaced meanwhile", () => {
    for (const code of ["held", "superseded", "held_run_live", "held_needs_diff"] as const) {
      expect(approvalRefusal(refused(409, { code, error: "x" }))).toBe(code);
    }
    expect(approvalRefusal(refused(400, { code: "held" }))).toBeNull();
  });

  it("sends only a decision made without the diff to the patch's page", () => {
    expect(refusalNeedsReview("held_needs_diff")).toBe(true);
    expect(refusalNeedsReview("held")).toBe(false);
    expect(refusalNeedsReview("held_run_live")).toBe(false);
    expect(refusalNeedsReview("superseded")).toBe(false);
  });

  it("is nothing the page acts on otherwise", () => {
    expect(approvalRefusal(refused(409, { code: "other" }))).toBeNull();
    expect(approvalRefusal(refused(409, null))).toBeNull();
    expect(approvalRefusal(refused(400, { code: "too_many_hook_files" }))).toBeNull();
    expect(approvalRefusal(new Error("x"))).toBeNull();
  });

  it("says why in words", () => {
    expect(approvalRefusalMessage("too_many_hook_files")).toBe(HOOK_TOO_MANY);
    expect(approvalRefusalMessage("diff_basis_moved")).toMatch(/diff again/);
    expect(approvalRefusalMessage("patch_changed")).toBe(
      "This patch changed while you were looking. Look at it again.",
    );
    expect(approvalRefusalMessage("held")).toMatch(/on hold/);
    expect(approvalRefusalMessage("superseded")).toBe("A newer patch replaced this one.");
    expect(approvalRefusalMessage("held_run_live")).toMatch(/while its run is still going/);
    expect(approvalRefusalMessage("held_needs_diff")).toMatch(/Review its diff/);
  });
});

describe("a hook check that failed", () => {
  const failed = (over: Partial<Patch> = {}) =>
    patch({ provider: "local", hookCheckError: "the branch is gone", ...over });

  it("parses, and defaults for an older control plane", () => {
    expect(patchSchema.parse(wire).hookCheckError).toBeNull();
    expect(patchSchema.parse({ ...wire, hookCheckError: "x" }).hookCheckError).toBe("x");
  });

  it("is not still checking, and does not block approving", () => {
    // Even if a server still said pending: a failed check is not running.
    expect(isCheckingHooks(failed({ hooksPending: true }))).toBe(false);
    expect(approveBlock(failed({ hooksPending: true }))).toBeNull();
    expect(approveBlock(failed())).toBeNull();
  });

  it("says why while the patch waits", () => {
    expect(hookCheckNotice(failed())).toBe(
      "Ryph couldn't check this change for git hooks: the branch is gone.",
    );
    expect(hookCheckNotice(failed({ hookCheckError: "it is gone." }))).toBe(
      "Ryph couldn't check this change for git hooks: it is gone.",
    );
    expect(hookCheckNotice(failed({ hookCheckError: " " }))).toBe(
      "Ryph couldn't check this change for git hooks.",
    );
    expect(hookCheckNotice(failed({ state: "queued" }))).not.toBeNull();
  });

  it("says nothing once the patch has moved on, or for a patch whose check worked", () => {
    expect(hookCheckNotice(failed({ state: "failed" }))).toBeNull();
    expect(hookCheckNotice(failed({ state: "submitted" }))).toBeNull();
    expect(hookCheckNotice(failed({ hookCheck: hooks(["a"]) }))).toBeNull();
    expect(hookCheckNotice(patch())).toBeNull();
  });
});

describe("the words", () => {
  it("say when hook files run the same way in the warning and the confirmation", () => {
    const when = "the next time you check out, commit or switch branches.";
    expect(HOOK_WARNING_BODY).toContain(when);
    expect(HOOK_CONFIRM_BODY).toContain(when);
  });

  it("say what became of a held patch once it moved on", () => {
    const at = "2026-10-06T00:00:00Z";
    expect(heldNoticeLine(patch({ state: "rejected" }))).toMatch(/rejected/);
    expect(heldNoticeLine(patch({ state: "queued", approvedAt: at }))).toMatch(/approved/);
    expect(heldNoticeLine(patch({ state: "superseded" }))).toMatch(/newer version/);
    expect(heldNoticeLine(null)).toMatch(/waited for approval/);
  });
});
