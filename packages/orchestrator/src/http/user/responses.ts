import type { Response as RunResponse } from "../../core/types.ts";
import { cancelRun } from "../../core/cancel_run.ts";
import { CLOSED_BY_USER, closeRunBinding } from "../../core/conclude_run.ts";
import { postUserMessage } from "../../core/prompt.ts";
import { MAX_PROMPT_BODY_BYTES, PostMessageSchema } from "../../schema.ts";
import type { WiredDeps } from "../app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, parseBody, type Route, route } from "@ryph/shared/http";
import { runGrantsFor, scopeFor } from "../scope.ts";
import { EMBEDDED_MESSAGES, toPublicRun } from "./public_views.ts";
import { nameSenders } from "./message_senders.ts";

/** The most responses one listing answers with, newest first. */
const MAX_RESPONSE_PAGE = 100;

export function responseRoutes(deps: WiredDeps): Route[] {
  const { store, runnerControl } = deps;
  const nowIso = () => deps.now().toISOString();

  // ---- the inbox ---------------------------------------------------------------
  //
  // Authorization here — and on the response routes below — is deliberately "any authenticated
  // principal", not ownership: any logged-in user may speak into any run's inbox, read any
  // response and close one. That matches `cancelTask` in tasks.ts, which has always worked
  // this way, and it is the single-org stance the product assumes — the people with accounts
  // are one team, and a response is the team's to answer. It is a DECISION, not an oversight:
  // a multi-tenancy pass is what must revisit it, and it must revisit all of these together.

  /**
   * The run page's message box: a person speaking to a running agent. It lands in the run's
   * inbox as kind `user` — the runner frames it as untrusted text from a named person — and
   * nothing more. A terminal run refuses it: nobody is there to read it. Images ride it by the
   * ids POST /v1/runs/:id/attachments answered (http/attachments_api.ts).
   */
  const postRunMessage = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:steer");
    if (denied) return denied;
    const run = await store.getRun(params.id);
    const owner = run === null
      ? null
      : await store.getTask(run.taskId, await scopeFor(deps, caller, "tasks:steer-all"));
    if (!run || owner === null) return json(404, { error: "no such run" });
    const body = await parseBody(req, PostMessageSchema, { maxBytes: MAX_PROMPT_BODY_BYTES });
    if (!body.ok) return body.res;
    // The first message to a run whose task awaits its prompt becomes the task (core/prompt.ts).
    const outcome = await postUserMessage(
      { ...deps, platformModel: deps.platformModel ?? null },
      run,
      {
        sender: { kind: "user", userId: caller.kind === "user" ? caller.userId : "break-glass" },
        text: body.data.text,
        attachmentIds: body.data.attachmentIds,
      },
    );
    if (outcome.kind === "refused") {
      // The reason travels too: a run that ended before its prompt is one the page words itself.
      return json(outcome.status, {
        error: outcome.error,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      });
    }
    // The sender is the caller, named off their principal: no read.
    const [[message]] = await nameSenders(deps.identityDirectory, caller, [[outcome.message]]);
    return json(201, { message });
  };

  // ---- responses -----------------------------------------------------------------

  /** A response with what a list renders beside it: the task's title, the agent, the run's state.
   * The row itself carries its correlation `key` and the opening fire's `title`. */
  const describeResponse = async (response: RunResponse) => {
    const [task, run] = await Promise.all([
      store.getTask(response.taskId),
      store.getRun(response.runId),
    ]);
    const agent = task === null ? null : await store.getAgent(task.agentId);
    return {
      ...response,
      taskTitle: task?.spec.title ?? null,
      agentName: agent?.name ?? null,
      runState: run?.state ?? null,
    };
  };

  const listResponses = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:read");
    if (denied) return denied;
    // Bounded: the responses page re-fetches this every five seconds while any response is
    // open, and unbounded it answered with every response ever opened — each one costing a
    // task, an agent and a run read to describe.
    const asked = Number(new URL(req.url).searchParams.get("limit") ?? MAX_RESPONSE_PAGE);
    if (!Number.isInteger(asked) || asked < 1) {
      return json(400, { error: "limit: expected a positive integer" });
    }
    const responses = await store.listResponses(
      Math.min(asked, MAX_RESPONSE_PAGE),
      await scopeFor(deps, caller, "tasks:read-all"),
    );
    return json(200, { responses: await Promise.all(responses.map(describeResponse)) });
  };

  const getResponse = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:read");
    if (denied) return denied;
    const response = await store.getResponse(params.id);
    if (!response) return json(404, { error: "no such response" });
    const [task, run, messages] = await Promise.all([
      store.getTask(response.taskId, await scopeFor(deps, caller, "tasks:read-all")),
      store.getRun(response.runId),
      store.listRecentRunMessages(response.runId, EMBEDDED_MESSAGES),
    ]);
    if (task === null) return json(404, { error: "no such response" });
    const [agent, [named]] = await Promise.all([
      store.getAgent(task.agentId),
      nameSenders(deps.identityDirectory, caller, [messages]),
    ]);
    return json(200, {
      response,
      task,
      agent,
      run: run === null
        ? null
        : { ...toPublicRun(run), grants: await runGrantsFor(deps, caller, run.id) },
      messages: named,
    });
  };

  /**
   * A person closing a response: its run is cancelled exactly as the run page's Cancel does,
   * and the response is closed AT ONCE with that reason — the run's conclusion, when it lands,
   * keeps the reason a person gave rather than overwriting it with the run's state.
   *
   * Its room binding closes at once too, and before the row: the run may stay live for the
   * cancel's grace, and a response sharing its automation's conversation is continued by the
   * next fire the moment this row is closed — which the run, still bound, would have refused,
   * leaving that one unheard. The room hears "cancelled" now; the conclusion finds nothing left
   * to close. A run that was already over keeps its binding for its conclusion, which may for a
   * moment refuse the next shared response the conversation (http/automations_api.ts).
   */
  const closeResponse = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:steer");
    if (denied) return denied;
    const response = await store.getResponse(params.id);
    const owner = response === null
      ? null
      : await store.getTask(response.taskId, await scopeFor(deps, caller, "tasks:steer-all"));
    if (!response || owner === null) return json(404, { error: "no such response" });
    if (response.state === "closed") return json(409, { error: "response is already closed" });
    const run = await store.getRun(response.runId);
    if (run !== null) {
      const cancelled = await cancelRun(
        { store, runnerControl, environments: deps.environments, now: deps.now },
        run,
      );
      // Only a run this close actually stopped is "cancelled" in the room. One already over
      // (its result landed between the read above and the cancel) is being concluded, and its
      // conclusion closes the binding with how it really went; said here, a run that succeeded
      // would be announced as cancelled and its own line never said.
      if (response.chatroomId !== null && cancelled.kind !== "terminal") {
        await closeRunBinding(
          { store, chatAccess: deps.chatAccess, appUrl: deps.config.appUrl },
          run,
          "cancelled",
        ).catch((err) =>
          deps.diag.warn("response.binding_close_failed", { runId: run.id, err: String(err) })
        );
      }
    }
    // Narrow and conditional: a fire or a message in flight must not be able to put the
    // row back to open, and a conclusion racing this one finds nothing left to close.
    await store.closeResponse(response.id, nowIso(), CLOSED_BY_USER);
    return json(202, { runId: response.runId });
  };

  return [
    route("POST", "/v1/runs/:id/messages", postRunMessage),
    route("GET", "/v1/responses", listResponses),
    route("GET", "/v1/responses/:id", getResponse),
    route("POST", "/v1/responses/:id/close", closeResponse),
  ];
}
