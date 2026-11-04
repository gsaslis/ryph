// The chat surface: the mention door, spoken only by the chat service and authenticated by the
// shared RYPH_CHAT_TOKEN — the same credential this process presents on the way back, when it
// asks the chat service a question or binds a conversation to a run (ports/chat_access.ts). Its
// own file, not a route inside user_api, because it is a distinct trust surface: a service
// token, not a user.
//
// EVERY mention of the bot in every room arrives here, and this door decides what it means —
// the chat service speaks the platform and decides nothing about work. The ladder is the forge
// door's (`handleForgeEvent` in forge_api.ts), rung for rung where the two can share one:
//
//   a room with NO command policy is a response room: a mention can only talk to the run its
//   response bound there — "the room is the allowlist", as it always was — and says so when
//   nothing is running;
//
//   a COMMAND ROOM resolves the channel's target (else: not served), checks the sender against
//   the room's commanders on EVERY mention (a no is silent, an unknown is loud), picks the agent
//   by the mention's first word, and then either JOINS the run already working this thread —
//   the same agent, a message into its inbox — refuses a different agent out loud, or STARTS
//   one: the thread read before the claim, the claim before any side effect, the room's rate
//   limit, the visibility rule, the owner's live repo access, startTask, the binding.
//
// Invariants:
// - read-only rungs run before the claim, every side effect after it: one winner per
//   (chatroomId, messageId), so a re-delivered mention acts nothing twice
// - a commander is a chat identity, never a ryph user: runs act for the room's OWNER, whose repo
//   access is re-checked live on every start, as an automation's owner's is on every fire
// - a public channel may only command work on public repos — whatever the agent posts there is
//   published — and the refusal names the rule, never the private repo
// - every business verdict is a 200 with a verdict; only a door that could not decide (its own
//   store down) answers 5xx, which the chat service retries
//
// `deliverChatMention` is exported so the single-process host hands mentions over without a
// loopback hop, exactly as the automations door is.
//
// Images: a mention carries the images its message did, fetched by the chat service (which has
// the platform credential and the egress) and sent in the mention's own body, base64 — a start
// has no run to upload to until this door has decided. They enter exactly as every other image
// does: a start hands them to `startTask` (`images`, checked whole before anything is queued),
// a join stores each through `storeAttachments` and the message claims them. The chat service
// already dropped what these checks would refuse, with a note in the text, so a refusal here is
// the run's (it holds too many uploads no message carried yet) or the deployment's (no
// attachment store), said out loud rather than lost — and never read as the run having ended,
// which is the only refusal a join may answer by starting a fresh run.

import { imageMarker, storeAttachments, takeBackAttachments } from "../core/attachments.ts";
import { isAgentHandle } from "../core/commands.ts";
import { forgeRepoRef } from "../core/forge_repo.ts";
import { isTerminal } from "../core/lifecycle.ts";
import { postMessage, type PostOutcome, textRefusal } from "../core/inbox.ts";
import { runUrlOf } from "../core/conclude_run.ts";
import { startTask, type StartTaskRepo } from "../core/start_task.ts";
import { startTaskDeps } from "./start_deps.ts";
import { chatConversationKey, chatDisplayName, composeChatTask } from "../core/thread_context.ts";
import { resolveWorkspace, singleRepoStart, workspaceStartRepos } from "../core/workspaces.ts";
import type {
  Agent,
  AutomationTarget,
  ChatMentionOutcome,
  ChatMentionVerdict,
  CommandRoom,
  ForgeProvider,
  InboundChatMention,
  Run,
  Workspace,
} from "../core/types.ts";
import { makeServiceGate } from "@ryph/sealed";
import { ChatMentionSchema } from "../schema.ts";
import type { WiredDeps } from "./app.ts";
import { describeIssues, json, readCappedBytes, type Route, route } from "@ryph/shared/http";
import { serviceImageRoutes } from "./service_images.ts";
import { runOwnerMayAct } from "./run_owner.ts";

/** As the forge door's reclaim window: how long a claim may sit at "processing" before a
 * re-delivered mention adopts it — a crashed handler's escape hatch. */
const PROCESSING_RECLAIM_MS = 5 * 60_000;

