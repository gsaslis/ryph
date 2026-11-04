// The automations surface: POST /v1/automations/events (and /access, the hourly keep-warm
// access check), spoken only by the automations service and authenticated by the shared
// RYPH_AUTOMATIONS_TOKEN. A fire arrives already verified (or minted by the scheduler) with the
// automation's stored recipe; every decision that must not be stale happens here, per event, at
// fire time — the agent's existence, the owner's live repo access, the dedupe — and ends in
// startTask with origin "automation".
//
// The ladder answers 200 for every DECISION (started, refused, denied — the automations
// queue must never retry a business verdict) and 5xx only when the question could not be
// asked (GitHub outage mid-permission-check with no recent access on record, no forge
// wired), where a retry genuinely helps. An outage with the owner's access confirmed within
// OUTAGE_ACCESS_GRACE_MS still starts: an alert is most likely to fire when GitHub is down.
// The same discipline as the forge events door, minus the thread-side replies: an automation
// has no thread to answer into, so verdicts land only in the event row, which the automations
// service reads back into its fire history.
//
// An automation that names a RESPONSE fires differently: the first fire opens one — a run, a
// chatroom conversation bound to it — and every fire that arrives for the same SLOT while it is
// open JOINS it as a message in the run's inbox, starting nothing. The response closes when the
// run does, and the next fire for that slot opens a new one. The slot is the automation's
// correlation applied to the fire (core/fire_signal.ts `responseSlotKey`): the automation as a
// whole, the key the sender named (one alert group, one PagerDuty incident), or the fire itself.
//
// What a fire says of itself — its `signal`, read by the automations service with the trigger's
// payload format — decides the door's verdict when nothing is open for the slot: a `resolved`
// fire is dropped (nothing to respond to), an `update` is dropped as `ignored` (an acknowledgement
// never starts a run, with or without a response policy), and `firing` or `unknown` opens one.
// The orchestrator parses no payload; the verbatim payload still rides to the run.

import { startTask, type StartTaskRepo } from "../core/start_task.ts";
import { startTaskDeps } from "./start_deps.ts";
import { conclusionOverdue, releaseRunBinding, runUrlOf } from "../core/conclude_run.ts";
import { postMessage } from "../core/inbox.ts";
import { isTerminal } from "../core/lifecycle.ts";
import { cancelRun } from "../core/cancel_run.ts";
import { resolveWorkspace, singleRepoStart, workspaceStartRepos } from "../core/workspaces.ts";
import {
  type AutomationEventOutcome,
  type AutomationTarget,
  type ConnectedRepo,
  type FireSignal,
  type ForgeProvider,
  type InboundAutomationEvent,
  MAX_RESPONSE_ALERTS,
  type Response as RunResponse,
  type Run,
  type Workspace,
} from "../core/types.ts";
import { forgeRepoRef } from "../core/forge_repo.ts";
import { automationTaskTitle, normalizeSignal, responseSlotKey } from "../core/fire_signal.ts";
import {
  composeAutomationInstructions,
  frameFire,
  responseTopic,
  sharedResponseTopic,
} from "./automation_framing.ts";
import {
  type BindingConversation,
  type ChatThread,
  ConversationBusyError,
} from "../ports/chat_access.ts";
import { composeContinuedResponse } from "../core/thread_context.ts";
import { makeServiceGate, mintId } from "@ryph/sealed";
import { AutomationAccessProbeSchema, AutomationEventSchema } from "../schema.ts";
import type { WiredDeps } from "./app.ts";
import { json, parseBody, type Route, route } from "@ryph/shared/http";
import { FORGE_CHECK_CONCURRENCY, mapWithConcurrency } from "../helpers/concurrency.ts";

/** As the forge door's reclaim window: how long a claim may sit at "processing" before a
 * redelivery adopts it. Well under the automations queue's total retry span. */
const PROCESSING_RECLAIM_MS = 5 * 60_000;

/** The full 2 MiB webhook payload is forwarded in JSON: control bytes can expand sixfold
 * when escaped. Leave room for that expansion, instructions and event metadata. */
export const MAX_AUTOMATION_EVENT_BODY_BYTES = 16 * 1024 * 1024;

/** How much of the opening fire's payload travels to the chat service for a `postAlert` opening
 * line — far more than the line shows, so a JSON body short enough to show still parses. Matches
 * the chat service's `OpenBindingSchema`. */
export const ALERT_PAYLOAD_MAX = 64 * 1024;

