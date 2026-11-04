// The STANDALONE composition root — the chat service as its own process, for the networked
// deployment where each service is its own socket. The default local deployment is @ryph/host,
// which instead spreads this package's routes into its own handler and holds the service
// in-process. This file knows which adapter stands behind each gate, reads the environment, owns
// the listening socket, and ticks the poller.
//
// Three credentials, three surfaces:
// - the management routes verify the same @ryph/auth tokens the orchestrator does, against
//   the same RYPH_AUTH_URL JWKS — the app forwards one user bearer to whichever service owns
//   the path.
// - the internal surface (`/internal/v1/…`) takes RYPH_CHAT_TOKEN, the shared service
//   credential the orchestrator presents to bind runs, check commanders and read threads; the
//   same token is what this process presents back on the orchestrator's mention door, one link,
//   one token.
// - the MCP data route takes RYPH_CHAT_GATEWAY_TOKEN, which only the gateway holds, plus the
//   run id in a header only the gateway sets.
//
// The master key (RYPH_CHAT_KEY) seals platform secrets and lives HERE and only here — the fourth
// secret class, beside the model-proxy's, the control plane's and the gateway's.

import { Logger, setupLoggerFromEnv } from "@ryph/logger";
import { verifierFromUrl } from "@ryph/auth";
import { installDrain, makeHealth, refusePublicDevSecrets, serve } from "@ryph/service";
import { makeRouter } from "@ryph/shared/http";
import { importMasterKey, type MasterKey } from "@ryph/sealed";
import { httpMentionSink } from "./adapters/mention_sink/http.ts";
import { httpRunImages } from "./adapters/run_images/http.ts";
import { makeChatDb } from "./adapters/store/db/db.ts";
import { drizzleChatStore } from "./adapters/store/drizzle.ts";
import {
  type PlatformApiUrls,
  platformApiUrlsFromEnv,
  platformTransports,
} from "./adapters/transport/api_urls.ts";
import { makeAuthenticate } from "@ryph/auth/gates";
import type { ChatStore } from "./ports/store.ts";
import { pollLockKey, setup } from "./setup.ts";

const env = (name: string): string | undefined => process.env[name] || undefined;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

const intEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/** Like `intEnv`, but zero is a meaningful answer — "no pause", "no deadline". */
const msEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