/** The window a room's `startsPerHour` counts over. */
const RATE_WINDOW_MS = 60 * 60_000;

/** What a room with nothing running answers — the response room's reply, as before. */
export const NO_BINDING_REPLY = "No response is running right now.";

/** The rule, said without naming what tripped it: the channel is public, the repo may not be. */
export const VISIBILITY_REFUSAL =
  "This channel is public, and a public channel may only command work on public repositories " +
  "— everything I post here is published. Ask an admin to point this channel at a public target.";

/** What a mention answers when the room's owner can no longer act in ryph. */
export const OWNER_INACTIVE_REPLY =
  "This room's owner can no longer start work on this channel's repositories — ask an admin.";

/** What a mention answers when the room's owner is active but their role can't start tasks. */
export const OWNER_ROLE_REPLY = "This room's owner's ryph role can't start tasks — ask an admin.";

/** What a follow-up answers when the user the run works for can no longer act in ryph. */
export const RUN_OWNER_INACTIVE_REPLY =
  "The run working here can't take messages any more — ask an admin.";

const USAGE_REPLY = "Mention me with what to look into — for example: `@ryph investigate this`.";

/**
 * What a join answers when the run is there but its images could not be kept — it holds too
 * many uploads no message carried yet, or the deployment keeps no images. Nothing is posted:
 * the chat service placed each image's marker in the text, so the words without their images
 * would point at pictures the run never got, and the commander is right there to send them
 * again. (A forge follow-up differs because it renders the comment itself and can say in the
 * text where each image was; it tells the thread out loud too.)
 */
const IMAGES_REFUSED_REPLY = "I couldn't keep the images you sent for the run working here. " +
  "Try again without them, or later.";

/** What a join answers when the message is longer than an inbox message may be. */
const TOO_LONG_REPLY = "That's too long to hand to the run working here. Say it shorter, or " +
  "link a log rather than pasting it.";

/** What a join answers for the inbox's other refusals: an image another message claimed in the
 * same instant. Rare enough that "try again" is the whole answer. */
const POST_REFUSED_REPLY = "I couldn't hand that to the run working here. Try again.";

/**
 * The most a mention's body may be. A mention carries its images base64-encoded, and the chat
 * service holds all of one mention's together to 25 MiB (33.3 MiB encoded); this is that and
 * room for the rest, read under a cap that bites while it streams — the route is behind the
 * service token, but a cap is what keeps one request from being any size at all.
 */
export const MAX_MENTION_BODY_BYTES = 40 * 1024 * 1024;

/**
 * The text without the markers of the `imageCount` images the mention handed over — none of them
 * is an ask on its own. Only those: the chat service rewrites whatever the sender typed in a
 * marker's shape before it places its own (`(image 2)`, packages/chat core/images.ts), so a
 * literal one is words and counts as an ask, and an `[image n]` past the images handed over is
 * nobody's marker either.
 */
export function withoutMarkers(text: string, imageCount: number): string {
  let out = text;
  for (let n = 1; n <= imageCount; n++) out = out.replaceAll(imageMarker(n), "");
  return out.trim();
}

/**
 * A mention into a live run's inbox: each image stored through the door every image takes
 * (`storeAttachment`, the chat source), then the message that claims them — text, images, or
 * both. What comes back is the inbox's own outcome, or `images_refused` when the run is alive
 * but would not keep an image (its unclaimed cap, no attachment store).
 *
 * Only a refusal with `reason: "terminal"` says the run has ended, and only that one may send a
 * command-room join on to a fresh start: the cap shares its 409, and a run at its cap is very
 * much alive. Whatever the outcome short of `posted`, the images this call stored are taken back
 * at once — no message will claim them, and the sweep is a day away. The text's own refusal is
 * asked before any image is stored, so a mention that was never going to be taken stores nothing.
 */