/** The ladder itself, extracted from the HTTP handler so a single-process composition can
 * hand events over without a loopback hop — the same reason startTask is extracted from its
 * handlers. Returns the HTTP-shaped verdict; the route below only adds token auth and zod. */
export async function handleAutomationEvent(
  deps: WiredDeps,
  event: InboundAutomationEvent,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { store, diag, config } = deps;
  const nowIso = () => deps.now().toISOString();
  // Bounded again here, not only by the ingest schema: the single-process composition hands
  // events over without zod, and the title lands in a topic, a task title and a message header.
  const signal = normalizeSignal(event.signal);
  // The slot this fire belongs to among the automation's open responses. Every read and write of
  // an open response below uses it — the join, the stale close, the race re-read — so two keys
  // never see each other's response.
  //
  // A shared conversation is always correlated per automation: one response holds it at a time,
  // and the automations service never sends another pairing. Forced here too, so a sender that
  // did could not open two responses at once, both bound to one conversation.
  const correlation = event.response?.conversation === "shared"
    ? "automation"
    : event.response?.correlation ?? "automation";
  const slot = event.response === null ? null : responseSlotKey(correlation, signal, event.eventId);
  const taskTitle = automationTaskTitle(event.name);

  const eventRecord = (outcome: AutomationEventOutcome, taskId: string | null = null) => ({
    eventId: event.eventId,
    automationId: event.automationId,
    outcome,
    taskId,
    receivedAt: event.firedAt,
    createdAt: nowIso(),
    claimedAt: null,
  });
  const concluded = async (outcome: AutomationEventOutcome, taskId: string | null = null) => {
    await store.recordAutomationEvent(eventRecord(outcome, taskId));
    return { status: 200, body: { outcome } };
  };

  // A recorded verdict is THE answer for this eventId, forever: a redelivery repeats it
  // instead of re-running the ladder, so a world that changed since (an agent deleted, access
  // revoked) can never overwrite what actually happened — least of all a "started" row whose
  // taskId links a run that is really out there.
  const reclaimBefore = new Date(deps.now().getTime() - PROCESSING_RECLAIM_MS).toISOString();
  const repeatVerdict = (rec: { outcome: string; taskId: string | null }) => ({
    status: 200,
    body: { outcome: rec.outcome === "started" ? "deduped" : rec.outcome, taskId: rec.taskId },
  });
  const existing = await store.getAutomationEvent(event.eventId);
  if (existing !== null && existing.outcome === "processing") {
    const stale = existing.claimedAt === null || existing.claimedAt < reclaimBefore;
    if (!stale) {
      // In flight elsewhere (or a crash too fresh to call): retryable, and deliberately not
      // "deduped" — deduped would mark the hook delivered while nothing may have happened.
      return { status: 503, body: { error: "event is already being handled — retry later" } };
    }
    // A stale claim falls through: the conditional claim below is what adopts it.
  } else if (existing !== null) {
    return repeatVerdict(existing);
  }

  const agent = await store.getAgent(event.agentId);
  if (agent === null || agent.archivedAt !== null) {
    return await concluded("no-such-agent");
  }

  // The owner's standing in ryph, asked LIVE on every fire and before anything else — a join
  // included: the owner still exists and is active. An owner who can no longer sign in can no
  // longer fire work, nor steer the run already going for them. For a forge repo the login
  // lookup below used to be this gate by accident — a deleted user has no linked identity — but
  // a join never reaches it, a local repo skips it, and a deactivated user keeps their links. No
  // directory to ask is no answer, and an unattended fire does not guess.
  const ownerActive = deps.identityDirectory
    ? await deps.identityDirectory.isActiveUser(event.ownerUserId)
    : false;
  if (!ownerActive) return await concluded("denied");
  // ...and whose role, as stored now, still lets them start tasks: saving an automation asks for
  // `tasks:create`, and an owner demoted since must not keep firing work, or joining it, as them.
  if (!(await deps.identityDirectory?.mayStartTasks(event.ownerUserId) ?? false)) {
    diag.warn("automation_event.owner_role_refused", {
      automationId: event.automationId,
      ownerUserId: event.ownerUserId,
    });
    return await concluded("denied");
  }

  // A response already open for this fire's slot: the fire JOINS it and nothing starts, whatever
  // its status. No rate-limit budget is spent — none exists on this side — and no gate is re-run:
  // the run that is going was gated when it opened, and a message cannot widen what it may do.
  // The claim below still fences the write, so a redelivered fire lands once.
  if (event.response !== null && slot !== null) {
    const open = await store.findOpenResponse(event.automationId, slot);
    // Whether a response may be JOINED is the RUN's question, never the row's alone. The only
    // thing that closes a response is `concludeRun`, and it closes best-effort: a crash between
    // the result landing and that close strands an open response on a terminal run. Filtering
    // on `state <> 'closed'` alone, every later fire would join that row forever — postMessage
    // answers 409, the door answers "joined", and no run is ever started for this slot again,
    // silently. So a stale response is closed here and the fire falls through and opens a new
    // one — its room binding released first, without a word, since whatever stranded the row
    // likely stranded that too, and it holds the conversation the next response may continue.
    //
    // Only once the run's conclusion is overdue (`CONCLUSION_GRACE_MS`). A run only just over is
    // usually still being concluded, and its binding is closed with its closing line before this
    // row; released here first, that line is never said. So within the grace the binding is left
    // to the conclusion. A row on its own conversation is closed and the fire goes on, as it
    // always did. A SHARED one is answered retryable instead: the next response would continue
    // a conversation the run still holds and be refused, and run unheard. The conclusion closes
    // this row in seconds, and the redelivery finds nothing open.
    const openRun = open === null ? null : await store.getRun(open.runId);
    if (open !== null && (openRun === null || isTerminal(openRun))) {
      const overdue = conclusionOverdue(openRun, open, deps.now());
      if (!overdue && open.chatroomId !== null && open.conversation === "shared") {
        return {
          status: 503,
          body: { error: "the last response is still finishing — retry later" },
        };
      }
      if (overdue && open.chatroomId !== null) {
        await releaseRunBinding(deps, open.runId, openRun?.state ?? "lost");
      }
      await store.closeResponse(open.id, nowIso(), openRun?.state ?? "lost");
      diag.warn("automation_event.stale_response_closed", {
        responseId: open.id,
        runId: open.runId,
        runState: openRun?.state ?? null,
      });
    } else if (open !== null && openRun !== null) {
      const claim = { ...eventRecord("processing", open.taskId), claimedAt: nowIso() };
      if (!await store.claimAutomationEvent(claim, reclaimBefore)) {
        const raced = await store.getAutomationEvent(event.eventId);
        if (raced !== null && raced.outcome !== "processing") return repeatVerdict(raced);
        return { status: 503, body: { error: "event is already being handled — retry later" } };
      }
      const joined = await joinResponse(deps, open, openRun, event, signal);
      await store.recordAutomationEvent(eventRecord("joined", open.taskId));
      diag.debug("automation_event.joined", {
        eventId: event.eventId,
        responseId: open.id,
        alerts: joined.alerts,
        embedded: joined.embedded,
      });
      return {
        status: 200,
        body: { outcome: "joined", taskId: open.taskId, runId: open.runId, responseId: open.id },
      };
    }
    // Nothing open, and the fire says the problem is over: there is nothing to respond to. A
    // response is opened by something firing; a resolve that finds nobody responding — the run
    // ended before the sender noticed, or judged the alarm false while it still fired — would
    // otherwise open a fresh conversation, "on it", for a problem that has already gone away.
    // It is dropped with its own verdict so the fire history says why nothing started. A
    // resolve that finds a run going still joined it above: that is how the agent sees its fix
    // take.
    if (signal.status === "resolved") return await concluded("resolved");
  }
  // A status update — acknowledged, assigned, escalated — with nobody responding to hear it. It
  // reports on something, it is not something to act on: it never starts a run, with a response
  // policy or without one (an automation with none starts a run per fire, but "someone clicked
  // acknowledge" is not a fire worth a run). Its own verdict, so the history says why.
  if (signal.status === "update") return await concluded("ignored");

  // What the fire checks out: the one repo, or the workspace's whole list — resolved NOW, so an
  // edited workspace fires as it stands and a workspace that lost a member refuses, naming it.
  const checkout = await resolveCheckout(deps, event.target);
  if (checkout.kind === "missing") return await concluded(checkout.outcome);
  if (checkout.kind === "refused") {
    await store.recordAutomationEvent(eventRecord("refused"));
    return { status: 200, body: { outcome: "refused", detail: checkout.detail } };
  }
  const { repos, workspace } = checkout;

  if (!deps.forge) {
    return { status: 503, body: { error: "the forge is not configured on this orchestrator" } };
  }

  const access = await checkOwnerAccess(deps, event.ownerUserId, repos);
  if (access.kind === "no-linked-identity") return await concluded("no-linked-identity");
  if (access.kind === "denied") return await concluded("denied");
  if (access.kind === "unknown") {
    return {
      status: 503,
      body: { error: "could not verify the owner's access — retry later" },
    };
  }
  if (access.confirmedAt !== null) {
    diag.warn("automation_event.access_from_cache", {
      eventId: event.eventId,
      automationId: event.automationId,
      confirmedAt: access.confirmedAt,
    });
  }

  if (config.gitGateway === null) {
    return await concluded("refused");
  }

  // The conversation a shared response continues, read for its run — before the claim, as the
  // mention door reads its thread: a read-only rung costs a redelivery nothing.
  const continued = await continuedConversation(deps, event);

  // startTask is the one side effect here, so the claim sits directly in front of it: one
  // winner per event id, decided by the insert, with the stale-"processing" crash escape.
  const claim = { ...eventRecord("processing"), claimedAt: nowIso() };
  if (!await store.claimAutomationEvent(claim, reclaimBefore)) {
    // Lost to a racer between the read above and here. Its verdict, if already in, is this
    // delivery's answer too; a racer still mid-flight gets the same retryable no as above.
    const raced = await store.getAutomationEvent(event.eventId);
    if (raced !== null && raced.outcome !== "processing") return repeatVerdict(raced);
    return { status: 503, body: { error: "event is already being handled — retry later" } };
  }

  const outcome = await startTask(
    startTaskDeps(deps),
    {
      agent,
      spec: {
        title: taskTitle,
        instructions: withContinuedConversation(
          continued,
          composeAutomationInstructions(
            event.instructions,
            event.payload,
            event.response === null ? null : repos,
            signal,
          ),
        ),
      },
      repos,
      ...(workspace === undefined ? {} : { workspace }),
      origin: "automation",
      requestedByUserId: event.ownerUserId,
      // Without a response nobody joins the run: it finishes once its work is in.
      ...(event.response === null ? { unattended: true } : {
        lifetime: {
          idleMs: event.response.idleMs,
          attendedIdleMs: event.response.attendedIdleMs,
        },
        ...(event.response.chatroomId === null ? {} : { chatroomId: event.response.chatroomId }),
      }),
    },
  );
  if (outcome.kind === "refused") {
    // A 503-shaped refusal (the forge briefly unreadable for .ryph/services.yml) is a moment,
    // not a verdict: the claim is released, so the next redelivery runs the ladder again
    // rather than waiting out the reclaim window. startTask refuses this way before it has
    // written anything. Everything else concludes, with the reason riding to the fire history.
    if (outcome.status === 503) {
      await store.releaseAutomationEvent(event.eventId, claim.claimedAt);
      return { status: 503, body: { error: outcome.error } };
    }
    await store.recordAutomationEvent(eventRecord("refused"));
    return { status: 200, body: { outcome: "refused", detail: outcome.error } };
  }

  diag.debug("automation_event.started", {
    eventId: event.eventId,
    automationId: event.automationId,
    taskId: outcome.taskId,
    runId: outcome.runId,
  });

  // The fire opened a RESPONSE: the durable thing the run is an attempt at, and — when the
  // automation names a chatroom — the room bound to it, which hears the platform's opening
  // line at once. A room that could not be bound is warned about; the run goes on without it.
  let responseId: string | undefined;
  if (event.response !== null && slot !== null) {
    const at = nowIso();
    const response: RunResponse = {
      id: mintId("resp"),
      automationId: event.automationId,
      taskId: outcome.taskId,
      runId: outcome.runId,
      chatroomId: event.response.chatroomId,
      state: "open",
      key: slot,
      title: signal.title,
      conversation: event.response.conversation,
      alerts: 1,
      openedAt: at,
      lastAlertAt: at,
      lastActivityAt: at,
      closedAt: null,
      closedReason: null,
    };
    const opened = await store.createResponse(response);
    if (!opened) {
      // Another fire opened this slot's response between the door's check at the top and here.
      // The index is what decides it, because `findOpenResponse` … `startTask` …
      // `createResponse` is a read-then-write with no lock, and the per-event claim is keyed on
      // eventId so it does not serialize two DIFFERENT fires. This fire lost, and the run it
      // just started is surplus — two runs on one problem, both posting into one room — so it
      // is cancelled and the fire joins the response that won, exactly as it would have at the
      // top had it arrived a moment later.
      const surplus = await store.getRun(outcome.runId);
      if (surplus !== null) {
        await cancelRun({
          store,
          runnerControl: deps.runnerControl,
          environments: deps.environments,
          now: deps.now,
        }, surplus);
      }
      const won = await store.findOpenResponse(event.automationId, slot);
      if (won !== null) {
        const wonRun = await store.getRun(won.runId);
        if (wonRun !== null && !isTerminal(wonRun)) {
          await joinResponse(deps, won, wonRun, event, signal);
        }
      }
      diag.warn("automation_event.response_raced", {
        eventId: event.eventId,
        cancelled: outcome.runId,
        joined: won?.id ?? null,
      });
      await store.recordAutomationEvent(eventRecord("joined", won?.taskId ?? outcome.taskId));
      return {
        status: 200,
        body: {
          outcome: "joined",
          taskId: won?.taskId ?? outcome.taskId,
          runId: won?.runId ?? outcome.runId,
          ...(won === null ? {} : { responseId: won.id }),
        },
      };
    }
    responseId = response.id;
    const chatAccess = deps.chatAccess;
    const chatroomId = event.response.chatroomId;
    if (chatroomId !== null && chatAccess) {
      await responseConversation(deps, event, response.id, signal).then((conversation) =>
        chatAccess.openBinding({
          runId: outcome.runId,
          chatroomId,
          conversation,
          agentName: agent.name,
          taskTitle,
          runUrl: runUrlOf(config.appUrl, outcome.taskId),
          ...(event.response?.postAlert && event.payload.trim() !== ""
            ? {
              // The room is shown a capped excerpt; the rest of a 2 MB payload would only travel.
              alert: { title: signal.title, payload: event.payload.slice(0, ALERT_PAYLOAD_MAX) },
            }
            : {}),
        })
      ).catch(async (err) => {
        diag.warn("automation_event.binding_failed", {
          responseId: response.id,
          chatroomId: event.response?.chatroomId,
          err: String(err),
        });
        // The run goes on without its room, and nobody in the room will hear of it, so its page
        // says so. A busy conversation is the one a person can act on: a mention's run in the
        // shared topic still holds it, and this response waits its turn there no longer.
        await store.appendEvent({
          runId: outcome.runId,
          at: nowIso(),
          kind: "chat.unbound",
          detail: err instanceof ConversationBusyError
            ? "it was busy"
            : "the chat service refused or did not answer",
        }).catch(() => {});
      });
    }
  }
  await store.recordAutomationEvent(eventRecord("started", outcome.taskId));
  return {
    status: 200,
    body: {
      outcome: "started",
      taskId: outcome.taskId,
      runId: outcome.runId,
      ...(responseId === undefined ? {} : { responseId }),
      ...(access.confirmedAt === null ? {} : {
        detail: `The forge could not be reached, so this started on the owner's access as last ` +
          `confirmed at ${access.confirmedAt}.`,
      }),
    },
  };
}

