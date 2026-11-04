# 💬 @ryph/chat

Chat platforms, linked to runs. A bot sits in a Telegram group, a Zulip organization, a Slack
workspace or a Discord server; every mention of it goes to the control plane's **mention door**,
which decides whether it starts a run, joins a live one, or is answered with a refusal. A run is
bound to the **conversation** it came from — a Telegram group, a Zulip topic, a Slack or Discord
thread — and the agent posts back into it through a platform tool.

**This service decides nothing about work.** It speaks the platform, holds the bot's credential and
normalizes what arrives; the control plane owns the policy (command rooms, commanders, targets) and
runs the ladder. What a room hears back is the door's `reply`, with two exceptions the door cannot
say: _Add me to this channel to use me here._ (a mention from a private Zulip channel the bot is not
in never reaches the door) and _ryph couldn't take this right now_ (the door could not be asked).

## What it owns

| Table               | What                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatrooms`         | a bot on a platform: its name and id, its secret (a Telegram token, a Zulip API key, a Slack or Discord bot token) **sealed** under `RYPH_CHAT_KEY`, plus Slack's second sealed secret, its app-level token; Telegram's group once learned, Discord's server from creation (the token's seal is bound to it), Zulip's realm URL and bot email |
| `chat_bindings`     | a run linked to one conversation for its lifetime — at most one active per `(room, thread_key)`; the key is Telegram `""`, the Zulip message the run was bound from, or Slack's `<channel>:<thread root>` and Discord's `<channel>:<thread>` (a mention's thread, or the platform's own opening line when a response opens one) |
| `chat_poll_cursors` | where the poller is in each room's stream — Telegram's update offset; Zulip's queue, last event id and last message id; Discord's Gateway session and sequence, which a resume replays from; nothing for Slack, which has no position to resume from |

The service keeps no transcript of its own: every post is a gateway tool call in the run's trail,
and every mention is a row at the control plane.

## Conversations

A binding's **thread key** names its conversation. Telegram has one per group, keyed `""`, so a
response room keeps its one-run-at-a-time rule.

A **Slack** conversation is a thread, keyed `<channel>:<thread root>`. A thread never leaves the
channel it was made in and its root timestamp names it forever, so a key locates itself with no
call at all; an inbound message carries a third part, `<channel>:<ts>:<thread root>`, because a
reply's own timestamp does not name the thread it sits in and Slack offers no way to ask afterwards.
A mention at the top of a channel roots the thread the run will answer in; a mention inside one
belongs to that thread. A response, which no mention started, gets its thread from the opening line
the platform posts at the channel: that post is the root, and the run keys on it.

A **Discord** conversation is a thread too, keyed `<channel>:<thread>` with the PARENT channel
first. A thread started from a message takes that message's id, so a mention at the top of a text
channel keys the thread it would start, and the first post that needs it starts it, named after the
mention's words; a mention inside a thread keys that thread. A thread never leaves its parent, so a
key locates itself as Slack's does. An inbound message is `<channel>:<thread>:<message>`, because
neither a thread's id nor a message in it names the parent; the message sits in the parent when it
is the thread's starter (its id is the thread's) and in the thread otherwise. A response's thread
is started from the opening line at once, and named as the response asked: a Discord thread, unlike
Slack's, has a name, and a mention in one carries it as the `topic` (for display: the key is the
identity). A Discord Reply at the top of the channel to one of the bot's own posts there (a
response's opening line) keys that post's thread, so it reaches the run bound there.

A **Zulip** conversation is keyed by the id of the mention that started the run; a topic's name is
not an identity: topics are renamed, resolved
(`✔ …`), split and moved between channels, and the bot hears about none of it unless it happened
through the one message it holds. So nothing tracks moves; every read and post **locates** the key
message (fetched by id, `GET /messages/{id}` — never through a narrow, which would miss the bot's
own post in a public channel it is not subscribed to) and goes where it is now, and a follow-up
mention matches the binding whose key sits in the same channel and topic at the moment of asking.
A response that opens a topic is refused when the located key of another active binding already
sits in that channel and topic, so one conversation never steers two runs.

## Three surfaces, three credentials

- **Management** (`/v1/chatrooms`): create with a name and a credential — `{ kind: "telegram",
  botToken }`, `{ kind: "zulip", realmUrl, botEmail, apiKey }`, `{ kind: "slack", botToken,
  appToken }` or `{ kind: "discord", botToken, guildId }` (the server's id, a snowflake STRING),
  which crosses once, inward, and never comes back (`getMe` / `GET /users/me` / `auth.test` /
  `GET /users/@me` vouches for it; a Zulip credential must be a bot's and a Slack one an app's,
  Slack's app-level token is spent once on `apps.connections.open`, and a Discord bot must be in
  the server with its Message Content intent on and Public Bot off — `GET /applications/@me` — and
  serve no other live room, so a room that could never hear anything, or would hear strangers, is
  refused here rather than at the first mention; Discord's refusals say what to fix), and optionally
  `quiet`. List, edit (`PATCH { name?, quiet? }`), archive;
  `GET /v1/chatrooms/:id/channels` and `/groups` list what a command-room policy may name (Zulip
  channels with their visibility and non-system user groups; the Slack channels the bot is in, and
  its usergroups; the Discord server's text and announcement channels, and its roles but
  `@everyone` and integrations'; Telegram's one group and no groups). Reading takes `chat:read` and
  creating takes `chat:write` — a Telegram, Slack or Discord room reaches its platform at one fixed
  address. A Zulip room
  takes `chat:manage` on top, because the server then dials the realm URL it names (over `https:`,
  or plain `http:` only at `localhost`, `*.localhost` or `127.0.0.1.nip.io`). Editing, archiving
  and reading a room's channels and groups are the creator's, or a holder of `chat:manage`'s — the
  lists name private channels the bot is in, and the workspace's groups. User bearers, verified
  against `RYPH_AUTH_URL`.
- **Internal** (`/internal/v1/…`): the orchestrator's `ChatAccess` port, with `RYPH_CHAT_TOKEN`.
  `POST bindings` (runId, chatroomId, agentName, taskTitle, runUrl, `conversation`) binds a
  conversation and says the opening line in it, which ends by telling the room how to reach the
  run (Telegram: mention `@<bot>` or reply to it; Zulip: mention it in the topic; Slack and
  Discord: mention it in the thread). `conversation` takes two forms: `{ kind: "thread", threadKey }`
  names an existing one — Telegram `""`, Zulip a message id (a mention's), Slack
  `<channel>:<thread root>`, Discord `<channel>:<thread>`.
  It binds it, then announces best-effort (`409` with `reason: "conversation_held"` when it
  already has a run — the one 409 that carries a `reason` — or when a room made of
  channels is asked for the room-wide key `""`, which it has none of; `400` for a keyed thread on
  Telegram); `{ kind: "new", channelId, topic }` (`400` on Telegram, whose room is the only
  conversation it has) OPENS one for a response: the platform posts the opening line — with the
  task's title, since nothing before it says what the conversation is about — where that platform
  opens one, a Zulip topic of the name given or, on Slack and Discord, the channel itself, and the
  run is keyed by that post, so every read and post downstream follows it like a mention's. A Slack
  thread has no name, so the topic asked for is not an address there; on Discord it names the
  thread started from the post (a thread that will not start takes the post back down). The post
  comes first; one the platform refuses is a `502` naming the call, and binds nothing. A line past
  the platform's ceiling goes on inside the conversation its first part opened; one refused
  part-way is the same `502`, and on Slack and Discord its first part is taken back down
  (best-effort — a Discord thread started from it stays, since removing one takes Manage Threads).
  `{ kind: "continue", previousRunIds, channelId, topic }` is a response sharing its automation's
  ONE conversation: it binds to the key message the newest of `previousRunIds` (newest first)
  bound in this room had, when that binding is closed and its key message is still located in
  `channelId` — otherwise it opens `new` with `channelId` and `topic` (`409` while the previous
  run is still bound there; `502` when the platform cannot say where the key message is).
  A **quiet** room (`quiet: true`) drops the platform's bookkeeping lines: no "is on it" line in a
  conversation that already exists (only a response's alert, when it carries one), and no closing
  line for a run that `succeeded`. A conversation the platform opens still gets its opening line —
  it is the key message — and every other outcome still gets its closing line. A run closes as
  quiet as the room was when it bound: its prompt was told then.
  `POST runs/:id/close` posts the
  closing line — the
  outcome, the patches, the issues the run opened (`#12` for a number, a Radicle id as given), the
  run link — or, with `silent: true`, only releases a stale binding of a run long over. `POST commanders/check` answers
  `{ verdict: "allowed" | "denied" | "unknown" }` from the platform's group membership, asked
  live: Zulip's user groups, Slack's usergroups, Discord's roles (always `unknown` for Telegram);
  `POST threads/fetch` answers the conversation as evidence —
  `{ kind: "thread", thread } | { kind: "gone" } | { kind: "unavailable" }`, the text as its author
  typed it, platform notices dropped, the oldest messages dropped past 200 messages or 60 000
  characters (`truncated`), and `historyLimited` when a protected private channel hides what came
  before the bot joined (Telegram: an empty thread, `historyLimited: true`; Slack: never, since a
  member of a channel sees its whole history; Discord: only for a bot without Read Message
  History, which Discord answers with empty pages — its thread is its starter message and the
  thread's own, read backwards from the newest). Neither question fails as HTTP.
  `POST threads/continued` (chatroomId, previousRunIds, channelId) is the same read for a shared
  response about to `continue`: the conversation that binding would follow, by the same rule —
  `{ kind: "thread", thread, botId } | { kind: "none" } | { kind: "unavailable" }`, `botId` naming
  the room's bot so ryph's own earlier posts can be labelled. `none` is a room that is one
  conversation, no previous binding in this room, or a key message gone or moved out of
  `channelId`. Read before the bind, so the bind may still be refused (a previous run still
  bound) or fall back to `new`; the orchestrator renders it into the run's task only.
  `GET chatrooms/:id/context` answers `{ kind, roomTitle, botHandle }`: the Telegram group's title
  (the room's own name until it links), the Zulip organization's name, the Slack workspace's or the
  Discord server's, and
  what people type to reach the bot — which the orchestrator freezes onto a bound run's work item
  for the agent; `404` for a room that is missing or archived.
- **Data** (`/v1/chat-mcp`): the MCP route the gateway's platform server `chat` forwards to, with
  `RYPH_CHAT_GATEWAY_TOKEN` and the run's id in `x-ryph-run-id`. One tool, `post`, which the agent
  sees as `chat__post`: signed `[<agent>]` once at the top (and on any line that opens like a
  speaker, so the text cannot forge one), posted into the binding's conversation
  wherever it lives now (refused, with a reason the agent reads, when the key message is gone),
  split at the server's `max_message_length` for Zulip, 4096 for Telegram, 4000 for Slack and 2000
  for Discord (whose alert excerpt is cut to 1 000 characters to fit an opening line). The agent
  writes Markdown; Slack renders its own mrkdwn and Discord its own Markdown, so a run bound to
  either is told so in its prompt rather than having its words rewritten here. A post may carry images a tool
  returned in the run (below, **A run's images**).

## The mention door

Every mention, in every room, is `POST`ed to the orchestrator's `/v1/chat/mentions` as a
`ChatMention` — the room, the message id, the conversation's `threadKey` and the `boundRunId` it
matched (or null, with the key a new run would get), the channel with its live visibility, the
topic, the sender, the text with the bot's own mention removed, and the **images** the message
carried (below). The `ChatMentionVerdict` says
what to post (`reply`) and whether to acknowledge (`react` — 👀 on Zulip, Slack and Discord,
nothing on Telegram).
"No response is running right now" (`no-binding`) is said at most once a minute per room. A `4xx` is
logged and dropped; a `5xx` or an unreachable door is retried three times with backoff (1, 2, 4 s),
then apologised for, and the poller moves on. The door dedupes on `(room, message id)`, so a mention
redelivered after a crash is answered `deduped`.

## Images

A mention's images reach the run. The service fetches them (it has the bot's credential and the
egress; a run has neither) only for a mention it is about to hand the door, never for the rest of
what a platform delivers, and sends them in the mention's own body, base64 — a mention that starts a
run has no run to upload to until the door has decided. Each one is checked here by the control
plane's rules: read under a 5 MiB cap as it streams (a size the platform announced over it is never
fetched), its format **sniffed from its bytes** (PNG, JPEG, GIF, WebP; what the platform claimed
only picks which files are worth fetching), at most ten per mention and 25 MiB together, all
fetches of one mention within a minute. The text says where each went: `[image n]` where the nth
image sat, or a short note where one could not be taken (too large, not one of the four formats,
not downloadable) — a bad image costs only itself, never the mention. Every `[image n]` in the text
is one of those: what the sender typed in that shape is handed over as `(image n)` first, so it can
neither stand in for an image nor read as one. And the text always fits the door's 16 KiB: past it,
the sender's words are cut from the end, with a note saying so, never a marker or a note. The door
checks them again and stores them under the run; the runner hands them to the agent.

- **Telegram**: a photo's words are its `caption` (with `caption_entities`), read exactly as a
  message's text, so a mention in a caption is a mention. The photo's largest size under the cap is
  fetched (`getFile`, then the file under the token's path), and so is a file Telegram says is an
  image. A **reply to a photo** hands that photo over too, after the message's own and marked as
  coming from the replied-to message: a bot cannot read a group's history, and replying is how
  someone points at one. An album is one message per photo with the caption on one, so only that
  photo is the mention's. Stickers, videos and other files stay what they were.
- **Zulip**: an upload linked in the message as an image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`)
  is fetched through the temporary URL the API hands out
  (`GET /api/v1/user_uploads/{realm_id}/{path}`, then that URL, on the realm only, without the key)
  and its link replaced by the marker. Other uploads stay links. The link must have Zulip's own
  shape, `/user_uploads/<realm id>/[<bucket>/]<24-character token>/<name>`, judged segment by
  segment **after decoding** and asked for re-encoded: a `%2e%2e`, an encoded slash or a second
  layer of encoding is no upload (the URL parser reads `%2e%2e` as `..`, and the request carries
  the bot's key).

  **Residual risk: the bot fetches an upload with its own access, not the sender's.** Zulip lets
  the bot read an upload linked in any message it can read, so a sender who already holds the link
  to an upload in a private channel the bot is in and they are not (or a guest holding a link
  from a public channel) can have ryph fetch it into a run in the channel they mention it from.
  Checked against Zulip's source (`main`, 2026-10-04) for a way to tie the fetch to the sender, and
  there is none the bot can ask: Zulip links an upload to a message only if its sender may read
  it (`do_claim_attachments`), but that link is not exposed to anyone but the uploader
  (`GET /attachments` lists the caller's own uploads); the inline preview in rendered content is
  drawn for any upload of the realm by path (`manifest_and_get_user_upload_previews`), so it
  proves nothing; and `has:attachment` is one flag for the whole message. What bounds it: the
  sender must already hold the link, whose 144-bit random token is the secret, and only the bot's
  wider reach turns that link into the bytes. A bot kept out of private channels it does not need
  has nothing of this kind to give away.
- **Slack**: a message's files that Slack says are images are fetched from `url_private_download`
  with the bot token, which is sent only to `files.slack.com` — **this takes the `files:read`
  scope** (below).

- **Discord**: a message's attachments whose `content_type` is an image are fetched from their CDN
  URL (`cdn.discordapp.com`, `media.discordapp.net`, or a stand-in's own host), which is signed, so
  **no credential rides the fetch**.

Only the mention's own images are handed over (and Telegram's replied-to photo). An earlier message
of a quoted thread that carried a file is still described as "with an attachment ryph cannot open".

## A run's images

A run puts an image a tool returned (a browser screenshot, above all) into what it says by writing
`![what it shows](img-…)` with the image's ref, in a `chat__post` or in the summary the closing line
quotes. The service asks the control plane what each ref names in THAT run
(`POST /v1/chat/runs/:runId/images/resolve`, with `RYPH_CHAT_TOKEN`) before anything is said, so a ref the
run has no image under fails the post whole, naming it, and nothing is sent. Then the text goes out
with each ref's markdown replaced by its alt (`Image N` when the alt is empty), and the images
follow it into the same conversation, in order, each captioned by that label, their bytes fetched
from the control plane (`GET /v1/chat/runs/:runId/attachments/:attachmentId`) only when the platform
will take them. At most ten per post. An image that does not make it after the text went out does
not fail the post: the tool's answer says which, and why. The closing line is the platform's and is
said whatever comes of its images.

- **Slack**: `files.getUploadURLExternal` per image, the bytes to the URL it answers, then one
  `files.completeUploadExternal` sharing them into the thread. **This takes the `files:write`
  scope.** An app without it is answered `missing_scope`, and the images go as links to ryph
  (`/images/<run>/<attachment>`, behind a ryph login) in a message of their own instead; the log
  says so once per room. Add the scope under OAuth & Permissions and reinstall the app.
- **Discord**: the images as files on one message in the thread (`files[n]` beside `payload_json`,
  ten at most), each described by its label and the labels as the message's words. A bot without
  **Attach Files** is answered Missing Permissions (50013), and the images go as links to ryph
  instead, as on Slack.
- **Telegram**: `sendPhoto` for one, an album (`sendMediaGroup`) for more. A photo past Telegram's
  bounds — a full-page screenshot is often too tall — goes again as a file (`sendDocument`).
- **Zulip**: each image is uploaded to the realm (`POST /user_uploads`) BEFORE the text, and the
  text goes out as one message with `[label](/user_uploads/…)` where the run wrote each image,
  which Zulip shows as the picture in place. An image that did not go up reads as its label, and
  the text still goes.

## The pollers

No public ingress for any of the four, so all of them work on a laptop and on the homelab. One pass
per tick over every live room, each room under a Postgres advisory lock so replicas share the work
without repeating it; the cursor is persisted after each update. A room's lock is taken once and
held for as long as that poller answers for the room, rather than per pass: a Slack connection
outlives a pass and acknowledges envelopes on arrival, so two pollers on one room would split
Slack's events between their connections and lose whatever the loser had already acknowledged.
Because the lock lives on a connection and a connection that drops releases it without telling
anyone, every pass after the first asks the database whether the lock is still this session's
rather than going by what it once took.

**Telegram** long-polls `getUpdates`. Its default **privacy mode** withholds plain @mentions, so
**turn privacy mode off** in BotFather (`/setprivacy` → Disable) before adding the bot to the group,
or remove and re-add it afterwards — Telegram applies the change only on a re-add. Making the bot a
group admin works too. The bot then receives every message in the group and only a message that
mentions it or replies to it goes anywhere. The group is learned from a mention that quotes the
room's one-time **link code**, shown once on the management surface.

**Zulip** registers an events queue for `message` events (`idle_queue_timeout` seven days,
`apply_markdown: false`) and long-polls it. A generic bot subscribed to nothing still receives
every message that mentions it in a public channel — and nothing else; only messages the server
flags `mentioned` count (a silent mention, a wildcard or a mention in a code block never do), and a
bot's message never does. When the queue is gone (`BAD_EVENT_QUEUE_ID` after a server restart) the
poller registers a new one and **backfills** through the `is:mentioned` narrow from the last message
it handled; message ids are monotonic, so nothing replays. **A private channel is served only if the
bot is subscribed to it**: the bot hears a mention from one it is not in, but cannot read, react, or
reliably reply there.

To set up Zulip: create a **generic bot** (Settings → Bots), copy its email and API key, and paste
them with the organization's URL — pasting takes `chat:manage`, because this server then dials that
URL. Subscribe the bot to any private channel it should serve; public channels need nothing. A
leaked key reads every public channel's history and posts as the bot — regenerate it in Zulip, and
paste the new one into a new room.

**Slack** opens a **Socket Mode** connection: `apps.connections.open` (the app-level token) answers
a single-use WebSocket URL, and the app's `app_mention` events arrive down it as envelopes. Socket
Mode rather than the Events API for the reason above: nothing is published. The connection is the
one piece of state a transport keeps, keyed by the room and closed on drain or once the poller stops
answering for that room — archived — which would otherwise leave a socket acknowledging events
nobody reads. Reopening asks Slack for the new URL before letting go of the old connection, so a
refused `apps.connections.open` cannot take the acknowledged mentions with it. Slack rotates
connections and says `disconnect` before it closes one, and the next poll opens a fresh one. A
connection is also replaced once it is fifteen minutes old, whatever it is doing: a socket can stop
delivering without ever closing — a laptop that slept, a NAT that dropped the flow — and then it
sits open and silent, so age is the bound that does not depend on hearing about the failure.

**An envelope is acknowledged the moment it arrives, and Slack never offers it again.** This is the
one place Slack is weaker than the other two: there is no cursor to resume from, so a process killed
between the socket and the mention door loses that mention and the person mentions again. Holding
the acknowledgement until the door has answered would trip Slack's three-second deadline and flood
the room with retries, which is worse. Past a thousand queued envelopes the adapter stops
acknowledging, which is Slack's own back-pressure: an unacknowledged envelope is redelivered.
Because there is nothing to replay, a queued envelope leaves the queue only once it is in the port's
shape: a `conversations.info` that fails partway through a drain hands back what was already read
and leaves the rest queued for the next poll.

Anything the service did not itself compose is escaped on the way out — a run's words, an
automation's title, a patch path — so `<!channel>` in something a run quotes reaches the room as
those characters rather than paging everyone. Slack decodes those escapes on the way in, which is
how text from a thread the run was handed as evidence would otherwise come back live. Formatting
is untouched, and the lines the service composes are mrkdwn on purpose and are posted as written.
Zulip gets the same treatment in its own syntax: `@**all**` and the rest become Zulip's silent
`@_**all**`, which renders the name and notifies nobody. Discord's `@everyone`, `@here`, `<@…>`,
`<@&…>` and `<#…>` get a zero-width space after the `@` or `<`, so they do not even render as
mentions — the second lock behind `allowed_mentions`.

Slack delivers an `app_mention` only from a conversation the app is a **member** of, so **invite the
bot to every channel it should serve** — which is also the list a picker offers, since a channel the
bot is not in could never answer — public ones included — and nothing else said in those channels
ever reaches this process. Only a mention counts: a thread reply without one does not. A channel's
visibility is read live on every mention (`conversations.info`) and never guessed, since it decides
what the control plane may start from there. **A channel shared with another organization through
Slack Connect is not private**, whatever `is_private` says: that organization manages its own
members and can add them later, so the channel is no longer this workspace's allowlist — it is read
as public, which means public repositories only, no response bound there and no steering from it. A
share across workspaces of one Enterprise Grid organization is this company's own people and stays
private. A channel the bot cannot describe at all fails the poll rather than being taken for public
or private, and one it has been removed from is dropped. A thread whose root is a standalone message
is that message alone — a mention at the top of a channel gives the agent the instructions and no
surrounding chatter, and a mention inside a thread gives it the thread.

**Discord** holds a **Gateway** connection: `GET /gateway/bot` names the socket, and the bot
IDENTIFYs with the `GUILDS`, `GUILD_MESSAGES` and `MESSAGE_CONTENT` intents, heartbeats at the
interval Discord's HELLO names (the first beat jittered) and hears every message in every channel
it can see — of which only one a person wrote that mentions it (or its managed role, which
Discord's @-autocomplete offers beside it), or replies to one of its posts, is kept. The room is one
server, and **one bot serves one room**: a second room on a bot that already serves one is refused
(`400`), because one Gateway connection carries every server the bot is in and the daily identify
budget is the token's (a partial unique index on the live Discord rooms' bot ids decides two
creations racing). A bot whose application is **public** is refused too: anyone could add it,
and stream their server into the socket. Another server the same bot sits in is ignored, and a
channel or thread of another server — read, or posted into — counts as missing. Every post carries
`allowed_mentions: { parse: [] }`, so nothing ryph says pings anyone. A Gateway event is not
acknowledged, but a **session resumes**: a dropped socket, a RECONNECT, or a heartbeat Discord did
not acknowledge (a zombie connection — the liveness check, so there is no age bound) is closed
resumably and the next poll RESUMEs with the session id and the last sequence, and Discord replays
what was missed. The session is the room's cursor (`<session id> <resume URL>` and the sequence of
the last handled event), so a restart inside the resume window loses nothing either; past it Discord
says INVALID_SESSION and the bot identifies afresh, and what came in between is lost, as on Slack.
Discord resets a token that identifies a thousand times a day, so a room identifies at most once
every ninety seconds, and not at all while `GET /gateway/bot` says fewer than fifty of the day's
remain (each poll throws until Discord's reset). The Gateway is dialled only on `discord.gg` (or a
stand-in's host): a resume URL read back from the cursor table is not where the token goes unless it
is Discord's. A socket that sends no HELLO within twenty seconds, or no READY/RESUMED within twenty
seconds of the IDENTIFY/RESUME, is closed; three such resumes in a row forget the session (and the
cursor's copy of it) and identify afresh, and from the fifth failed dial in a row each poll throws so
`chat.poll_failed` says so. A close no reconnect fixes — 4004 (the token), 4014 (the **Message
Content** intent is off), 4010 to 4013 — fails every poll with an error naming the fix and how to
recover. 4014 recovers by itself: while held, the room reads `GET /applications/@me` every five
minutes (no IDENTIFY spent) and listens again once the intent is on, keeping its id, policy and
automations. The rest are not redialled until the room stops being polled (archived and added
again — for 4004, with a new token) or the process restarts. A mention of the bot's managed role
heard while the roles read failed is kept aside until a later read (at most once a minute) says
whether the role is the bot's; other mentions are not held up by it. A channel's visibility is read live on every mention: **private when `@everyone` is
denied View Channel** there (Discord's Private Channel switch; a channel synced to a private
category carries its overwrite), public otherwise — no permission engine, so a server whose
`@everyone` sees nothing and whose roles grant everything reads public, which errs the safe way. A
thread's visibility is its parent's: a private thread in a public channel is one anyone there could
make. Only text and announcement channels, and their threads, are served; a forum post or a voice
channel's chat is dropped. To set up Discord: [`setup/discord.md`](setup/discord.md) — an application
with a bot, the Message Content intent on, Public Bot off, invited with the seven permissions it
lists, and its token pasted with the server's id — one application per server. A leaked token reads every channel the bot can see: reset it,
and paste the new one into a new room.

To set up Slack: create an app from `setup/slack-app-manifest.yml`, which carries Socket Mode, the
`app_mention` subscription and the eleven scopes a room needs — or build one by hand with the
`app_mentions:read`, `chat:write`, `reactions:write`, `channels:read`, `channels:history`,
`groups:read`, `groups:history`, `users:read`, `usergroups:read`, `files:read` and `files:write`
scopes.
**An app made before images were handed over lacks `files:read`**: add it under OAuth & Permissions
and reinstall the app, or its mentions' images are each dropped with a note (Slack answers a token
without it with a sign-in page, which the service says is not a file). **An app made before a
run's images went out lacks `files:write`** the same way: add it and reinstall, or those images go
as links to ryph. Slack normally keeps
the bot token across a reinstall; if OAuth & Permissions shows a new one, paste the new pair into a
new room. Install it in the
workspace, copy the **bot token** (`xoxb-…`) from OAuth & Permissions and an **app-level token**
(`xapp-…`) with `connections:write` from Basic Information, and paste both. Usergroups are a
paid-plan feature: a workspace without them lists none, and a command room there uses "everyone in
the room" in private channels. A leaked bot token reads and posts in every channel the app is in:
replace it in Slack, and paste the new pair into a new room.

## Running

| Variable                      | What                                                                    |
| ----------------------------- | ----------------------------------------------------------------------- |
| `RYPH_CHAT_PORT`              | the listener (default `7450`)                                           |
| `RYPH_CHAT_DB`                | a ryph database URL; `ryph_chat` in the networked deployment            |
| `RYPH_CHAT_KEY`               | the master key sealing bot secrets — this process's own, **required**   |
| `RYPH_AUTH_URL` / `RYPH_AUTH` | the JWKS user bearers verify against, or `off`                          |
| `RYPH_CHAT_TOKEN`             | the orchestrator link, both directions                                  |
| `RYPH_ORCHESTRATOR_URL`       | where the mention door is                                               |
| `RYPH_CHAT_GATEWAY_TOKEN`     | what the gateway presents on the data route                             |
| `RYPH_CHAT_POLL_INTERVAL_MS`  | the poll tick (default `2000`; a room's own long poll spans many ticks) |
| `RYPH_CHAT_TELEGRAM_API_URL`  | a stand-in Bot API origin (default `https://api.telegram.org`)          |
| `RYPH_CHAT_SLACK_API_URL`     | a stand-in Web API base (default `https://slack.com/api`)               |
| `RYPH_CHAT_DISCORD_API_URL`   | a stand-in REST API base (default `https://discord.com/api/v10`), whose `GET /gateway/bot` names its socket |

Under the single-process `ryph` binary none of this is set: the host mounts the routes, mints the
gateway token at boot, hands the orchestrator the service in-process, and hands the service the
door in-process. The three API overrides are read there too. They exist for a stand-in of the
platform, such as the playground's mock platforms or a local Bot API server, and are unset
everywhere else. A bot token goes to whatever they name, so they are env only, read once at start.
Zulip needs none, since its realm URL is part of each room's credential.

```sh
bun run --filter '@ryph/chat' test
bun run --filter '@ryph/chat' db:generate </dev/null   # after a schema change
```
