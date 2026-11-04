// The Telegram, Slack and Discord API overrides: read from the env, refused unless a plain
// http(s) URL,
// and dialed by the transports when set.

import { afterEach, test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import { platformApiUrlsFromEnv, platformTransports } from "../src/adapters/transport/api_urls.ts";

const envOf = (vars: Record<string, string>) => (name: string) => vars[name];

test("unset: all null, so the transports keep the platforms' own addresses", () => {
  assertEquals(platformApiUrlsFromEnv(envOf({})), { telegram: null, slack: null, discord: null });
  assertEquals(
    platformApiUrlsFromEnv(envOf({ RYPH_CHAT_TELEGRAM_API_URL: "  " })),
    { telegram: null, slack: null, discord: null },
  );
});

test("set: read as given, trailing slashes dropped", () => {
  assertEquals(
    platformApiUrlsFromEnv(envOf({
      RYPH_CHAT_TELEGRAM_API_URL: "http://127.0.0.1:7490/telegram/",
      RYPH_CHAT_SLACK_API_URL: "https://slack.example/api",
      RYPH_CHAT_DISCORD_API_URL: "http://127.0.0.1:7490/discord/api/v10/",
    })),
    {
      telegram: "http://127.0.0.1:7490/telegram",
      slack: "https://slack.example/api",
      discord: "http://127.0.0.1:7490/discord/api/v10",
    },
  );
});

test("refused: not a URL, another scheme, credentials or a query — naming the variable", () => {
  for (
    const [name, value] of [
      ["RYPH_CHAT_TELEGRAM_API_URL", "api.telegram.org"],
      ["RYPH_CHAT_SLACK_API_URL", "ftp://slack.example/api"],
      ["RYPH_CHAT_SLACK_API_URL", "https://user:pw@slack.example/api"],
      ["RYPH_CHAT_TELEGRAM_API_URL", "https://tg.example/?x=1"],
      ["RYPH_CHAT_DISCORD_API_URL", "wss://gateway.discord.gg"],
    ]
  ) {
    assertThrows(() => platformApiUrlsFromEnv(envOf({ [name]: value })), Error, name);
  }
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the transports dial the overridden addresses", async () => {
  const dialed: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    dialed.push(url);
    const body = url.includes("/telegram/")
      ? { ok: true, result: { id: 1, is_bot: true, first_name: "Bot", username: "ops_bot" } }
      : url.endsWith("/auth.test")
      ? { ok: true, user_id: "U1", user: "ryph", team: "Acme", bot_id: "B1" }
      : url.endsWith("/users/@me")
      ? { id: "100000000000000001", username: "ryph", bot: true }
      : url.endsWith("/applications/@me")
      ? { flags: 1 << 19 }
      : url.includes("/guilds/")
      ? { id: "100000000000000002", name: "Acme" }
      : { ok: true, url: "ws://127.0.0.1:1/socket" };
    return Promise.resolve(Response.json(body));
  }) as typeof fetch;
  const transports = platformTransports({
    telegram: "http://127.0.0.1:7490/telegram",
    slack: "http://127.0.0.1:7490/slack/api",
    discord: "http://127.0.0.1:7490/discord/api/v10",
  });
  await transports.telegram.whoAmI({ kind: "telegram", botToken: "1:abc" });
  await transports.slack.whoAmI({ kind: "slack", botToken: "xoxb-1", appToken: "xapp-1" });
  await transports.discord.whoAmI({
    kind: "discord",
    botToken: "d.1.x",
    guildId: "100000000000000002",
  });
  assertEquals(dialed, [
    "http://127.0.0.1:7490/telegram/bot1:abc/getMe",
    "http://127.0.0.1:7490/slack/api/auth.test",
    "http://127.0.0.1:7490/slack/api/apps.connections.open",
    "http://127.0.0.1:7490/discord/api/v10/users/@me",
    "http://127.0.0.1:7490/discord/api/v10/applications/@me",
    "http://127.0.0.1:7490/discord/api/v10/guilds/100000000000000002",
  ]);
});