/**
 * Which conversation a response's room binding asks for. On Telegram the room is the one
 * conversation a response room always was, and "" is its key. On a platform with channels a
 * response gets a conversation of its own in the automation's channel — a Zulip topic named for
 * the fire, a Slack thread, a Discord thread named for the fire — keyed on the opening line the
 * chat service posts there; or, when the automation's responses SHARE one, the conversation its
 * previous response was in, continued on the same key message (the chat service opens a new one,
 * under the automation's name alone, when that one is gone).
 *
 * The previous responses are the automation's newest few other SHARED ones, in any state: with
 * the correlation a shared conversation forces, they closed before this one could open. Several,
 * because the chat service continues the newest that was ever bound there — one whose binding
 * failed must not break the chain — and only shared ones, because one opened per-response sits in
 * a topic named for its own fire. A previous run that is over and still holds its binding (its
 * conclusion could not reach the chat service) would have the continuation refused, and this run
 * go unheard; so that binding is released first, without a word (`releaseRunBinding`) — once
 * its conclusion is done with the conversation or overdue (`conclusionOverdue`), so a closing
 * line still on its way is never swallowed. Within the grace the binding is left, and this continuation is refused: the
 * door already holds back a fire while a shared response is still open, so only a person closing
 * one whose run had just finished leads here, and the run's page then says it could not post.
 */