async function postMention(
  deps: WiredDeps,
  run: Run,
  mention: InboundChatMention,
): Promise<PostOutcome | { kind: "images_refused"; error: string }> {
  const tooLong = textRefusal(mention.text);
  if (tooLong !== null) return tooLong;
  const stored = await storeAttachments(
    deps,
    run,
    mention.images.map((image) => image.bytes),
    "chat",
  );
  if (stored.kind === "refused") {
    if (stored.reason === "terminal") {
      return { kind: "refused", status: 409, error: stored.error, reason: "terminal" };
    }
    return { kind: "images_refused", error: stored.error };
  }
  const posted = await postMessage(deps, run, {
    kind: "chat",
    sender: { kind: "chat", name: mention.sender.name, id: mention.sender.id },
    text: mention.text,
    attachmentIds: stored.ids,
  });
  if (posted.kind === "refused") await takeBackAttachments(deps, run.id, stored.ids);
  return posted;
}

/**
 * Which message of the quoted thread is the mention itself, so its images are described as
 * handed over: the same id on Zulip; on Slack the thread names a message `<channel>:<ts>` and a
 * mention `<channel>:<ts>:<thread root>`; on Discord both are `<channel>:<thread>:<message>`.
 * Null when the thread does not hold it (Telegram).
 */
function mentionInThread(
  thread: { messages: Array<{ id: string }> },
  messageId: string,
): string | null {
  return thread.messages.find((m) => m.id === messageId || messageId.startsWith(`${m.id}:`))
    ?.id ?? null;
}

/**
 * One mention, decided. Throws only when the door itself could not decide (its store down) —
 * the chat service retries that; every decision about the mention is a verdict.
 */
