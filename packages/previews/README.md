# @ryph/previews

An agent on a hosted ryph runs a dev server and calls `ryph__expose_port`; people who can read that
run open it at `https://<id>.preview.ryph-previews.example` until the run ends. The local binary does
the same in-process (`packages/host/src/previews.ts`); both use the runner end and the wire in
[`@ryph/tunnel`](../tunnel/README.md).

Everything in memory, no database. A restart drops every tunnel; runners re-register the same
ports and get the same ids back, so links and viewer cookies survive it. One replica by default;
with several (the Helm chart's `previews.replicas`), each run's previews live on one pod and the
others forward to it (below).

## ⚙️ How it works

Three listeners, four with several replicas (the peer listener, below), each for one audience. The
public one keeps an idle connection 620 s, past a Google Cloud load balancer's 600 s reuse of one;
the peer one's relays are one request a connection. Each has a ceiling on its connections (below).
The public and peer listeners relay browsers' WebSocket upgrades as a pipe, which pauses the
browser's socket when the runner stops acking. Bun 1.4.2's own upgraded sockets did not pause (they
buffered a browser's upload without bound; fixed in 1.4.3), so those two accept on node:net and hand
each connection to node:http (`frontHttpServer` from `@ryph/service`), which also gives them TCP
keepalive and closes an upgrade on its browser's FIN; a stalled upload holds a read or two (512 KiB
each where the kernel lets a read be that large, 128 KiB in the chart's pods).

- **API, `:7493`.** The control plane's, and nobody else's: no run reaches it (the chart's
  NetworkPolicy, compose's run gate), so whatever a run does to the tunnel listener never reaches
  these calls. Never routed by the Gateway. `/internal/*`, behind
  `Authorization: Bearer $RYPH_PREVIEWS_TOKEN`:
  - `POST /internal/previews` `{runId, port, label, hosts}` → `201 {id, url, ticket}`, with
    `tunnelBase` too with several replicas. At most 4 per run and 256 per pod (`429`). The same
    `(runId, port)` again replaces the label, hosts and ticket, and keeps the open tunnel until the
    new one connects.
  - `GET /internal/runs/:runId/previews` → `{previews: [{id, port, label, url}]}`, connected ones only.
  - `POST /internal/previews/:id/viewer` `{runId, path?}` → `{url}`, a one-time `/__ryph/enter`
    link that lands on `path` (a plain same-origin path, else `/`), `404` unless the preview is that
    run's and connected. The ticket is `<exp>.<nonce>.<HMAC(token, "enter:<id>:<exp>:<nonce>")>`.
  - `GET /internal/previews/:id` → `{runId}`, `404` for an id this service does not hold: for the
    control plane's open by preview id alone.
  - `DELETE /internal/runs/:runId` → `204`; that run's previews close, and their ids are
    remembered (4096 at most, for the 8 h a cookie lasts) so a tab left on one says it ended.
- **Tunnel, `:7491`.** The runners', and nothing else. Never routed by the Gateway. An upgrade
  of `GET /tunnel/:ticket` is a runner's: the 10-second, single-use ticket from the registration is
  the credential. It upgrades to the WebSocket every browser connection then rides. 45 s without
  the runner's ping closes it. Any plain request is a 404, whether it names a pending ticket or not.
  Tunnels are `ws` sockets on node:http, which refuse a frame past the mux's frame limit as its
  header arrives, and a fragmented message at its second frame (`maxFragments: 1`: a runner never
  fragments, and each continuation would cost a parse with the message held, charged to nobody).
  The runner's messages are checked against its streams' state, never capped by count: the host's
  work is paced by its acks (@ryph/tunnel's pacer: per run across its tunnels, per pod split
  evenly between the runs that want it, each frame charged a unit and one per 4 KiB), which slows
  a runner and never breaks one. They are the `ws` package itself (`realWs()` from @ryph/service): Bun's stand-in
  for `import "ws"` ignores `maxPayload` and buffers any frame whole.
- **Public, `:7490`.** Behind the Gateway, for `*.<domain>`. `GET /__ryph/enter?ticket=` consumes
  a 60-second viewer ticket, sets the viewer cookie and redirects to the ticket's path; any other
  method is a 405 that leaves the ticket alone. Every other request needs that cookie and is
  proxied to `localhost:<port>` inside the run. A page load without it, a link an agent posted, is
  sent to the app's `/previews/<id>?path=` for a ticket when `RYPH_PREVIEWS_APP_URL` is set (the
  preview alone: the run is never named to whoever holds the link); anything else without it is a
  401 ("Open this preview from Ryph."). With the cookie, a preview between tunnels is a 503 ("This
  preview will be back in a moment."), one this pod does not know a 404 ("This preview isn't
  available. If its run is still going, it will be back shortly."): both reload themselves after
  2–5 s (picked per page, so tabs do not come back in lockstep) when a person's page load got them.
  One whose run the control plane ended is a 404 that does not ("This preview has ended."), also
  when its tunnel had closed a few minutes before the run ended. `/healthz` and `/readyz` answer on
  the public listener only, and only to a Host that is no name under the preview domain: the
  kubelet and the load balancer probe by the pod's address. Each answers `ok` or `not ok` and
  nothing more. `/healthz` fails while the memory guard says the pod is stuck. The tunnel and API
  listeners have none.

| var | meaning |
|---|---|
| `RYPH_PREVIEWS_TOKEN` | bearer for `/internal/*`, and the HMAC key for ids and cookies |
| `RYPH_PREVIEWS_DOMAIN` | e.g. `preview.ryph-previews.example`; `http` when it is or ends in `localhost` |
| `RYPH_PREVIEWS_PUBLIC_PORT` | only under `localhost`: the port browsers use, part of every origin |
| `RYPH_PREVIEWS_APP_URL` | optional: the app's origin, where a page load without the cookie goes for a ticket |
| `RYPH_PREVIEWS_PORT` / `RYPH_PREVIEWS_TUNNEL_PORT` / `RYPH_PREVIEWS_API_PORT` | 7490 / 7491 / 7493 |
| `RYPH_PREVIEWS_MEMORY_LIMIT_MIB` | only without a cgroup limit (a laptop, compose without `mem_limit`): the RSS the memory guard measures against; unset there, nothing guards the pod but its counts |
| `RYPH_PREVIEWS_MEMORY_HIGH` / `RYPH_PREVIEWS_MEMORY_CRITICAL` | the guard's watermarks, fractions of the limit; default 0.75 and 0.9 (critical may be 1) |
| `RYPH_PRE_STOP_MS` / `RYPH_DRAIN_DEADLINE_MS` | the drain's pause before it stops listening (default 0) and its deadline (default 25000) |
| `RYPH_PREVIEWS_REPLICAS` | replicas, default 1; the three below only matter above 1 |
| `RYPH_PREVIEWS_ORDINAL` | this pod's ordinal, below the replica count |
| `RYPH_PREVIEWS_PEER_HOST` | every ordinal's own host (its Service), with `{ordinal}` in it |
| `RYPH_PREVIEWS_PEER_PORT` | the peer listener, default 7492 |

### Several replicas

A run's owner is the pod whose ordinal scores highest for the run's shard (rendezvous hashing,
`src/core/cluster.ts`), and a preview id starts with that shard, so any pod knows the owner from
what a request carries: the run in a control-plane call, the Host of a browser request. A runner
is never forwarded: the owner's registration answer carries `tunnelBase`
(`ws://<its own host>:<tunnel port>`), and the control plane hands the runner a tunnel URL there;
any other pod holds no such ticket and refuses it. A pod that is not the owner forwards
control-plane calls to the owner's API listener with a credential derived from the token in place
of the bearer (`x-ryph-previews-hop`), and a viewer's browser requests (cookie checked first) to its
peer listener (`:7492`), which wants another derived credential and serves them through the same
code as the public one, every header as the browser sent it (its `Connection` header carried apart,
in `x-ryph-previews-connection`, since the hop's own connection is not the browser's). Without a
cookie only the way in goes on, and only with a ticket whose MAC, expiry and preview this pod
checked; a page load without one is sent to the app by whichever pod it reached. Nothing is ever
forwarded twice; a pod asked for something it does not own after a hop answers 503. A request a
preview's gate refuses (a sibling preview's page fetching or framing it, a service worker) is
refused before any hop, and again on the owner. Each hop is one fresh connection; relayed browser
requests are counted on the relaying pod under the run's relay cap there (its shard's: 32 at once,
24 of them long-lived, `PER_RELAY` in `src/peers.ts`), and all relays together at most 384, apart
from the 768 streams of the runs the pod owns, so those never lose a stream to relays and what one
run can make any pod hold does not grow with the replica count. A relayed request carries what is
left of its 30 s wait for a stream (`x-ryph-previews-wait`, read only behind the peer credential),
so it waits about as long in all as a direct one. No failover: a pod that is down takes its runs'
previews with it until it is back.

### Memory

What bounds a pod's memory is a guard that measures it (`src/memory.ts`): about once a second, its
cgroup's usage less the inactive file cache (v2, else v1) against the cgroup's limit, or without
one the RSS against `RYPH_PREVIEWS_MEMORY_LIMIT_MIB`. Each level is entered at its watermark and
left only 0.05 below it, so a pod near one does not flap: high is entered at 0.75 and left below
0.70, critical entered at 0.90 and left below 0.85.

| level | entered / left | what the service does |
|---|---|---|
| normal | until 0.75 | the counts below, nothing else |
| high | 0.75 / below 0.70 | names culprits, but only at a sample at or past 0.75 (below it, on the way down, it keeps and releases them and names nobody new), never within 10 s of naming one or closing at least 1 MiB unless usage rose 1% of the limit since the first of those (what closing frees reaches the counter seconds later), and only when what the runs hold explains at least half of how far the pod has grown since its baseline: the least it held at normal over the 5 minutes before it was pressed, never more than 0.65 of the limit, so the growth to explain is at least a tenth of it (`baseline`; none yet, nobody named). Otherwise it names nobody and says `previews.memory.unexplained` (the memory is the runtime's or the kernel's, and naming the largest holder would steer the guard onto whichever honest run is busiest). When their bytes explain it but no run holds its share of it, it names nobody either and says `previews.memory.no_culprit`, with the largest holder (`runId` or `shard`, `heldMiB`). A culprit is a run (or relayed shard) whose measured bytes (unread stream bytes either way and what their browsers' sockets hold, the kernel's buffers while they fill, plus 16 KiB for each stream holding any, tunnel send queue, bodies read or paused while waiting) are at least 1 MiB, at least the mean of those holding any, and at least its share of half the growth, split evenly among those past the mean; an idle stream counts nothing, so open tabs never name a run. A lone run explains at most twice what it can hold at the caps (some 100 MiB: 17 MiB of streams, 64 stalled downloads at some 272 KiB each, up to 64 MiB of uploads paused in its line (at most 128, `PAUSED_WAITERS`, at up to 512 KiB each, counted live: what was read of each and 128 KiB of kernel buffer), some 6 MiB of small bodies paused in the rest of it, early bodies and its tunnels' queues), so it is named at high only once the baseline is about half the limit or more, and is otherwise met at critical; the baseline's cap stays 0.65 because at 0.70 an honest busy run's ~17 MiB of streams would all but explain the 5% of growth left; nor is memory that grows slowly without being any run's bytes, which raises the baseline as it goes, up to the cap. A culprit stays one until normal, or until it has held less than 1 MiB for a minute. Culprits get nothing new (a page load gets the reloading "back in a moment" page), lose their place in line, have every tunnel of theirs whose queue is more than two frames past what its streams are owed cut, and lose every stream holding bytes, progressing or not. Nobody else is touched; with no culprit nothing more happens until critical |
| critical | 0.90 / below 0.85 | everyone is refused and every line emptied; every tunnel whose queue is more than two frames past what its streams are owed is cut, whoever's; streams are closed, culprits' first, then those making no progress, then the largest, until what they held covers the way back under 0.75, then 10 s for the freed memory to show before the next (not past 0.95) |

On entering high, public and peer connections idle 15 s or more are closed, once an episode (one
idle for less may be about to be reused by the load balancer); tunnel-listener connections that
have not dialled a tunnel and have been idle 2 s or more are closed every sample. Stuck — at
critical for at least a minute, and the latest shed found nothing to close — the pod fails
`/healthz` and the kubelet restarts it (the chart's probe: three failures 10 s apart, 5 s each to
answer, some 30 s); it passes again as soon as that stops holding
(below critical, or a shed that finds something). Compose's healthcheck asks `/readyz`, and Docker
does not restart an unhealthy container anyway, so there the pod is never restarted for it. Below
3/4 it does nothing.

The counts in `@ryph/tunnel`'s `Budget` are for fairness only, and constants: per run 64 streams
(48 long-lived) and 512 short and 64 long-lived requests waiting; per pod 768 streams for its own
runs (576 long-lived) and 1536 waiting, and, apart (neither ever takes the other's), 384 relays
(288 long-lived) and 768 of them waiting. Every run may have 128 waiting while the pod's line has
room, whatever the others hold (its floor); past that it may add to the line only while the line is
short of 1024 and it holds less than half of what the others leave of that. More memory lets a pod
carry more before it refuses anyone; it never lets one run, or the pod's counts, hold more. Eleven
hostile runs at every cap leave an honest one its whole cap on a pod; it takes twelve, all owned by
that pod, to fill it. The line holds out as long only against runs that keep to their floors: seven
that take all it lets them leave an honest run its floor, and the eighth does not. Some twelve
colluding runs per pod is where it starves the others, by design.

Each listener has a ceiling (`maxConnections`): the public one 6144, and past 4096 the connections
idle longest are closed to make room; the API one 1024; the peer one every other pod's relays; the
tunnel one 4096 in all, of which those that have not dialled a tunnel yet at most 64 per source
address and 256 in all, for 5 s each. Past the per-address cap that address's oldest silent
connection (nothing received on it yet) is closed to make room, at any age; one that has sent its
request keeps a 250 ms grace, since it may be a dial being served. Past the total cap, the address
holding the most gives one up, grace or not, so a new address always gets in. In a cluster each run
pod has its own address, so a run that floods the tunnel port only churns through its own. Behind
one address (compose's run gate) nothing tells runs apart: while a run floods there, another run's
dial can be closed before its request arrives, or refused, and that runner dials again on its
backoff. One run can keep the others' tunnels down while it floods (they come back once it stops),
never the control plane's calls. Bun says nothing of bytes that arrive before a request's
headers are whole, so there "sent its request" is as early as a connection counts as speaking.
None has a request timeout. Tunnels refuse protocol pings; a tunnel whose queue holds more than 65
frames' bytes past what its open streams are owed, more than 129 frames' bytes in all, or 2048
sends, is terminated, and every tunnel that goes is terminated, never closed behind its queue;
registrations are paced per run and port (429), a refusal spending neither. Bodies of up to 16 KiB
are read while their request waits for a stream, 4 MiB of them at most per pod; anything else waits
unread.

Every refusal a person would meet as a 503 — a line full, a wait that ran out, a stalled stream
closed, memory pressure, an owner that cannot be reached — is logged as `preview.refused` with the
run (or the shard, for a relay: the first 8 hex of each of its run's preview ids), the reason and
`cap`, which limit it was (`run`, `run-long`, `run-line`, `run-paused`, `relay…`, `pod`, `pod-long`,
`pod-relay`, `pod-line`, `tunnel`, `memory-high`, `memory-critical`, `memory-tunnel`, `register`, `peer`), once
per 10 s per run, reason and cap, with how many were folded into it. Once a minute while anything
is open, `previews.memory` says the pod's memory, RSS and heap, the guard's level, culprits and
`attributedMiB` (what it measured of the runs, to set beside the pod's memory), and its streams,
line and connections. `previews.memory.culprits` says each time the culprits change: the 16 holding
the most with `heldMiB` each, `overMiB` past high's exit, and how many were released.
`previews.memory.pressure` says each change of level, at most one line per 10 s; changes in between
are counted (`folded`), and once the 10 s are over the next sample says the level it is then at, so
the last line is always the current level.

## 🛡️ Trust model

A preview serves code the agent wrote to signed-in people, so the dev server is untrusted and so
is the runner end of the tunnel.

- **Own registrable domain, one origin per preview.** The preview domain has no logins, and each
  preview is `<id>.<domain>` with `id` the run's shard (first 8 hex of `HMAC(token, "shard:<runId>")`)
  then the first 24 hex of `HMAC(token, "id:<runId>:<port>")`. Two previews of one run share the
  prefix, and so can be told apart as one run's; the rest is unguessable without the key.
- **No ambient access.** Every request needs the `__Host-ryph-preview` cookie
  (`<exp>.<HMAC(token, "view:<id>:<exp>")>`, 8 h, host-only, `Secure; HttpOnly; SameSite=Lax`),
  minted only from a viewer ticket the control plane asks for after checking the person can read
  the run. Over `http` (under `localhost`) Safari refuses `Secure` and so `__Host-`: there it is
  `ryph-preview`, without `Secure`, still host-only; a sibling preview can then set decoys of that
  name with longer paths, which sort first, and only the first 8 cookies of the name are checked.
  This service holds no other credential and decides nothing about people.
- **Previews are same-site with each other**, so the gate the local binary shares
  (`permitted` in `@ryph/tunnel`) applies: exact Host, `Origin` the preview's own when present
  (always on an upgrade), and a request from anywhere else only as a top-level navigation.
- **What the dev server says stays in its origin.** `Domain` is removed from its `Set-Cookie`s and
  a cookie of either of our names (or a nameless one whose value starts with one) dropped; our
  cookie is removed from what it is sent, and so is the viewer's address (`X-Forwarded-*`,
  `Forwarded`, `Via`, `X-Real-IP`); `Clear-Site-Data` is dropped (its `"cookies"` reaches every
  preview), and `NEL`, `Report-To`, `Reporting-Endpoints` and
  `Content-Security-Policy-Report-Only` too; its own CSP loses `report-uri` and `report-to`;
  `Service-Worker: script` requests are refused; `/__ryph/` is never forwarded.
- **The page may reach what the run could.** A CSP built from the run's egress allowlist rides
  every response beside the dev server's own, holding fetches, WebSockets, subresources and forms
  to it; an open-network run gets `frame-ancestors 'self'` alone. Framing is held to the page's
  own origin either way, so Storybook and the Vitest UI can frame their own pages.

What it does not cover:

- Navigation, `window.open`, WebRTC and DNS prefetch can still carry data out of a viewer's
  browser. No CSP closes them.
- Page JS can set a `Domain=ryph-previews.example` cookie with `document.cookie`, which every
  preview gets: it can toss cookies at a sibling, or fill the jar until every preview fails for that viewer until
  they clear cookies. Listing the preview domains in the Public Suffix List (private section) fixes
  it; that is for the operator to do.
- A browser without `Sec-Fetch-*` (Safari before 16.4) lets a sibling preview include this one's
  scripts.
- No listener has a header timeout of its own that Bun honours; Bun's node:http closes a
  connection whose headers stall after about 10 s (on the public and peer listeners the front
  does, at 10 s, for a connection's first request; later ones get the keep-alive timeout).
- A request pipelined behind another on a public or peer connection is lost, and the connection
  with it (Bun, on the node:net-accepted sockets those listeners use). Browsers never pipeline.
- A viewer ticket is a bearer token for its 60 s: whoever a person forwards an unspent enter link
  to gets the 8 h cookie. And a page load without the cookie is sent to the app with its path and
  query, which then appear in the app's and control plane's request logs.

Pure, unit-tested pieces live in `src/core/` (ids and cookies, CSP, the gate, header rewriting);
`tests/service_test.ts` runs the whole service against a real dev server and a real runner end.

## 🧪 Development

```sh
bun run check
bun run test
```