async function responseConversation(
  deps: WiredDeps,
  event: InboundAutomationEvent,
  responseId: string,
  signal: FireSignal,
): Promise<BindingConversation> {
  const policy = event.response;
  if (policy === null || policy.channelId === null) return { kind: "thread", threadKey: "" };
  if (policy.conversation !== "shared") {
    return {
      kind: "new",
      channelId: policy.channelId,
      topic: responseTopic(event.name, event.firedAt, signal.title),
    };
  }
  const topic = sharedResponseTopic(event.name);
  const previous = await deps.store.listSharedResponses(
    event.automationId,
    responseId,
    MAX_CONTINUED_FROM,
  );
  if (previous.length === 0) return { kind: "new", channelId: policy.channelId, topic };
  // Newest first, and only as far as the one the chat service will continue: the newest bound
  // in this room (`previousBinding` there). Anything older is settled already: that newer run
  // could only bind in this conversation once nothing else held it, and an older binding in
  // another conversation refuses nothing here. One whose run never bound (`chat.unbound`: its
  // open failed, or was refused) or that sat in another room is stepped over — released anyway
  // (a timed-out open may have bound after all, and a release is idempotent) — so a leak behind
  // it, the one that refused it, is still found. One fire, then, asks about one previous run as
  // a rule — not every one of the last few, every fire, forever.
  for (const response of previous) {
    if (response.chatroomId === null) continue;
    const run = await deps.store.getRun(response.runId);
    if (conclusionOverdue(run, response, deps.now())) {
      await releaseRunBinding(deps, response.runId, run?.state ?? "lost");
    }
    if (
      response.chatroomId === policy.chatroomId &&
      !await deps.store.hasRunEvent(response.runId, "chat.unbound")
    ) break;
  }
  return {
    kind: "continue",
    previousRunIds: previous.map((r) => r.runId),
    channelId: policy.channelId,
    topic,
  };
}