export async function deliverChatMention(
  deps: WiredDeps,
  mention: InboundChatMention,
): Promise<ChatMentionVerdict> {
  const { store, diag } = deps;
  const nowIso = () => deps.now().toISOString();
  const reclaimBefore = new Date(deps.now().getTime() - PROCESSING_RECLAIM_MS).toISOString();

  const record = (outcome: ChatMentionOutcome, taskId: string | null = null) => ({
    chatroomId: mention.chatroomId,
    messageId: mention.messageId,
    outcome,
    taskId,
    receivedAt: mention.receivedAt,
    createdAt: nowIso(),
    claimedAt: null,
  });
  /** The side-effect gate: one winner per (chatroomId, messageId), with the crash escape. */
  const claim = async (): Promise<boolean> =>
    await store.claimChatMention({ ...record("processing"), claimedAt: nowIso() }, reclaimBefore);
  /** A claimed mention's verdict, recorded as its final word. */
  const concluded = async (verdict: ChatMentionVerdict): Promise<ChatMentionVerdict> => {
    await store.recordChatMention(
      record(verdict.outcome as ChatMentionOutcome, verdict.taskId ?? null),
    );
    diag.debug("chat_mention.decided", {
      chatroomId: mention.chatroomId,
      messageId: mention.messageId,
      outcome: verdict.outcome,
    });
    return verdict;
  };
  const deduped: ChatMentionVerdict = { outcome: "deduped", reply: null, react: false };

  const room = await store.getCommandRoom(mention.chatroomId);
  if (room === null) return await responseRoom(deps, mention, claim, concluded, deduped);

  // ---- a command room: the read-only rungs --------------------------------------------------

  // Which work this channel commands: its own row, else the room's default, else none — a room
  // with no default is an allowlist of channels.
  const target = room.channels.find((c) => c.channelId === mention.channel.id)?.target ??
    room.defaultTarget;
  if (target === null) {
    return {
      outcome: "not-served",
      reply: "This channel isn't set up for ryph — ask an admin to add it.",
      react: false,
    };
  }

  // A command room is policy over a chat service; one without the service to ask is a wiring
  // fault, not a verdict — and so is one whose targets need a forge this orchestrator lacks.
  if (!deps.chatAccess) throw new Error("a command room, but no chat access is wired");
  if (!deps.forge) throw new Error("a command room, but no forge is wired");
  const chat = deps.chatAccess;
  const forge = deps.forge;

  // The commanders, on EVERY mention: on an open server anyone can make an account, and a
  // follow-up steers an agent holding a checkout as surely as a start spends the budget. A "no"
  // is SILENT, as the forge's is — a drive-by learns nothing; an unanswerable check is refused
  // out loud and never read as a yes.
  if (room.commanders.kind === "group") {
    const verdict = await chat.checkCommander({
      chatroomId: mention.chatroomId,
      userId: mention.sender.id,
      groupId: room.commanders.groupId,
    });
    if (verdict === "unknown") {
      return {
        outcome: "unverifiable",
        reply: "I couldn't check whether you may command me here — try again in a minute.",
        react: false,
      };
    }
    if (verdict === "denied") return { outcome: "denied", reply: null, react: false };
  } else if (mention.channel.visibility !== "private") {
    // "Everyone in the room" is the response-room rule, and it means something only where the
    // room is closed. Checked HERE, at the mention, because only the mention knows the channel:
    // the policy is saved without asking the platform what its channels are.
    return {
      outcome: "refused",
      reply: "This room lets anyone in a channel command me, which I only honour in private " +
        "channels — ask an admin to set a commander group for this one.",
      react: false,
    };
  }

  // The agent: the mention's first word, when it is the handle of one of the room's agents —
  // then the rest is the ask — else the room's default and the whole text. An unknown first word
  // is part of the instructions, not an error: a mention is a sentence, not a command line.
  const picked = await pickAgent(deps, room, mention.text);

  // The owner's standing in ryph, asked LIVE on every mention, a follow-up's as much as a
  // start's: the owner still exists and is active. The room acts for them, and an owner who can
  // no longer sign in can no longer start work through it, nor steer a run already going. The
  // forge login lookup a start makes was this gate by accident for a forge repo (a deleted user
  // has no linked identity), but a follow-up never reaches it, a local repo skips it and a
  // deactivated user keeps their links. No directory to ask is no answer, and a stranger-driven
  // room does not guess.
  const ownerActive = deps.identityDirectory
    ? await deps.identityDirectory.isActiveUser(room.ownerUserId)
    : false;
  if (!ownerActive) {
    diag.warn("chat_mention.owner_inactive", {
      chatroomId: mention.chatroomId,
      ownerUserId: room.ownerUserId,
    });
    return { outcome: "refused", reply: OWNER_INACTIVE_REPLY, react: false };
  }
  // ...and whose role, as stored now, still lets them start tasks: rooms are made by a member,
  // and the owner's later demotion would otherwise leave the room starting work as them.
  if (!(await deps.identityDirectory?.mayStartTasks(room.ownerUserId) ?? false)) {
    diag.warn("chat_mention.owner_role_refused", {
      chatroomId: mention.chatroomId,
      ownerUserId: room.ownerUserId,
    });
    return { outcome: "refused", reply: OWNER_ROLE_REPLY, react: false };
  }

  // One thread, one run. The live run started from this thread — or, for a room that also hosts
  // an automation's response, the response's run bound here — is the one a mention reaches.
  const held = await heldRun(deps, mention);
  let claimed = false;
  if (held !== null) {
    // ...and only while the user that run acts for is still active too: a response's run acts
    // for its automation's owner, who need not be this room's.
    if (!await runOwnerMayAct(deps, held)) {
      diag.warn("chat_mention.run_owner_inactive", { runId: held.id });
      return { outcome: "refused", reply: RUN_OWNER_INACTIVE_REPLY, react: false };
    }
    if (picked.named !== null && picked.named.id !== held.agentId) {
      const holder = await store.getAgent(held.agentId);
      return {
        outcome: "refused",
        reply: `${holder?.name ?? "Another agent"} is already working here — wait ` +
          "until it finishes before asking someone else.",
        react: false,
      };
    }
    if (mention.text === "" && mention.images.length === 0) {
      return { outcome: "refused", reply: "Mention me with what you'd like to add.", react: false };
    }
    if (!await claim()) return deduped;
    claimed = true;
    const posted = await postMention(deps, held, mention);
    if (posted.kind === "images_refused") {
      diag.warn("chat_mention.images_refused", { runId: held.id, why: posted.error });
      return await concluded({
        outcome: "refused",
        reply: IMAGES_REFUSED_REPLY,
        react: false,
        taskId: held.taskId,
      });
    }
    if (posted.kind === "posted") {
      return await concluded({
        outcome: "joined",
        reply: null,
        react: true,
        runId: held.id,
        taskId: held.taskId,
      });
    }
    if (posted.reason !== "terminal") {
      // The run is alive and still working this thread — starting a second beside it is the
      // race the block above refuses. Say why instead: the message too long, or (rarely) an
      // image another message claimed in the same instant.
      return await concluded({
        outcome: "refused",
        reply: posted.status === 400 ? TOO_LONG_REPLY : POST_REFUSED_REPLY,
        react: false,
        taskId: held.taskId,
      });
    }
    // The run went terminal between the lookup and the post. Fall through and start a fresh
    // one: that is what the commander asked for, and an ended run cannot answer it.
    diag.debug("chat_mention.join_refused", { runId: held.id, why: posted.error });
  }

  // ---- a start ---------------------------------------------------------------------------

  const settle = async (verdict: ChatMentionVerdict) =>
    claimed ? await concluded(verdict) : verdict;
  const agent = picked.named ?? picked.fallback;
  if (agent === null) {
    return await settle({
      outcome: "refused",
      reply: "The agent this room answers with is no longer available — ask an admin.",
      react: false,
    });
  }
  // Images alone are no ask: a start needs words, whatever came with them.
  if (withoutMarkers(picked.instructions, mention.images.length) === "") {
    return await settle({ outcome: "refused", reply: USAGE_REPLY, react: false });
  }

  // The thread, read BEFORE the claim and on purpose, as the forge door does: a read-only rung
  // re-runs for free on a re-delivery. It is what makes "investigate this" answerable.
  const fetched = await chat.fetchThread({
    chatroomId: mention.chatroomId,
    threadKey: mention.threadKey,
  });
  if (fetched.kind === "unavailable") {
    return await settle({
      outcome: "unverifiable",
      reply: "I couldn't read this conversation just now — mention me again in a minute.",
      react: false,
    });
  }
  if (fetched.kind === "gone") {
    return await settle({
      outcome: "refused",
      reply: "I can't read this conversation any more, so there is nothing for me to work from.",
      react: false,
    });
  }

  // Every rung below has a side effect, or decides one.
  if (!claimed) {
    if (!await claim()) return deduped;
    claimed = true;
  }

  // The room's budget: runs started from it in the last hour, whatever became of them.
  const since = new Date(deps.now().getTime() - RATE_WINDOW_MS).toISOString();
  const started = await store.countRunsStartedFromChatroom(mention.chatroomId, since);
  if (started >= room.startsPerHour) {
    return await concluded({
      outcome: "rate-limited",
      // The limit, not the count: an admin who lowered it leaves a count above it.
      reply: `This room may start ${room.startsPerHour} run${
        room.startsPerHour === 1 ? "" : "s"
      } an hour, and it has — try again later.`,
      react: false,
    });
  }

  // What the channel checks out, resolved NOW: an edited workspace starts as it stands, and a
  // target gone since the policy was saved refuses. Never named: the channel may be public.
  const checkout = await resolveTarget(deps, target);
  if (checkout === null) {
    return await concluded({
      outcome: "refused",
      reply: "This channel's target is no longer available — ask an admin to fix the room.",
      react: false,
    });
  }
  const connected = checkout.repos.map((r) => r.connectedRepo);

  // The visibility rule, at START — a run cannot be un-told what it read. Every repo of the
  // target, read live from its forge; a doubt is a refusal, never a guess.
  if (mention.channel.visibility !== "private") {
    for (const repo of connected) {
      const visibility = await forge.repoVisibility(forgeRepoRef(repo));
      if (visibility === "unknown") {
        return await concluded({
          outcome: "unverifiable",
          reply: "I couldn't check whether this channel's repositories are public — try again " +
            "in a minute.",
          react: false,
        });
      }
      if (visibility === "private") {
        diag.warn("chat_mention.private_target_in_public_channel", {
          chatroomId: mention.chatroomId,
          channelId: mention.channel.id,
        });
        return await concluded({ outcome: "refused", reply: VISIBILITY_REFUSAL, react: false });
      }
    }
  }

  // The owner's access, checked LIVE on every repo of the checkout — exactly the automations
  // door's rule: a revoked repo stops the room the moment it is revoked, and a partial checkout
  // is never started. One identity per forge, the one that repo's own forge names.
  // A missing link is a flat "denied" here, STRICTER than the user-facing door on purpose:
  // `user_api`'s `refuseRepoPermission` runs a Radicle `write` check with no DID at all,
  // since a public repo's answer does not turn on who is asking. A room acts for an absent
  // owner, and this is the one path where a stranger's text in a channel drives the run, so
  // an owner who is somebody on that forge is worth demanding even where the repo itself
  // would not ask — the same owner may still launch the task by hand.
  // A local repository asks no forge: it has no identities to link and nothing to question,
  // and `write` on it is subjectless (`refuseRepoPermission`), so the owner's standing in ryph
  // — what let them bind the room — is the whole answer. Demanding a link could only refuse.
  // That standing — the owner still exists and is active — was asked LIVE before the room
  // handed anything to a run, above.
  const logins = new Map<ForgeProvider, string | null>();
  for (const repo of connected) {
    if (repo.provider === "local") continue;
    if (!logins.has(repo.provider)) {
      logins.set(
        repo.provider,
        deps.identityDirectory
          ? await deps.identityDirectory.subjectFor(room.ownerUserId, repo.provider)
          : null,
      );
    }
    const login = logins.get(repo.provider) ?? null;
    const access = login === null ? "denied" : await forge.checkPermission(
      forgeRepoRef(repo),
      { provider: repo.provider, subject: login },
      "write",
    );
    if (access === "unknown") {
      return await concluded({
        outcome: "unverifiable",
        reply: "I couldn't check this room's access to its repositories — try again in a minute.",
        react: false,
      });
    }
    if (access === "denied") {
      diag.warn("chat_mention.owner_denied", {
        chatroomId: mention.chatroomId,
        ownerUserId: room.ownerUserId,
        repo: repo.repoRef,
        linked: login !== null,
      });
      return await concluded({
        outcome: "refused",
        reply: "This room's owner can no longer start work on this channel's repositories — " +
          "ask an admin.",
        react: false,
      });
    }
  }

  if (deps.config.gitGateway === null) {
    return await concluded({
      outcome: "refused",
      reply: "This ryph deployment has no git gateway, so runs cannot start from chat.",
      react: false,
    });
  }

  const composed = composeChatTask(fetched.thread, {
    instructions: picked.instructions,
    sender: mention.sender,
    channelName: mention.channel.name,
    topic: mention.topic,
    checkout: checkout.repos.map((r) => ({ name: r.name, path: r.path, ref: r.ref })),
    workspaceName: checkout.workspace?.name ?? null,
    imageCount: mention.images.length,
    mentionMessageId: mentionInThread(fetched.thread, mention.messageId),
  });
  const conversation = chatConversationKey(mention);
  const outcome = await startTask(
    startTaskDeps(deps),
    {
      agent,
      spec: composed,
      images: mention.images.map((image) => ({ bytes: image.bytes, source: "chat" as const })),
      repos: checkout.repos,
      ...(checkout.workspace === undefined ? {} : { workspace: checkout.workspace }),
      origin: "chat",
      requestedByUserId: room.ownerUserId,
      requestedVia: { name: chatDisplayName(mention.sender.name) },
      ...(conversation === null ? {} : { chatConversation: conversation }),
      // The room is the chat tool's room: the agent answers where it was asked.
      chatroomId: mention.chatroomId,
      originConversation: {
        kind: "chat",
        chatroomId: mention.chatroomId,
        threadKey: mention.threadKey,
      },
    },
  );
  if (outcome.kind === "refused") {
    // In a private channel the text may name what the room's members may see; in a public one
    // every repo of the target was just proven public.
    return await concluded({
      outcome: "refused",
      reply: `ryph couldn't start this: ${outcome.error}`,
      react: false,
    });
  }

  // The binding: the chat service posts the opening line into THIS thread at once. Best-effort —
  // a thread that could not be bound is a run without a room, never a failed one.
  await chat.openBinding({
    runId: outcome.runId,
    chatroomId: mention.chatroomId,
    conversation: { kind: "thread", threadKey: mention.threadKey },
    agentName: agent.name,
    taskTitle: composed.title,
    runUrl: runUrlOf(deps.config.appUrl, outcome.taskId),
  }).catch((err) =>
    diag.warn("chat_mention.binding_failed", {
      chatroomId: mention.chatroomId,
      runId: outcome.runId,
      err: String(err),
    })
  );
  return await concluded({
    outcome: "started",
    reply: null,
    react: true,
    runId: outcome.runId,
    taskId: outcome.taskId,
  });
}

