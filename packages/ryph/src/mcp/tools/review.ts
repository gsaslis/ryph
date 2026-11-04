// Deciding on what runs produced: patches (read, diff, approve, reject, retry) and responses (the
// runs automations opened as conversations).
//
// An approval can name the basis its diff was read on (`patches {action: "diff"}` hands it out):
// the control plane then refuses it if what the patch would publish moved since, exactly as the
// patch page's Approve does. One made without a basis acts on the patch as it stands, as the
// queue's own button does; a held patch refuses that.

import { ApiError, type RyphClient, UsageError } from "../../api/client.ts";
import { needString, optBool, optObject, optStrings, seg } from "../args.ts";
import { fence } from "@ryph/shared/markdown";
import { ago, clip, cut, lines, record } from "../format.ts";
import { FULL_HINT, resourceTool } from "../resource.ts";
import { DESTRUCTIVE, object, oneOf, str, strings, type Tool } from "../tool.ts";

/** The git hook files a `local` patch changes, as the forge read them; null on other forges. */
interface HookCheck {
  touched: string[];
  hooksPaths: string[];
  more: boolean;
}

type PatchHead = { state?: string; hookCheck?: HookCheck | null };

/** A patch's state and hook check, or null when it could not be read. For rendering only. */
async function patchOf(api: RyphClient, patchId: string): Promise<PatchHead | null> {
  const answer = await api.json<{ patch: PatchHead }>("GET", `/v1/patches/${seg(patchId)}`)
    .catch(() => null);
  return answer?.patch ?? null;
}

/**
 * A patch's hook check before approving it: null when it has none, or when the patch is not
 * found (the approval then gets the server's own answer). Any other failure to read it refuses
 * the approval, so an unread check is never taken for a passed one.
 */
async function hookCheckBeforeApproving(
  api: RyphClient,
  patchId: string,
): Promise<HookCheck | null> {
  try {
    const answer = await api.json<{ patch: PatchHead }>("GET", `/v1/patches/${seg(patchId)}`);
    return answer?.patch?.hookCheck ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    const status = err instanceof ApiError ? err.status : 0;
    const said = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      status,
      `${patchId}'s git hook check could not be read (${said}), so the approval was not sent`,
      err instanceof ApiError ? err.code : null,
    );
  }
}

/** The one state the control plane approves from (core/patch_lifecycle.ts `approvePatch`). */
const APPROVABLE = "pending_approval";

/** What a diff's `mode` means, for its header. */
const MODE_MEANS: Record<string, string> = {
  live: "live: not yet published, so measured now against where it would land",
  record: "record: settled, so measured from where the run cut it",
};

interface PatchRow {
  id: string;
  state: string;
  taskId: string;
  runId: string;
  taskTitle?: string | null;
  agentName?: string | null;
  repoRef?: string | null;
  branchName: string;
  heldReason?: string | null;
  forgeUrl: string | null;
  title?: string | null;
  checks?: { state: string } | null;
  createdAt: string;
}

function patchLine(p: PatchRow): string {
  return `- ${p.id} ${p.state}${p.heldReason ? " (held)" : ""} · ${
    p.repoRef ?? "?"
  } ${p.branchName}` +
    `${p.title ? ` "${clip(p.title, 80)}"` : ""} · task ${p.taskId} "${clip(p.taskTitle, 60)}"${
      p.checks ? ` · checks ${p.checks.state}` : ""
    }${p.forgeUrl ? ` · ${p.forgeUrl}` : ""} · ${ago(p.createdAt)}`;
}

/** The most of a diff an answer carries. */
const DIFF_MAX = 120_000;