export async function main(): Promise<void> {
  refusePublicDevSecrets("chat");
  const port = intEnv("RYPH_CHAT_PORT", 7450);
  setupLoggerFromEnv();
  const log = new Logger("chat");
  const diag = {
    debug: (event: string, fields?: Record<string, unknown>) => log.debug(event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => log.warn(event, fields),
  };

  const masterKeyHex = env("RYPH_CHAT_KEY") ??
    fail("RYPH_CHAT_KEY is required — the service cannot unseal a bot's credential without it");
  let masterKey: MasterKey;
  try {
    masterKey = await importMasterKey(masterKeyHex);
  } catch (err) {
    fail(`RYPH_CHAT_KEY: ${err instanceof Error ? err.message : String(err)}`);
  }

  // RYPH_CHAT_DB is a ryph database URL (see @ryph/db). A standalone chat service owns its own
  // database — `ryph_chat` in the networked deployment — never the control plane's. Schema is
  // applied with drizzle-kit, never here: the probe below fails fast if it was not.
  const dbUrl = env("RYPH_CHAT_DB") ?? "pglite:./data/ryph-chat";
  const dbHandle = await makeChatDb(dbUrl);
  const store: ChatStore = drizzleChatStore(dbHandle);
  try {
    await store.listChatrooms();
  } catch (err) {
    // The handle's description is password-redacted; the raw URL never reaches a log.
    fail(
      `chat database ${dbHandle.description} did not answer the startup probe ` +
        `(${err instanceof Error ? err.message : String(err)}) — if it has no schema, run ` +
        "`bun run db:push` in packages/chat. On Kubernetes the pod's `migrate` init " +
        "container applies it before this starts: read its log (`kubectl logs <pod> -c migrate`). " +
        "If the database did not answer at all, check RYPH_CHAT_DB and the NetworkPolicy to the database",
    );
  }

  const authDisabled = env("RYPH_AUTH") === "off";
  if (authDisabled) log.warn("RYPH_AUTH=off — the chatroom management surface is OPEN");
  const authUrl = env("RYPH_AUTH_URL");
  if (authUrl && !URL.canParse("/.well-known/jwks.json", authUrl)) {
    fail(`RYPH_AUTH_URL must be a valid absolute URL, got ${JSON.stringify(authUrl)}`);
  }
  const verifier = authUrl
    ? verifierFromUrl(new URL("/.well-known/jwks.json", authUrl).href)
    : { verify: () => Promise.resolve(null) };
  if (!authUrl && !authDisabled) {
    log.warn("RYPH_AUTH_URL unset — no user token verifies, so nobody can manage chatrooms");
  }
  const authenticate = makeAuthenticate({
    verifier,
    disabled: authDisabled,
  });

  // One link, one token: the orchestrator binds runs and asks its questions here with it, and
  // this process delivers every mention to the orchestrator's door with the same one.
  const serviceToken = env("RYPH_CHAT_TOKEN") ?? null;
  const orchestratorUrl = env("RYPH_ORCHESTRATOR_URL")?.replace(/\/+$/, "") ?? null;
  if (serviceToken === null) {
    log.warn(
      "RYPH_CHAT_TOKEN unset — the internal surface is dark, so no orchestrator can bind a run " +
        "to a conversation, and a mention in a room reaches no door",
    );
  }
  if (orchestratorUrl === null) {
    log.warn("RYPH_ORCHESTRATOR_URL unset — a mention in a room reaches no door");
  }
  const gatewayToken = env("RYPH_CHAT_GATEWAY_TOKEN") ?? null;
  if (gatewayToken === null) {
    log.warn("RYPH_CHAT_GATEWAY_TOKEN unset — the MCP data route refuses every call");
  }

  // The poll of one room is serialised across replicas by a Postgres advisory lock, taken once
  // and held for as long as this replica answers for the room: a Slack connection outlives a
  // pass, and two pollers holding one for the same app would split Slack's events between them.
  // The lock is the session's, so a replica that dies releases every one of its rooms, and the
  // next pass on another replica resumes from the persisted cursor.
  // A stand-in for Telegram's, Slack's or Discord's API (RYPH_CHAT_TELEGRAM_API_URL /
  // RYPH_CHAT_SLACK_API_URL / RYPH_CHAT_DISCORD_API_URL); unset everywhere but a dev stand-in.
  let apiUrls: PlatformApiUrls;
  try {
    apiUrls = platformApiUrlsFromEnv(env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const lock = await dbHandle.lockSession();
  const chat = setup({
    store,
    transports: platformTransports(apiUrls),
    sink: serviceToken !== null && orchestratorUrl !== null
      ? httpMentionSink({ orchestratorUrl, chatToken: serviceToken })
      : {
        deliver: () => Promise.resolve({ kind: "failed", error: "no orchestrator is configured" }),
      },
    // A run's images are the control plane's, over the same link and token as the door.
    images: serviceToken !== null && orchestratorUrl !== null
      ? httpRunImages({ orchestratorUrl, chatToken: serviceToken })
      : undefined,
    masterKey,
    authenticate,
    gatewayToken,
    serviceToken,
    lock: {
      take: async (chatroomId) => {
        const key = pollLockKey(chatroomId);
        if (!await lock.tryLock(key)) return null;
        return () => lock.unlock(key);
      },
      held: (chatroomId) => lock.held(pollLockKey(chatroomId)),
    },
    now: () => new Date(),
    diag,
  });

  // Readiness is one bounded read of the table this service exists to serve. Liveness asks
  // nothing: a database outage must route traffic away, never restart the fleet into a crash loop.
  const health = makeHealth({ ready: () => store.listChatrooms(), log: diag });

  const router = makeRouter([...health.routes, ...chat.routes, ...chat.internalRoutes]);
  const server = await serve({ port }, async (req) => {
    const data = await chat.dataHandler(req);
    return data ?? await router(req);
  });
  log.info(`listening on :${port}`, {
    db: dbHandle.description,
    auth: authUrl ?? (authDisabled ? "off" : "break-glass-only"),
    internal: serviceToken === null ? "dark" : "on",
    data: gatewayToken === null ? "dark" : "on",
    orchestrator: orchestratorUrl ?? "unset",
  });

  // The poller: every live room's long poll, on a short tick — a room's hold spans many ticks,
  // and `pollAll` skips a room whose hold is still open, so the tick only ever starts a hold
  // that ended. The drain aborts every hold at once.
  const polling = new AbortController();
  let passInFlight = false;
  const poller = setInterval(() => {
    if (passInFlight) return;
    passInFlight = true;
    chat.pollAll(polling.signal)
      .catch((err) => diag.warn("chat.poll_pass_failed", { err: String(err) }))
      .finally(() => (passInFlight = false));
  }, intEnv("RYPH_CHAT_POLL_INTERVAL_MS", 2_000));

  installDrain({
    servers: [server],
    beginDrain: health.beginDrain,
    close: async () => {
      clearInterval(poller);
      polling.abort();
      await lock.close();
      await store.close();
    },
    preStopMs: msEnv("RYPH_PRE_STOP_MS", 0),
    deadlineMs: msEnv("RYPH_DRAIN_DEADLINE_MS", 25_000),
    log,
  });
}

if (import.meta.main) {
  await main();
}