/**
 * A room with no command policy: the response room, as it always was. A mention can only talk to
 * the run the room is bound to, and only when the run's own RESPONSE names this room — a run id
 * the chat service hands over proves nothing by itself, so without this check anything holding
 * the shared token could put words into any live run.
 */
async function responseRoom(
  deps: WiredDeps,
  mention: InboundChatMention,
  claim: () => Promise<boolean>,
  concluded: (v: ChatMentionVerdict) => Promise<ChatMentionVerdict>,
  deduped: ChatMentionVerdict,
): Promise<ChatMentionVerdict> {
  const noBinding: ChatMentionVerdict = {
    outcome: "no-binding",
    reply: NO_BINDING_REPLY,
    react: false,
  };
  if (mention.boundRunId === null) return noBinding;
  const run = await deps.store.getRun(mention.boundRunId);
  // A binding outliving its run is the conclusion's close still in flight: nothing is running.
  if (run === null || isTerminal(run)) return noBinding;
  const response = await deps.store.findResponseByRun(run.id);
  if (response === null || response.chatroomId !== mention.chatroomId) {
    deps.diag.warn("chat_mention.wrong_room", {
      runId: run.id,
      chatroomId: mention.chatroomId,
      names: response?.chatroomId ?? null,
    });
    return { outcome: "refused", reply: NO_BINDING_REPLY, react: false };
  }
  // "The room is the allowlist" means something only where the room is closed: a Telegram group
  // is, and its mentions always arrive "private"; a Zulip public channel is the whole
  // organization and a web-public one is the internet, a Slack public channel is the whole
  // workspace, and a Discord channel `@everyone` may view is the whole server. A response opens in
  // a private channel only (the automations service refuses any other at save), so this is reached
  // when the conversation went public afterwards — a Zulip topic MOVED into a public channel, a
  // Slack private channel CONVERTED to public — and a conversation that opened up is not steered
  // from where it landed. A command room's bound-run joins are gated on its commanders instead
  // (`heldRun`, behind the commanders check).
  if (mention.channel.visibility !== "private") {
    return {
      outcome: "refused",
      reply: "This response is in a public channel now, and I only take steering in a private " +
        "one — put it back, or ask an admin for a command room with a commander group.",
      react: false,
    };
  }
  if (mention.text === "" && mention.images.length === 0) {
    return { outcome: "refused", reply: "Mention me with what you'd like to say.", react: false };
  }
  // The response's run acts for its automation's owner: one deactivated, deleted or demoted
  // since can no longer steer it, from here or anywhere (`runOwnerMayAct`).
  if (!await runOwnerMayAct(deps, run)) {
    deps.diag.warn("chat_mention.run_owner_inactive", { runId: run.id });
    return { outcome: "refused", reply: RUN_OWNER_INACTIVE_REPLY, react: false };
  }
  if (!await claim()) return deduped;
  const posted = await postMention(deps, run, mention);
  if (posted.kind === "images_refused") {
    deps.diag.warn("chat_mention.images_refused", { runId: run.id, why: posted.error });
    return await concluded({
      outcome: "refused",
      reply: IMAGES_REFUSED_REPLY,
      react: false,
      taskId: run.taskId,
    });
  }
  if (posted.kind === "posted") {
    return await concluded({
      outcome: "joined",
      reply: null,
      react: true,
      runId: run.id,
      taskId: run.taskId,
    });
  }
  if (posted.reason === "terminal") return await concluded(noBinding);
  return await concluded({
    outcome: "refused",
    reply: posted.status === 400 ? TOO_LONG_REPLY : POST_REFUSED_REPLY,
    react: false,
  });
}