/** How many of an automation's previous shared responses a new one may continue from: enough to
 * step over a few whose binding failed, few enough that each fire asks about a handful. */
const MAX_CONTINUED_FROM = 5;

/**
 * The conversation a SHARED response is about to continue, for its run to read: the chat
 * service's answer for the same previous runs `responseConversation` will hand the binding, read
 * by the same rule — the newest bound in the room, its key message still in the policy's channel
 * — so a run is shown the conversation it would be bound to, or none. Asked before the task
 * exists, because the task's instructions are written once, at its start — and so before the
 * bind, which may still be refused (the run's page then says so, `chat.unbound`) or fall back
 * to a new conversation.
 *
 * Null for everything else: a per-response conversation (a fresh topic has nothing in it), a
 * room without channels, a first response, a conversation that is gone. And null, with a
 * warning, when the chat service could not answer: the history is context, and a fire is never
 * held back for it — the run starts without it, and still binds as it would have.
 */
async function continuedConversation(
  deps: WiredDeps,
  event: InboundAutomationEvent,
): Promise<{ thread: ChatThread; botId: string } | null> {
  const policy = event.response;
  const chat = deps.chatAccess;
  if (
    !chat || policy === null || policy.chatroomId === null || policy.channelId === null ||
    policy.conversation !== "shared"
  ) return null;
  // No response of this fire exists yet, so there is none to leave out.
  const previous = await deps.store.listSharedResponses(event.automationId, "", MAX_CONTINUED_FROM);
  if (previous.length === 0) return null;
  const read = await chat.fetchContinuedThread({
    chatroomId: policy.chatroomId,
    previousRunIds: previous.map((r) => r.runId),
    channelId: policy.channelId,
  });
  if (read.kind === "unavailable") {
    deps.diag.warn("automation_event.conversation_unread", {
      eventId: event.eventId,
      automationId: event.automationId,
      chatroomId: policy.chatroomId,
    });
    return null;
  }
  if (read.kind !== "thread") return null;
  // A response opens in a private channel only, and the save checked it (packages/automations,
  // `response.channelId`) — once. A channel made public since is anyone's to post in, and its
  // history anyone's to have written: read live here, and anything but "private" (Zulip's public
  // and web-public, Slack's public or shared outside the workspace, a Discord channel `@everyone`
  // may view) is history this run is not
  // given. The run still starts, and still binds as it would have.
  if (read.thread.channel.visibility !== "private") {
    deps.diag.warn("automation_event.conversation_not_private", {
      eventId: event.eventId,
      automationId: event.automationId,
      chatroomId: policy.chatroomId,
      visibility: read.thread.channel.visibility,
    });
    return null;
  }
  return { thread: read.thread, botId: read.botId };
}