const patches = resourceTool({
  name: "patches",
  description: "Read patches: the branches runs submitted, waiting for approval or on their way " +
    "to the forge. diff answers a basis to pass to patch_review when approving.",
  needs: ["patches:read"],
  actions: {
    list: {
      method: "GET",
      path: "/v1/patches",
      doc: "newest first (state: pending_approval|queued|submitting|submitted|failed|rejected|" +
        "superseded)",
      query: ["state", "limit", "cursor"],
      render: (a) => {
        const page = a as { patches: PatchRow[]; nextCursor: string | null; hasMore: boolean };
        return lines(
          page.patches.length === 0 ? "No patches." : page.patches.map(patchLine),
          page.hasMore && `More: {action: "list", cursor: "${page.nextCursor}"}`,
        );
      },
    },
    get: {
      method: "GET",
      path: "/v1/patches/{patchId}",
      doc: "one patch, its commits and checks, and what its diff is measured against",
    },
    diff: {
      method: "GET",
      path: "/v1/patches/{patchId}/diff",
      doc: "what the patch changes",
      render: async (a, ctx, args) => {
        const d = a as {
          diff: string;
          baseSha: string;
          headSha: string;
          truncated: boolean;
          omitted: string[];
          moreOmitted?: boolean;
          mode: string;
          targetRef: string;
          sincePatchId: string | null;
        };
        const basis = {
          mode: d.mode,
          targetRef: d.targetRef,
          sincePatchId: d.sincePatchId,
          baseSha: d.baseSha,
        };
        // A patch to a repository on the deployment's machine that changes git hooks is
        // approved only for the hook files the approval names: the rest hold it again.
        const api = await ctx.api();
        const patchId = String(args.patchId);
        const patch = await patchOf(api, patchId);
        const hooks = patch?.hookCheck ?? null;
        const touched = hooks?.touched ?? [];
        // A cut diff is not "exactly this": an approval would cover lines nobody here read, so no
        // ready-made approval is offered, only the basis as data. Nor does it name the hook
        // files: they may be in the part not shown.
        const shortened = d.truncated || d.diff.length > DIFF_MAX;
        const approve = `patch_review {patchId: "${patchId}", action: "approve", basis: ${
          JSON.stringify(basis)
        }${touched.length > 0 ? `, hookPaths: ${JSON.stringify(touched)}` : ""}}`;
        // Its state unread, the patch may still be approvable: the line is offered and the
        // server judges.
        const approvable = patch?.state === undefined || patch.state === APPROVABLE;
        return lines(
          `Diff ${d.baseSha.slice(0, 12)}..${d.headSha.slice(0, 12)} against ${d.targetRef} (${
            MODE_MEANS[d.mode] ?? d.mode
          })` +
            `${d.sincePatchId ? `, only what it adds to ${d.sincePatchId}` : ""}.`,
          d.truncated && "The forge cut this diff short.",
          d.omitted.length > 0 &&
            `Files left out: ${d.omitted.join(", ")}${
              d.moreOmitted ? ", and more than this list names" : ""
            }`,
          d.omitted.length === 0 && d.moreOmitted && "More files are left out than can be named.",
          fence(cut(d.diff, DIFF_MAX), "diff"),
          touched.length > 0 &&
            `It changes git hook files, which run on the deployment's machine: ${
              touched.join(", ")
            }${hooks?.more ? " and more than the check could list" : ""}. ${
              shortened
                ? "The diff above was cut short, so some of them may be in the part not shown " +
                  "or among the files left out: read each one in the app before approving."
                : "Read them above."
            }`,
          !approvable
            ? `${String(args.patchId)} is ${patch!.state}, not ${APPROVABLE}: there is nothing ` +
              "to approve."
            : hooks?.more
            ? "Too many hook files to approve; reject it, or have the run change fewer."
            : shortened
            ? "This diff was truncated, so not all of it is here: a person should review and " +
              `approve the patch in the app, ${api.appUrl(`/patches/${seg(patchId)}`)}. If a ` +
              `person decides to approve through this tool anyway, pass basis ${
                JSON.stringify(basis)
              }${
                touched.length > 0
                  ? " and hookPaths naming each hook file they read in the app"
                  : ""
              }.`
            : `To approve exactly this: ${approve}`,
        );
      },
    },
  },
  params: { limit: { type: "integer", minimum: 1, maximum: 100 } },
});

