// Where the Telegram, Slack and Discord adapters dial, as a composition root reads it from its
// env. Each platform has one public API origin, hard-coded in the adapter; these overrides exist
// for a stand-in of that API — the playground's mock platforms, a local Bot API server — and are
// unset everywhere else. Zulip needs none: its realm URL is part of every room's credential.
//
//   RYPH_CHAT_TELEGRAM_API_URL  the Bot API origin   (default https://api.telegram.org)
//   RYPH_CHAT_SLACK_API_URL     the Web API base     (default https://slack.com/api)
//   RYPH_CHAT_DISCORD_API_URL   the REST API base    (default https://discord.com/api/v10)
//
// Discord's Gateway is not overridden here: its address is what `GET /gateway/bot` answers, so a
// stand-in of the REST API names its own socket.
//
// A bot token rides every call to these addresses (Telegram's in the URL path), so an override
// is the operator's own decision, never a room's: it is read once at startup, never per request.

import type { ChatroomKind } from "../../core/types.ts";
import type { ChatTransport } from "../../ports/transport.ts";
import { discordTransport } from "./discord.ts";
import { slackTransport } from "./slack.ts";
import { telegramTransport } from "./telegram.ts";
import { zulipTransport } from "./zulip.ts";

/** The overridden API addresses; null keeps the platform's own. */
export interface PlatformApiUrls {
  telegram: string | null;
  slack: string | null;
  discord: string | null;
}

export const PLATFORM_API_URL_VARS = {
  telegram: "RYPH_CHAT_TELEGRAM_API_URL",
  slack: "RYPH_CHAT_SLACK_API_URL",
  discord: "RYPH_CHAT_DISCORD_API_URL",
} as const;

/**
 * The overrides from the environment. Throws, naming the variable, on a value that is not an
 * absolute http(s) URL — a typo must stop the process, not send a bot token somewhere odd.
 */
export function platformApiUrlsFromEnv(
  env: (name: string) => string | undefined,
): PlatformApiUrls {
  const read = (name: string): string | null => {
    const raw = env(name)?.trim();
    if (!raw) return null;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${name} must be an absolute http(s) URL, got ${JSON.stringify(raw)}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${name} must be an http(s) URL, got ${JSON.stringify(raw)}`);
    }
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      throw new Error(`${name} must be a plain base URL, without credentials, query or fragment`);
    }
    return url.href.replace(/\/+$/, "");
  };
  return {
    telegram: read(PLATFORM_API_URL_VARS.telegram),
    slack: read(PLATFORM_API_URL_VARS.slack),
    discord: read(PLATFORM_API_URL_VARS.discord),
  };
}

/** One transport per platform, dialing the overridden addresses where there are any. */
export function platformTransports(
  urls: PlatformApiUrls = { telegram: null, slack: null, discord: null },
): Record<ChatroomKind, ChatTransport> {
  return {
    telegram: telegramTransport(urls.telegram === null ? {} : { apiUrl: urls.telegram }),
    zulip: zulipTransport(),
    slack: slackTransport(urls.slack === null ? {} : { apiUrl: urls.slack }),
    discord: discordTransport(urls.discord === null ? {} : { apiUrl: urls.discord }),
  };
}