/** The automation's instructions, behind the conversation its shared response continues when
 * there is one (core/thread_context.ts renders it, and keeps the instructions last). */
function withContinuedConversation(
  continued: { thread: ChatThread; botId: string } | null,
  instructions: string,
): string {
  return continued === null ? instructions : composeContinuedResponse(continued, instructions);
}

/**
 * A fire joining an open response: the counter always grows, and up to MAX_RESPONSE_ALERTS of
 * them become inbox messages — past that a storm of fires would only stuff the prompt, and the
 * room's own feed carries them regardless. The run is the caller's, already checked live: a
 * terminal one never reaches here, it closes its stale response instead. The message kind stays
 * "alert": it is internal, stored, and older than responses.
 */
async function joinResponse(
  deps: WiredDeps,
  response: RunResponse,
  run: Run,
  event: InboundAutomationEvent,
  signal: FireSignal,
): Promise<{ alerts: number; embedded: boolean }> {
  const at = deps.now().toISOString();
  const alerts = response.alerts + 1;
  let embedded = false;
  if (alerts <= MAX_RESPONSE_ALERTS) {
    const posted = await postMessage(deps, run, {
      kind: "alert",
      sender: { kind: "automation", fireId: event.eventId },
      text: frameFire(event.payload, alerts, signal),
    });
    embedded = posted.kind === "posted";
    if (posted.kind === "refused") {
      deps.diag.warn("automation_event.join_refused", {
        responseId: response.id,
        error: posted.error,
      });
    }
  }
  // A narrow write of the counter and the two clocks, conditioned on the row still being open.
  // Reading the row back and writing it whole cannot serve: between the read and the write a
  // person may close the response, and the copy would resurrect it to `open` with no `closedAt`.
  await deps.store.recordResponseAlert(response.id, alerts, at);
  return { alerts, embedded };
}