const patchReview: Tool = {
  name: "patch_review",
  description: "Approve, reject or retry a patch. Approving sends it to the forge (a pull " +
    "request or a Radicle patch). Pass the basis patches {action: diff} gave to approve " +
    "exactly the diff you read; a held patch needs it. A patch that changes git hook files " +
    "is refused unless hookPaths names each one.",
  inputSchema: object({
    patchId: str("The patch (p-…)."),
    action: oneOf(["approve", "reject", "retry"], "What to do."),
    basis: {
      type: "object",
      description: "From patches {action: diff}: {mode, targetRef, sincePatchId, baseSha}.",
      additionalProperties: true,
    },
    hookPaths: strings(
      "A patch to a repository on this machine that touches git hook files: the hook files " +
        "you were shown and approve.",
    ),
  }, ["patchId", "action"]),
  annotations: DESTRUCTIVE,
  needs: ["patches:review"],
  routes: [
    ["GET", "/v1/patches/{patchId}"],
    ["POST", "/v1/patches/{patchId}/approve"],
    ["POST", "/v1/patches/{patchId}/reject"],
    ["POST", "/v1/patches/{patchId}/retry"],
  ],
  run: async (args, ctx) => {
    const patchId = needString(args, "patchId");
    const action = needString(args, "action");
    if (!["approve", "reject", "retry"].includes(action)) {
      throw new UsageError("action: approve, reject or retry");
    }
    const basis = optObject(args, "basis");
    const hookPaths = optStrings(args, "hookPaths");
    if (action === "reject" && (basis || hookPaths)) {
      throw new UsageError("a rejection takes no basis or hook paths");
    }
    const api = await ctx.api();
    if (action === "approve") {
      // Approved without naming every hook file it changes, the patch is queued and then held
      // again on the forge: refused here instead, with what to read.
      const touched = (await hookCheckBeforeApproving(api, patchId))?.touched ?? [];
      const missing = touched.filter((p) => !(hookPaths ?? []).includes(p));
      if (missing.length > 0) {
        throw new UsageError(
          `${patchId} changes git hook files: ${missing.join(", ")}. Read them in patches ` +
            `{action: "diff", patchId: "${patchId}"}, then approve with hookPaths naming each ` +
            "one you approve; a hook file left out holds the patch again.",
        );
      }
    }
    const decision = {
      ...(basis !== undefined ? { diffBasis: basis } : {}),
      ...(hookPaths !== undefined ? { hookPaths } : {}),
    };
    const answer = await api.json<{ patch: PatchRow }>(
      "POST",
      `/v1/patches/${seg(patchId)}/${action}`,
      Object.keys(decision).length > 0 ? decision : undefined,
    );
    return `Patch ${answer.patch.id} is now ${answer.patch.state}.`;
  },
};

interface ResponseRow {
  id: string;
  automationId: string;
  taskId: string;
  runId: string;
  state: string;
  title: string | null;
  key?: string;
  alerts: number;
  lastActivityAt: string;
  taskTitle?: string | null;
  agentName?: string | null;
  runState?: string | null;
  closedReason: string | null;
}

const responses = resourceTool({
  name: "responses",
  description: "Read responses: runs an automation opened as an ongoing conversation " +
    "(an alert being handled), with the fires that joined them.",
  needs: ["tasks:read"],
  actions: {
    list: {
      method: "GET",
      path: "/v1/responses",
      doc: "the newest responses",
      query: ["limit"],
      render: (a) => {
        const rows = (a as { responses: ResponseRow[] }).responses;
        if (rows.length === 0) return "No responses.";
        return rows.map((r) =>
          `- ${r.id} ${r.state}${r.closedReason ? ` (${r.closedReason})` : ""} · "${
            clip(r.title ?? r.taskTitle, 80)
          }" · ${r.alerts} alerts · task ${r.taskId}, run ${r.runId} ${r.runState ?? ""} · ` +
          `automation ${r.automationId} · ${ago(r.lastActivityAt)}`
        ).join("\n");
      },
    },
    get: {
      method: "GET",
      path: "/v1/responses/{responseId}",
      doc: "one response, its task, run and inbox",
      // Its inbox is every alert's payload: each cut short, unless asked for in full.
      render: (a, _ctx, args) => {
        const r = a as { response: ResponseRow; messages: unknown[] };
        return record(
          { ...r, run: undefined },
          optBool(args, "full") === true ? { maxString: Infinity } : {
            maxString: 800,
            more: FULL_HINT,
          },
        );
      },
    },
  },
  params: { limit: { type: "integer", minimum: 1, maximum: 100 } },
});

const responseClose: Tool = {
  name: "response_close",
  description: "Close a response: its run is cancelled and the response closed as handled.",
  inputSchema: object({ responseId: str("The response.") }, ["responseId"]),
  annotations: DESTRUCTIVE,
  needs: ["tasks:steer"],
  routes: [["POST", "/v1/responses/{responseId}/close"]],
  run: async (args, ctx) => {
    const id = needString(args, "responseId");
    const answer = await (await ctx.api()).json<{ runId: string }>(
      "POST",
      `/v1/responses/${seg(id)}/close`,
    );
    return `Closed; run ${answer.runId} was asked to stop.`;
  },
};

export const reviewTools: Tool[] = [patches, patchReview, responses, responseClose];