/**
 * The agent a mention addresses. `named` is set when the first word is the handle of one of the
 * room's LIVE agents — and then `instructions` is the rest; `fallback` is the room's default when
 * it is still live. An archived agent's handle is just a word.
 */
async function pickAgent(
  deps: WiredDeps,
  room: CommandRoom,
  text: string,
): Promise<{ named: Agent | null; fallback: Agent | null; instructions: string }> {
  const agents = (await Promise.all(room.agentIds.map((id) => deps.store.getAgent(id))))
    .filter((a): a is Agent => a !== null && a.archivedAt === null);
  const fallback = agents.find((a) => a.id === room.defaultAgentId) ?? null;
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match !== null) {
    const word = match[1].toLowerCase();
    const named = isAgentHandle(word) ? agents.find((a) => a.handle === word) ?? null : null;
    if (named !== null) return { named, fallback, instructions: (match[2] ?? "").trim() };
  }
  return { named: null, fallback, instructions: text.trim() };
}

/**
 * The live run this mention's thread holds: the run started from it — found by the thread key,
 * whatever the chat service matched — else the run the chat service bound here when that run is
 * a response naming this room (an automation's response run in a room that also takes commands).
 * A `boundRunId` that is neither is not trusted: the key is the authority.
 */
async function heldRun(deps: WiredDeps, mention: InboundChatMention): Promise<Run | null> {
  const started = await deps.store.findLiveRunByOrigin({
    kind: "chat",
    chatroomId: mention.chatroomId,
    threadKey: mention.threadKey,
  });
  if (started !== null || mention.boundRunId === null) return started;
  const bound = await deps.store.getRun(mention.boundRunId);
  if (bound === null || isTerminal(bound)) return null;
  const response = await deps.store.findResponseByRun(bound.id);
  if (response?.chatroomId === mention.chatroomId) return bound;
  deps.diag.warn("chat_mention.binding_mismatch", {
    chatroomId: mention.chatroomId,
    threadKey: mention.threadKey,
    boundRunId: bound.id,
  });
  return null;
}

