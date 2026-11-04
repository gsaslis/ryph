# @ryph/tunnel

Many TCP connections over one WebSocket: the wire a dev-server preview travels. The preview host
(`packages/host/src/previews.ts` locally, `@ryph/previews` hosted) opens a stream per browser request or upgrade and hands it to
node:http as its socket; the runner (`packages/runner/src/adapters/orchestrator/previews.ts`)
dials the dev server for each stream and pipes the bytes. Both ends live here so the protocol
has one definition, tested end to end in `tests/mux_test.ts`.

## ⚙️ How it works

The runner dials out to the host once per preview, so a run needs no ingress and each request
costs no handshake of its own: the host sends `{"open": id}` and the request bytes straight
after.

- **Binary frames** carry a 4-byte big-endian stream id and up to 64 KiB of bytes (`MAX_FRAME`); a
  longer write goes as several, one in flight at a time. Both ends name the framing as the
  WebSocket subprotocol `ryph-tunnel.2` (`offersTunnelProtocol` checks a dial's offer).
- **Text frames** are `"ping"` (the runner's heartbeat) or one of `{"open"|"ack"|"end"|"close": id}`.
  Only the host opens streams, and ids are never reused, so a late frame for a finished stream is
  dropped instead of landing on a new one.
- **One frame in flight per stream.** Each side acks a frame once its reader has taken it. A slow
  browser backpressures the dev server rather than buffering its download, and one stalled stream
  never holds up another.
- **`end` is a half-close, `close` an abort.** A stream that ends and closes at once still
  delivers what its reader has not taken yet.
- **The runner end is untrusted.** The agent shares its container. So the host treats as a broken
  wire (`invalid`: the caller terminates the socket, and every message after is `invalid` too, at no
  cost) anything malformed or oversized; a stream id it never opened, or an `open`; anything said of
  a stream that cannot apply in the state it is in: an ack with no frame in flight, a frame before
  this end acked the last one (or past what its reader may buffer), a frame or an `end` after the
  runner's `end` or `close`, a second `close`; more than five pings a second; and late messages (for
  a stream the host already let go) past their credit or their own bucket: each stream let go earns
  four (`LATE_PER_STREAM`), a tunnel holds at most `LATE_CREDIT` (320) of it, each late message
  spends one, and they go at most `LATE_CREDIT` at once and `LATE_RATE` (24 576) a second; what they
  cost is charged to the run's ack pace too, which refuses them past `RUN_ACK_BURST` units of debt
  of their own (refilled at `RUN_ACK_RATE`), so a runner that churns streams to send them is held to
  its run's rate (one used to take ~3.5 times it, 938 MiB in 3 s, and another run's first ack waited
  up to a second behind it; an honest churn of ~10 000 streams a second never takes them below
  full). Credit used to grow with every stream ever opened and was never spent down: 20 000 streams
  opened earned some 80 000 late 64 KiB frames, taken with no time passing. Every message for an
  open stream is thus one the host's own sends earned or the stream's one end and close, and none
  makes work or memory grow with repetition (`tests/fuzz_test.ts`). Nothing the state checks accept
  is refused for its pace: one busy honest stream over loopback sends tens of thousands of messages
  a second, and a cap on that broke 1000-module page loads and fine-grained event streams. The
  host's work is held to a pace by its acks instead (`pace.ts`, the budget's `pacer`): each frame
  costs a unit and one per 4 KiB (`ackCost`: measured, a 1-byte frame and its ack cost the host ~9.5
  µs and a 64 KiB one ~119 µs, so tiny frames buy no more of its time than bulk does), and its ack
  goes against its run's bucket, shared by every tunnel of the run (`RUN_ACK_BURST` 4096 units,
  `RUN_ACK_RATE` 24 576 a second), and the process's (`POD_ACK_BURST` 8192, `POD_ACK_RATE` 49 152),
  which runs contending for it share evenly by units spent (a run with nothing waiting goes at once
  when it has spent no more than a millisecond of the process's tokens past the least of those
  waiting; one alone has its own rate). Work with no ack to hold back — a late message, a frame
  whose stream went while its ack waited — is charged to the run's bucket at once and paid to the
  process's in the run's own turn, before its next ack, never out of another run's share; a
  cancelled ack leaves the line at once and pins nothing of its stream. An ack goes once its run's
  bucket and the process's both have a token for it, the run that spent least first, and a runner
  that waits for its acks (as every honest one does) is slowed, never broken; one that sends without
  waiting has nothing to answer and is (`tests/honest_test.ts` holds real ends to this over a real
  WebSocket and a late, batching wire; `tests/pace_test.ts` the sharing). Measured on an M-series
  laptop, a runner answering every ack with a 1-byte frame on four tunnels took ~62% of a core
  before, and one such run ~47% and two ~58% after (two saturated it before); an honest run's 64 MiB
  download went from ~390 to ~95 MB/s alone, sustained (~123 MB/s over 64 MiB, the burst a fifth of
  it), and from ~110 to ~50 MB/s beside two such floods (now its even third), while a 1000-module
  cold load stayed ~105 ms and an event stream's latency (1 KB every 10 ms) stayed ~1 ms p99 alone
  and ~2.6 ms beside the floods (1.9 before). What the pace does not bound: the work of a frame
  before its ack (it holds back the next frame, not this one), streams' opens and closes (those
  answer the host's own opens, which browsers' requests drive and the budget caps), and the runner's
  acks of what the host sends (one per frame a browser uploads). A tunnel's socket refuses
  fragmented messages (`maxFragments: 1` on each host's `ws`): a runner never sends one, and each
  continuation frame would cost a parse with the message's earlier ones held, charged to nobody. Its
  sends are bounded too (below): a backlog past what its streams are owed and one frame each of a
  tunnel's worth of closed ones, and more than 2048 sends queued at once whatever their size,
  terminate it.
- At most 64 streams per socket (`MAX_STREAMS`), both ends hold to it. The runner dials with
  `allowHalfOpen: true`, so a dev server that sends its whole answer and keeps reading still gets
  what the browser sends after.
- How many streams a host's tunnels may hold, and whose, is a `Budget` (`budget.ts`): plain counts
  for fairness, so a few runs never take what every other run needs. A run holds at most 64
  streams (`PER_RUN`, one full tunnel), 48 of them long-lived, so its short requests always have
  16; a process's own runs 768 (`POD_STREAMS`), 3/4 of them long-lived (`LONG_SHARE`); and relays
  (`relay`, a request sent on to another host that owns its run) a part of their own beside those
  (`relays`, 0 unless the caller says), so they never take an owned run's stream. Past a cap a
  request waits in line (`WAIT_MS`, or less when it already waited elsewhere), short and
  long-lived ones of a run in separate lines, and relays in a line of their own (`relayWaiting`,
  by default as many to `relays` as `POD_WAITING` is to the owned streams), so neither part ever
  takes the other's places. Every run may have `LINE_FLOOR` (128) waiting while its part's line
  (`POD_WAITING`) has room; past that it may add only while the line is short of `POD_WAITING`
  less `LINE_RESERVE` and it holds less than half of what the others leave of that, so runs that
  fill the line never squeeze another's cold page load to a few places: seven that take all it
  lets them leave an honest run its floor. Twelve runs at their floors fill the line, as twelve at
  their caps fill the streams: some twelve colluding runs per process is where it starves the
  others, by design. A stream that
  stalls is closed only when closing it lets a waiting request in, and one sweep serves the line
  after each close. The counts are constants: what keeps a process inside its memory is not the
  budget's to say. The hosted service measures its memory and, past a watermark, has the budget
  refuse the groups it names (`pressure`, asked per group), turn away their line and close every
  stream of theirs that holds bytes, progressing or not (`relieve`), turn away everyone's line
  (`empty`), and nearer the limit close anyone's streams until enough is freed (`shed`: named
  groups first, then streams making no progress, then the largest). `usage` says what each group
  holds, and how many of its streams hold any bytes.