/**
 * How old a confirmed "allowed" may be and still start a fire the forge cannot answer for. An
 * incident is exactly when GitHub may be down, and the alert that reports it must still get a
 * responder; the keep-warm check (`refreshAutomationAccess`) asks about every enabled
 * automation's owner hourly, so in practice the verdict relied on is at most that old. A
 * "denied" is never overridden: only a question the forge could not answer falls back.
 */
export const OUTAGE_ACCESS_GRACE_MS = 24 * 60 * 60_000;

type Checkout =
  | { kind: "ok"; repos: StartTaskRepo[]; workspace?: Workspace }
  | { kind: "missing"; outcome: "no-such-repo" | "no-such-workspace" }
  | { kind: "refused"; detail: string };

/** The repos an automation's target names, as they stand now. */
async function resolveCheckout(deps: WiredDeps, target: AutomationTarget): Promise<Checkout> {
  if (target.kind === "repo") {
    const repo = await deps.store.getConnectedRepo(target.connectedRepoId);
    if (repo === null || repo.archivedAt !== null) {
      return { kind: "missing", outcome: "no-such-repo" };
    }
    return { kind: "ok", repos: singleRepoStart(repo, target.ref ?? repo.defaultBranch) };
  }
  const checkout = await resolveWorkspace(deps.store, target.workspaceId);
  if (checkout.kind === "refused") {
    return checkout.status === 404
      ? { kind: "missing", outcome: "no-such-workspace" }
      : { kind: "refused", detail: checkout.error };
  }
  return {
    kind: "ok",
    repos: workspaceStartRepos(checkout.members),
    workspace: checkout.workspace,
  };
}

type OwnerAccess =
  /** `confirmedAt` is null for a live answer, else when the cached one it rests on was given. */
  | { kind: "allowed"; confirmedAt: string | null }
  | { kind: "denied" }
  | { kind: "no-linked-identity" }
  | { kind: "unknown" };

/**
 * The owner's write access to EVERY repo of the checkout, asked live — a revoked repo stops an
 * automation the moment it is revoked, and a partial checkout is never started.
 *
 * One identity per forge, so each repo is asked about with the login its own forge names — auth
 * holds them, and a login linked on GitHub is not access on Radicle. A missing link refuses
 * outright here, which is STRICTER than the user-facing door on purpose: `user_api`'s
 * `refuseRepoPermission` runs a Radicle `write` check with no DID at all, because a public
 * repo's answer does not turn on who is asking. An automation fires unattended, for an owner
 * who is not at the keyboard, on a payload somebody else sent — so a real identity to hang the
 * fire on is worth demanding even where the repo itself would not ask for one. A local
 * repository asks no forge: it has no identities to link, and `write` on it is subjectless.
 *
 * Every real verdict is written to `repo_access`, the same row a scoped read keeps. A repo the
 * forge could not answer for falls back to that row when it says writable and is younger than
 * `OUTAGE_ACCESS_GRACE_MS`; with no such row the answer is "unknown" and the caller retries.
 */