/** A target as a checkout, resolved now; null when it no longer resolves. */
async function resolveTarget(
  deps: WiredDeps,
  target: AutomationTarget,
): Promise<
  | { repos: StartTaskRepo[]; workspace?: Workspace }
  | null
> {
  if (target.kind === "repo") {
    const repo = await deps.store.getConnectedRepo(target.connectedRepoId);
    if (repo === null || repo.archivedAt !== null) return null;
    return { repos: singleRepoStart(repo, target.ref ?? repo.defaultBranch) };
  }
  const checkout = await resolveWorkspace(deps.store, target.workspaceId);
  if (checkout.kind === "refused") {
    deps.diag.warn("chat_mention.target_unusable", {
      workspaceId: target.workspaceId,
      error: checkout.error,
    });
    return null;
  }
  return { repos: workspaceStartRepos(checkout.members), workspace: checkout.workspace };
}

export function chatRoutes(deps: WiredDeps, chatToken: string): Route[] {
  /** The service gate: the bearer must be the shared token. */
  const authenticated = makeServiceGate(chatToken);

  return [
    route("POST", "/v1/chat/mentions", async (req) => {
      const denied = await authenticated(req);
      if (denied) return denied;
      // Read under a cap while it streams — a mention carries its images — then parsed.
      const read = await readCappedBytes(req, MAX_MENTION_BODY_BYTES);
      if (!read.ok) {
        return json(413, { error: `a mention is at most ${MAX_MENTION_BODY_BYTES} bytes` });
      }
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder().decode(read.bytes));
      } catch {
        return json(400, { error: "body is not valid JSON" });
      }
      const parsed = ChatMentionSchema.safeParse(raw);
      if (!parsed.success) return json(400, { error: describeIssues(parsed.error) });
      const mention = parsed.data;
      try {
        return json(200, await deliverChatMention(deps, mention));
      } catch (err) {
        // The door could not decide — its own store or wiring failed. Retryable, and said so.
        // A claim it left at "processing" answers a retry inside the reclaim window "deduped",
        // as a forge delivery's does; a re-delivery past it adopts the claim.
        deps.diag.warn("chat_mention.undecided", {
          chatroomId: mention.chatroomId,
          messageId: mention.messageId,
          err: String(err),
        });
        return json(503, { error: "the mention could not be decided — retry" });
      }
    }),
    ...serviceImageRoutes(deps, "chat", authenticated),
  ];
}