- A request's body is read while it waits for a stream only when it is at most 16 KiB
  (`EARLY_BODY`) and, where the caller counts them (`hooks.early`, an `EarlyBodies`), the process
  holds less than `POD_EARLY` (4 MiB) of such bodies, so a browser that leaves takes it out of
  line; anything else is paused unread, and counted to its group as what it holds, asked each
  time the caller samples: what was read of it here and on its socket (what came with its headers,
  and the one read a paused socket still takes) and its kernel's receive buffer
  (`RECEIVE_BUFFER`, 128 KiB, the pod's cap), never more than its length. A read is as large as
  that buffer, so each holds some 384–512 KiB in a pod. A group may have at most
  `PAUSED_WAITERS` (128, some 64 MiB) large ones (past `EARLY_BODY`, or of unknown length) paused
  in line at once, each counted from its headers until its stream is connected (one granted a
  stream and still connecting counts too); past it the next is answered 503 at once, with
  `connection: close`, even with a stream free. A small body is never refused for it. Refused while its body is
  still coming, a request answers `connection: close` and drains at most `DRAIN_LIMIT`. An upgrade
  that sends more than 4 KiB before its 101 (`EARLY_LIMIT`) is closed. A response never carries
  more body than the `content-length` it was sent with: past it, it is cut with its connection
  (Bun's node:http server would write on, and the excess would read as a response of its own).
- The host's sends to a runner are bounded. The host knows which sends are still queued (ws sends
  in order), so `HostMux.excess()` says what the queue holds past the part of each open stream's
  frame awaiting its ack that is still in it. Past `MAX_BACKLOG` (65 frames) of that excess, past
  `MAX_BUFFERED` (129 frames) queued in all, or past `MAX_QUEUED_SENDS` (2048) sends queued, the
  socket is terminated (`Wire.terminate`, never a close frame queued behind it;
  `HostMux.overBacklog()` says the same for a sweep). The excess allows for a reload: every stream
  closed with a frame still queued, and every new one sending its own.
- **Long-lived** is a WebSocket upgrade (the caller's word) or a plain request asking for
  `text/event-stream` (`lasting`; a plain request's `Upgrade: h2c` changes nothing); a
  response that turns out to be `text/event-stream` promotes its stream (`promote`), while the
  long-lived shares have room. A long poll cannot be told from a short request.

## 🔀 Proxying a request

`proxyHttp` and `proxyUpgrade` carry one browser request or WebSocket upgrade over one stream, for
both preview hosts. The caller decides whether the request may pass; these decide how it travels:

- Hop-by-hop headers (and those `Connection` names; `withoutHopByHop` keeps those, for a hop
  between two of our own servers) are dropped, and every request goes upstream
  with `connection: close`, so a stream ends with its request.
- A dev server that answers before the upload is read has the rest drained, not reset; one that
  sends a status outside 200–599, or a 101 to a plain request, gets the browser a 502.
- An upgrade's browser socket closes 250 ms after its FIN, whatever the dev server does; a refused
  upgrade keeps its status.
- An upgrade is piped both ways, so a stream whose runner stops acking pauses the browser's socket.
  On Bun that holds only for a socket node:net accepted: the listener that hands `proxyUpgrade` its
  sockets must be fronted (`frontHttpServer` from `@ryph/service`), or a browser's upload is read
  without bound.
- `hooks.request` and `hooks.response` let the hosted service rewrite headers each way, the 101's
  included; `hooks.unavailable` answers a request no stream could be had for (a page in place of a
  bare 503).
- A refused upgrade (`refuseUpgrade`) is answered on its raw socket and destroyed
  `REFUSE_GRACE_MS` (1 s) later whatever the client does: on Bun a server socket whose peer never
  sends its own FIN never closes otherwise.

`permitted` is the request gate both hosts apply first: `Origin` the preview's own when present,
and a request from anywhere else only as a top-level navigation. An upgrade needs an `Origin`
unless the caller passes `originlessUpgrade` (the local binary does, for tools that are not
browsers).
