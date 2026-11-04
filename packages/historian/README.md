# @ryph/historian

The **permanent record** of what happened during a run. The runner emits every **transcript** chunk
(what the model did: assistant text, thinking, tool calls, tool results) and every **diagnostics**
event (the machinery's story) as `HistoryEvent`s; the historian stores them append-only and serves
them back — paginated for history, streamed for watching a run live.
It is the read-side companion to [the orchestrator](../orchestrator/README.md): the orchestrator
records _how a run ended_ in its own `run_events`; the historian records _everything the run said_
along the way, and the [app](../app/README.md)'s task-detail page merges the two.

## ⚙️ How it works

Everything hangs off one noun. A `HistoryEvent` is `(runId, lane, seq, at, voice, kind, level,
text, payload)`, and both voices — `transcript` and `diag` — share that envelope. The **runner
assigns `seq`**: it is the single writer for its run, so one counter across both voices is a total
order for free, and `(runId, lane, seq)` doubles as the idempotency key that makes the emitter's
blind retries safe (`INSERT … ON CONFLICT DO NOTHING`). The service stamps, stores, and broadcasts
only the rows that were actually new, so a retried batch acks as duplicates and never replays onto
live listeners.

A run's history is split into **lanes**. Lane `""` is the run's own transcript; each subagent writes
a lane of its own, `sa-<n>`, with its own seq counter. Every read names one lane (`?lane=`, absent =
`""`), so a reader that never heard of lanes reads exactly what it did before. `GET
/v1/runs/:id/lanes` lists the subagent lanes from their `subagent.start`, latest `subagent.resume`
and latest `subagent.end` events, and `/lanes/stream` keeps that list live.

The historian has **no process of its own**: its route list mounts inside the orchestrator, the same
trick as [@ryph/auth](../auth/README.md) and the control side of
[@ryph/model-proxy](../model-proxy/README.md). Two ports keep it honest —
`HistoryStore` (idempotent append, seq-ordered pagination) and `HistoryBus` (live fan-out) — and
that bus is the seam that makes a future split-out into its own process cheap.

Two things it deliberately does not own. **Auth is injected**: the historian cannot verify a run
token (the runs table is the host's) and has no notion of a user, so its routes take two gates from
the host — the user gate for reads, a per-run bearer check for ingest. And **a run's ending comes
from the host, not the record**: `historianRoutes` hands back a `concludeRun(runId)` that the
orchestrator calls when a run reaches a terminal state, at which point the open live tails say `done`
and hang up. A run ending is a lifecycle transition, and those the historian never sees.

## 🔌 HTTP surface (mounted into the host's route table)

| Route                                   | Auth       | Behavior                                                                                    |
| --------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `POST /v1/runs/:id/events`              | run bearer | Batch ingest, ≤200 events, each with an optional `lane`; duplicates re-acked (`{accepted, duplicates}`) |
| `GET /v1/runs/:id/events?after=&limit=` | user gate  | One lane's ascending seq page (`lane=`, default `""`), ≤1000; `{events, lastSeq, hasMore}` — follow `hasMore` from `lastSeq` |
| `GET /v1/runs/:id/events/stream?after=` | user gate  | SSE of one lane (`lane=`): replay → live tail; `id:` = seq, `Last-Event-ID` resumes; `done` closes a concluded run |
| `GET /v1/runs/:id/lanes`                | user gate  | `{lanes: LaneSummary[]}`: each subagent lane's start, latest resume, latest end, in `sa-<n>` order |
| `GET /v1/runs/:id/lanes/stream`         | user gate  | SSE: each `LaneSummary` on connect, then a lane's fresh one (`event: lane`) on its start/resume/end; `done` |

| `POST /v1/runs/:id/live`                | run bearer | Live uplink: one streamed NDJSON body per run, read line by line; a newer one replaces it    |
| `GET /v1/runs/:id/live/stream`          | user gate  | SSE: `snapshot` (again when an uplink opens), then `frame`/`tabs`/`console`/`network`/`action`/`status`/`uplink`; `done` |
| `POST /v1/runs/:id/live/commands`       | run bearer | Background commands' uplink: the same discipline as `/live`, its own room                     |
| `GET /v1/runs/:id/live/commands/stream` | user gate  | SSE: `snapshot` (again when an uplink opens), then `started`/`output`/`skipped`/`exited`/`uplink`; `done` |

Plus one non-HTTP export beside them: `concludeRun(runId)`, the host's terminal signal (above).

## History size limits

Assistant transcript text is allowed 128,000 UTF-16 code units; other text is limited to 8,000.
The runner marks truncated text explicitly. Payloads retain their separate, smaller limits.

The runner sends at most 100 events and 1 MiB of UTF-8 JSON per request, with a 15-second request
timeout. Its queue is bounded by both 5,000 events and 8 MiB of encoded events (except the tiny,
critical retraction marks). Overflow is reported as a `history.dropped` event. The ingest route
independently stops reading at 1 MiB and returns `413` before JSON parsing, even for chunked bodies
or unknown fields. The event-count schema ceiling remains 200.

History pages stop at 1 MiB or the requested event count, whichever comes first. A single oversize
legacy row is still returned so pagination can advance. Database reads start with eight rows and
double the window while the page fits, capped at the remaining event count plus one lookahead row.
This avoids hundreds of round trips for small events without immediately fetching 1,000 large rows. Follow `hasMore`, not the number
of returned rows: `lastSeq` resumes forward pagination, `firstSeq` resumes `before` pagination.

These are per-request and per-buffer bounds, **not complete denial-of-service protection**. An
agent can read its run bearer and bypass the runner. Sustained authenticated request floods,
concurrent uploads, total stored history, and the durable-history SSE replay/viewer queues still
need separate rate, concurrency, retention, and backpressure policies. The live-channel limits
below do not apply to the durable-history SSE endpoint.

## 📺 The live channel

A run's browser is watched through here too, and it is everything the record is not. The runner
relays its sidecar's events as one NDJSON `POST` that stays open for the run; each line updates the
run's `LiveRoom` in memory (`core/live.ts`): the latest frame, the tabs, the status, and rings of
the last 500 console lines, 200 requests and 200 actions. **Nothing is stored** — the transcript's
tool calls are the durable record of what the agent did, and a frame from five minutes ago is worth
nothing. The sidecar replays its own rings of recent lines to every new relay session, so a new
uplink's lines are the room's whole history: opening one empties the rings, and viewers are sent a
fresh `snapshot` of the emptied room before the replay refills it, so a reconnect shows each line
once.

A viewer gets the room's `snapshot` first, then each event as it lands. Each viewer has its own
mailbox, and that is where backpressure lives: **frames coalesce** (a viewer that falls behind gets
the newest picture, never a queue of stale ones) while everything else queues up to a cap, dropping
the oldest and saying so with a `dropped` event. A room outlives its uplink by 15 minutes so a
reconnecting runner, or a viewer arriving just after the run ends, still finds the last state; at
most 256 are held, and a room with a live uplink is never the one evicted. A run takes at most 32
viewers per channel, and one reader (the user the verified bearer names) at most 4 of them, so
nobody can lock the others out; a further one is answered `429`. `concludeRun` ends it
all: the uplink is hung up and answered `410` (a replaced one `200 {replaced: true}`), viewers get
`done`, and a later uplink is answered `410` too, so a relay stops rather than reconnecting.

The uplink's run token is one the agent can read too (it shares a uid with the runner), so every
line is treated as the agent's own input and nothing it sends can grow the historian unbounded:
lines keep only their known fields (a frame's `viewport` is the one extra), every string is bounded
(free text is clipped, identifiers over their bound fail the line), a frame's `data` must be base64
of at most 400 KB, and lines are capped by kind — 768 KB for `frame`, `snapshot` and `tabs`, 16 KB
for the rest. A room holds at most ~8 MB across its rings, frame and tabs (the oldest ring entries
go first), and a viewer's queue at most ~4 MB besides its coalesced frame. The snapshot is built
once per room state and serialized once for every viewer that opens on it. Lines that are too long
or not a live event are dropped and counted; the uplink's response (when it finally ends) says how
many: `{accepted, malformed, oversize, refused, replaced}`.

**The live view is exactly as trustworthy as the agent.** The agent can open its own uplink, which
replaces the runner's, and then show viewers whatever it likes — a fake page, a blank one, nothing
at all. It is a window onto what the agent's browser is doing for a cooperating agent, not
evidence; the transcript's tool calls are the record.

A viewer is told `done` when the run concludes, or when the host says the run is terminal as the
viewer opens or on any keepalive after. In the single-process host that is the control plane's own
run record, so a lost signal cannot strand a viewer. The standalone historian owns no run rows: its
"terminal" is the conclusion row the orchestrator's ping writes (which also reaches replicas whose
`NOTIFY` was lost), and the ping is its only news that a run ended, so the orchestrator retries a
failed ping with backoff for a minute or two. A historian unreachable for all of that leaves that
run's open viewers on keepalives until they reconnect. Rooms live in one process, so a
second historian replica would not see another's rooms — a known limit, not yet solved.

## 🧵 The background commands' channel

A run's background commands get a second live channel beside the browser's, never mixed into it: the
browser's uplink resets its room on every connect, and so does this one, independently. The registry
and the viewer mailbox are the browser's (`core/rooms.ts`, shared); the room is a `CommandsRoom`
(`core/commands.ts`): per job the `started` and `exited` fields and an output ring of 256 KB, at
most 64 jobs and 2 MB per room, every string counted as UTF-8 bytes (an upper bound, never under).
Over the budget, the output of the job that ended first goes first, and only once no ended job holds
any does a running job's oldest output. A slow viewer may miss output (and is told, with `dropped`)
but never a `started` or an `exited`: those are what its list of jobs is drawn from, and there are
at most 64 of each per uplink. **Nothing is stored here** — what each job was and how it ended is
the orchestrator's `run_background_commands`, and its whole log is stored there when it ends.

The runner opens the uplink lazily on its first job and opens each one by replaying `started` for
every job, its ring as `output`, and `exited` for every ended one, so opening an uplink empties the
room and viewers get a fresh `snapshot` before the replay refills it. Lines, all capped at 16 KB:

- `{type: "started", at, id, label, command, cwd, service, timeoutAt}` — `label` 1..80 chars,
  `command` clipped to 2 KB, `cwd` to 1 KB, `timeoutAt` a moment or null
- `{type: "output", at, id, text}` — `text` clipped to 8 KB
- `{type: "skipped", at, id, bytes}` — the runner left `bytes` out for the window
- `{type: "exited", at, id, reason, exitCode, signal}` — `reason` one of `exited`, `timeout`,
  `stopped`, `run_ended`; `exitCode` an int or null; `signal` like `SIGTERM`, or null

`id` must match `^bg-[0-9]{1,3}$` or the line fails. A label, a command and a cwd lose their C0 and
C1 controls (a tab stays, a line break becomes a space), DEL, and the Unicode bidi controls before
they are clipped — the agent can write these lines itself — and a label with nothing left fails the
line. Clipping counts UTF-16 units and never leaves half a surrogate pair behind. A moment (`at`, `timeoutAt`) is epoch ms or an
ISO string, and viewers are sent ms. A line for a job the room never heard start, a second `started`
or `exited` for one id, and a 65th job are refused and counted as `refused`.

A viewer's `snapshot` is `{at, uplink, jobs}`, each job its started fields (without `type`; `at` is
when it started), `status` (`running` or `ended`), and once ended `reason`, `exitCode`, `signal` and
`endedAt`, plus `tail`: the output the room still holds. Then each line as it lands, under its
`type` as the SSE event name, `uplink` when the runner's connection ends, `dropped` when the viewer
fell behind, and `done` when the run concludes. It is exactly as trustworthy as the agent, for the
same reason as the browser's.

**Live output is not redacted.** The runner cleans it (escapes, control and bidi characters out)
and nothing redacts it, here or there. The run's own credentials are deliberately left in: they are
scoped to the run, reachable only inside its pod and the cluster, and already visible in the
transcript. The shape-based redaction (URL userinfo, virtual keys, `Authorization` headers) is the
orchestrator's, on the stored tail and log only.

## 🗄️ Its own database file

Storage is `RYPH_HISTORY_DB` (default `ryph-history.db`), with its own `drizzle.config.ts` and
`db:push` — deliberately **not** part of the orchestrator's shared file or push. The transcript
firehose is the biggest, fastest-growing data in the system; in its own file it can neither contend
with control-plane writes nor hold run-state's backups hostage, and a split-out historian process
just takes its file with it.

```sh
bun run db:push    # apply the schema to the history file (run once per schema change)
```

## ⚡ Quick start

```sh
bun run ci    # type-check, architecture guard, tests (fmt and lint run from the repo root)
```

The historian runs as part of the orchestrator — see
[its README](../orchestrator/README.md#-running-it) to bring the surface up end to end.

## 📚 Docs

| Doc                                     | What it covers                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| [architecture.md](docs/architecture.md) | the one noun, the ports, injected auth, host-driven conclusion, and the runner's end  |
