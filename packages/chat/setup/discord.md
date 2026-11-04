# Setting up a Discord bot for ryph

A Discord room is one bot in one server, and one bot serves one room: make a separate application
for each server you add. The bot hears a mention over the Gateway, a WebSocket the chat service
holds open, so nothing is published and no interaction endpoint is set. Slack's manifest has no
Discord equivalent, so this page is the setup, in the order the developer portal asks for it.

## 1. The application and its bot

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New
   Application**. Its name is the name people mention, e.g. `ryph`.
2. **Bot** → **Reset Token**, and copy the token. It is shown once. It is the room's one secret: it
   reads every channel the bot can see and posts as the bot.
3. On the same page, under **Privileged Gateway Intents**, turn on **Message Content Intent**. It is
   what lets the bot read a reply to it that does not ping it, and the messages of a thread it is
   handed as evidence. Without it the room is refused at creation (the service checks the
   application's flags), and a bot whose intent is switched off later is closed by Discord with
   4014, which the poller reports with this fix. Presence and Server Members stay off.
4. Turn **Public Bot** off. A public bot can be added to any server by anyone, and every server it
   is in streams its messages to the chat service. A room whose bot is public is refused.

## 2. Inviting it to the server

**OAuth2** → **URL Generator**: the `bot` scope, and these permissions — or open this URL with your
application id in place of `APP_ID`:

```
https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot&permissions=309237746752
```

| Permission               | Bit       | Why                                                                             |
| ------------------------ | --------- | ------------------------------------------------------------------------------- |
| View Channels            | `1 << 10` | the bot hears and reads only the channels it can see                            |
| Send Messages            | `1 << 11` | the opening line of a response, at the top of its channel                       |
| Send Messages in Threads | `1 << 38` | every other post: a conversation is a thread                                    |
| Create Public Threads    | `1 << 35` | the thread a response opens, and the one a mention at the top of a channel gets |
| Read Message History     | `1 << 16` | the thread a run is handed as evidence, and the mention a thread is named after |
| Add Reactions            | `1 << 6`  | 👀 on a mention the door took                                                   |
| Attach Files             | `1 << 15` | a run's images; without it they go as links to ryph                             |

`309237746752` is their sum. Give all of them in every channel the bot works in: Discord checks them
per channel, and a missing one only shows when the bot needs it. Without Read Message History a run
is told a thread's past is hidden from it, and a thread started from a mention is named `ryph`.
Embed Links is not needed: every post the bot makes suppresses link previews, and the run and patch
links read as links without it. Nothing it posts can ping anyone, whatever its permissions: each
message carries `allowed_mentions: { parse: [] }`.

The bot hears a mention only from a channel it can see. A **private** channel (one whose `@everyone`
is denied View Channel — Discord's Private Channel switch) needs the bot, or a role it holds, added
to it. ryph reads a channel as private exactly when `@everyone` cannot view it, which is what a
response's channel must be; a server whose `@everyone` sees nothing and whose roles grant everything
reads every channel as public, which only ever narrows what can be started there.

"Private" is only what `@everyone` is denied. If a role every member gets — from onboarding, a
verification bot, or a self-assign menu — is allowed back into the channel, everyone can see it, and
ryph still reads it as private. Use a channel as a response room or a command room only when the
people who can see it are people you trust with what runs there.

## 3. The server id

User Settings → **Advanced** → **Developer Mode** on; then right-click the server's icon → **Copy
Server ID**. A 17 to 20 digit number.

## 4. The room

Paste the token and the server id: in the app, or

```
POST /v1/chatrooms
{ "kind": "discord", "name": "Acme", "botToken": "MTA…", "guildId": "123456789012345678" }
```

The service checks that the token is a bot's, that its Message Content intent is on and that the bot
is in that server, that **Public Bot** is off, and that the bot serves no other room, and names the
room after the server. One bot serves one room: a Gateway connection carries every server the bot is
in, and Discord's daily connection budget belongs to the token. For a second server, create a second
application and bot.

## Groups and commanders

A command room's commanders are a server **role**: `GET /v1/chatrooms/:id/groups` lists the server's
roles, all but `@everyone` and the roles an integration manages, and a mention is checked against
the sender's roles at the moment of asking. Never name a role people can give themselves (a reaction
role, an onboarding choice, a self-assign command): anyone holding it can start runs.

## When the room stops listening

The chat service logs `chat.poll_failed` with the reason, and the reason ends with how to recover.

- **Message Content intent switched off** (Discord's close code 4014): turn **Message Content
  Intent** back on under **Bot → Privileged Gateway Intents**. ryph checks the bot's settings every
  five minutes and the room listens again on its own once the intent is on — nothing to re-add.
- **Token refused** (4004): reset the token under **Bot**, then archive the room and add it again
  with the new token. The room cannot be added again while the old one is live: one bot serves one
  room.
- **Anything else Discord closes for good** (4010–4013, or 4011 for a bot in too many servers): fix
  what the message names, then archive the room and add it again, or restart ryph.

A bot that has spent nearly all of its daily Gateway connections (Discord resets a token that spends
them all) waits for Discord's daily reset; the log says how long.

## Replacing a leaked token

Reset it under **Bot**, archive the room, and add it again with the new token: a room's credential
is never edited in place.