async function checkOwnerAccess(
  deps: WiredDeps,
  ownerUserId: string,
  repos: readonly StartTaskRepo[],
): Promise<OwnerAccess> {
  const forge = deps.forge;
  if (!forge) return { kind: "unknown" };
  const asked: ConnectedRepo[] = [];
  const logins = new Map<ForgeProvider, string | null>();
  for (const { connectedRepo } of repos) {
    if (connectedRepo.provider === "local") continue;
    if (!logins.has(connectedRepo.provider)) {
      logins.set(
        connectedRepo.provider,
        deps.identityDirectory
          ? await deps.identityDirectory.subjectFor(ownerUserId, connectedRepo.provider)
          : null,
      );
    }
    if (logins.get(connectedRepo.provider) === null) return { kind: "no-linked-identity" };
    asked.push(connectedRepo);
  }
  if (asked.length === 0) return { kind: "allowed", confirmedAt: null };

  // Asked side by side, a few at a time: when the forge hangs, each question runs to its own
  // deadline, and a workspace asked one repo at a time would wait those out end to end.
  const verdicts = await mapWithConcurrency(
    asked,
    FORGE_CHECK_CONCURRENCY,
    (repo) =>
      forge.checkPermission(
        forgeRepoRef(repo),
        { provider: repo.provider, subject: logins.get(repo.provider)! },
        "write",
      ),
  );
  const now = deps.now();
  await deps.store.saveRepoAccess(
    asked.flatMap((repo, i) =>
      verdicts[i] === "unknown" ? [] : [{
        id: mintId("ra"),
        userId: ownerUserId,
        connectedRepoId: repo.id,
        writable: verdicts[i] === "allowed",
        checkedAt: now.toISOString(),
      }]
    ),
  );
  if (verdicts.includes("denied")) return { kind: "denied" };
  if (!verdicts.includes("unknown")) return { kind: "allowed", confirmedAt: null };

  const cached = new Map(
    (await deps.store.listRepoAccess(ownerUserId)).map((row) => [row.connectedRepoId, row]),
  );
  let confirmedAt: string | null = null;
  for (const [i, repo] of asked.entries()) {
    if (verdicts[i] !== "unknown") continue;
    const row = cached.get(repo.id);
    if (
      row === undefined || !row.writable ||
      now.getTime() - Date.parse(row.checkedAt) >= OUTAGE_ACCESS_GRACE_MS
    ) {
      return { kind: "unknown" };
    }
    if (confirmedAt === null || row.checkedAt < confirmedAt) confirmedAt = row.checkedAt;
  }
  return { kind: "allowed", confirmedAt };
}

/**
 * The keep-warm half of the outage fallback: the automations service asks this for every
 * enabled automation on a slow timer, so the owner's access is on record from the last hour
 * when GitHub goes down — an alert automation may go weeks without firing, and nothing else
 * would have asked. It starts nothing and records only what the forge actually answered.
 */
export async function refreshAutomationAccess(
  deps: WiredDeps,
  probe: { ownerUserId: string; target: AutomationTarget },
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!deps.forge) {
    return { status: 503, body: { error: "the forge is not configured on this orchestrator" } };
  }
  const checkout = await resolveCheckout(deps, probe.target);
  if (checkout.kind !== "ok") return { status: 200, body: { access: "unresolvable" } };
  const access = await checkOwnerAccess(deps, probe.ownerUserId, checkout.repos);
  // A fallback answer is not news: only a live one says anything about the owner now.
  const live = access.kind === "allowed" && access.confirmedAt !== null ? "unknown" : access.kind;
  return { status: 200, body: { access: live } };
}

export function automationsRoutes(deps: WiredDeps, automationsToken: string): Route[] {
  /** The service gate: the bearer must be the shared token. */
  const authenticated = makeServiceGate(automationsToken);

  return [
    route("POST", "/v1/automations/events", async (req) => {
      const denied = await authenticated(req);
      if (denied) return denied;
      const body = await parseBody(req, AutomationEventSchema, {
        maxBytes: MAX_AUTOMATION_EVENT_BODY_BYTES,
      });
      if (!body.ok) return body.res;
      const verdict = await handleAutomationEvent(deps, body.data);
      return json(verdict.status, verdict.body);
    }),
    route("POST", "/v1/automations/access", async (req) => {
      const denied = await authenticated(req);
      if (denied) return denied;
      const body = await parseBody(req, AutomationAccessProbeSchema);
      if (!body.ok) return body.res;
      const verdict = await refreshAutomationAccess(deps, body.data);
      return json(verdict.status, verdict.body);
    }),
  ];
}
