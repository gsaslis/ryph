# @ryph/service 🩺

What every long-running ryph service needs from whatever runs it: **a listener for its fetch
handler, health probes, a bounded drain, and a lease for work one replica does at a time.** Nothing
else — no routing, no auth, no config.

Small and shared on purpose. All three are pure policy with no dependencies, identical in every
service that has them, and easy to get quietly wrong in ways that only surface during an incident. The same
reasoning that makes [@ryph/logger](../logger/README.md) a package.

## 🔌 Serve

```ts
const server = await serve({ port, onListen: () => {} }, streams.wrap(router));
```

A web-standard fetch handler on a `node:http` listener, the way `Deno.serve` ran one. Bodies stream
both ways with backpressure, `req.signal` aborts when the client leaves (and once the response is
done), a body cut short errors rather than ends, and `shutdown()` stops accepting, lets in-flight
requests finish and closes idle keep-alives. It **resolves once listening and rejects with the bind
error** (`err.code`), where `Deno.serve` threw synchronously. That code is the real reason: Bun's
node:http calls every bind failure `EADDRINUSE`, so a failed bind is retried once on node:net to
learn it (`bindError`); `listenNode(server, port, host)` does the same for a bare node:http server.
`frontHttpServer(server)` puts a node:net listener in front of a bare node:http server whose
upgraded sockets are piped or paused: written for Bun 1.4.2's, which did not pause (fixed in 1.4.3),
it still gives a configurable first-request deadline, TCP keepalive, and upgraded sockets closed by
their client's FIN (docs/runtime.md, Bun bugs); the server is listened on, closed and capped
(`maxConnections`) as before.
The keep-alive defaults to 620 s (`DEFAULT_KEEP_ALIVE_MS`, `keepAliveTimeoutMs` to change it), past
a Google Cloud load balancer's 600 s, so the balancer always closes an idle connection first; the
headers timeout to just past it (`DEFAULT_HEADERS_MS`, 630 s, `headersTimeoutMs`; Bun ignores it).
Both constants are exported for any bare node:http listener behind such a balancer.

A handler upgrades a WebSocket with `info.upgradeWebSocket(req, opts)`, which returns `{ socket,
response }` as `Deno.upgradeWebSocket` did; `socket` is a standard `WebSocket`. It runs on the real
`ws` package, loaded by path because Bun's stand-in for `ws` ignores `maxPayload`. `opts` takes the
subprotocol to answer with (`protocol`), the ping interval (`idleTimeout`, 120 s, 0 for none), the
largest message (`maxPayload`, 64 MiB; a bigger one closes the socket as its header arrives), the
most frames one message may arrive in (`maxFragments`, `ws`'s 16384; past it the socket closes with
an `error`; 1 refuses a fragmented message at its second frame, its first fragment, up to
`maxPayload`, held until then), and `refusePings`: a ping from the peer terminates the socket instead of being answered (and so does a
pong when this end sends none), for a peer with a heartbeat of its own, since `ws` queues a pong per
ping whatever its backlog. Beyond the standard, `socket.terminate()` destroys the socket at once,
whatever it has queued, where `close()` would queue a close frame behind it. A socket closed or
terminated by its handler before the handshake is refused, never opened; one whose handshake `ws`
refuses (a bad key or version) ends closed, with an `error` and a `close`.

`caFetch(ca)` is a fetch for an API server behind a private CA (the Kubernetes API): it accepts only
certificates that CA signed.

## 🩻 Health

```ts
const health = makeHealth({ ready: () => store.listEvents("probe", { limit: 1 }) });
const router = makeRouter([...health.routes, ...serviceRoutes]);
```

Two probes, deliberately answering different questions:

| | | |
| --- | --- | --- |
| `GET /healthz` | **Is this process alive?** | No dependencies, no I/O, always `200` |
| `GET /readyz` | **Should this replica get traffic?** | Checks the one dependency it cannot serve without, and `503`s the instant a drain begins |

The split is the point. A `503` on `/healthz` means *restart me*, so a database outage must never
produce one — restarting every replica against a down database turns a recoverable incident into a
crash loop. A `503` on `/readyz` only means *route around me*, which is cheap and reversible.

Both are **unauthenticated**, because a load balancer carries no bearer. So neither says anything a
prober should not know: a failed readiness check answers a bare `{"status":"unready"}` and puts the
reason in the log, where it is already behind whatever guards the logs.

The readiness check is bounded (2s by default). A hung dependency is as unready as a broken one,
and much likelier to be the thing actually wrong.

## 🚰 Drain

```ts
installDrain({
  servers: [controlServer, dataServer],
  beginDrain: health.beginDrain,
  close: () => store.close(),
  log,
});
```

`serve`'s `shutdown()` stops accepting and waits for in-flight requests. That is the right
behaviour and, on its own, **a hang**: an SSE tail never finishes, so a replica with one open
transcript stream waits forever, the platform eventually SIGKILLs it, and every other in-flight
request dies with it.

So the drain is ordered and bounded:

1. **go unready** — the load balancer stops sending new work
2. **pause** (`preStopMs`, default 0) while it notices; deregistration is not instant
3. **close the listeners**, waiting for in-flight work up to `deadlineMs`
4. **release** what the process holds — timers, database connections
5. **exit 0**

The default deadline is 25s, under the 30s that Kubernetes (`terminationGracePeriodSeconds`)
defaults to. Past that the platform SIGKILLs, and a SIGKILL skips
step 4 entirely.

Hitting the deadline still exits `0` and logs `drain.deadline_exceeded`. One viewer watching a
transcript must not fail a deploy — the log is the signal, not the exit code.

A **second signal** skips all of it and exits `128 + signum`. Someone pressing `^C` twice, or a
platform escalating, means *stop now*.

## 🔒 Lease

```ts
const lease = makeLease({
  store: kubernetesLeaseStore(api, { namespace: "ryph-tools", name: "mcp-hosting" }),
  identity: `${hostname}-${crypto.randomUUID().slice(0, 8)}`,
  now: () => new Date(),
  diag,
});
await lease.acquire(signal); // or lease.tick() from a loop of your own
if (lease.held()) act();
```

Kubernetes runs two replicas at once through every rolling update and eviction, so work that two
must never do together (the MCP gateway's hosting, the control plane's reserved capacity) takes a
lease first. The rules are client-go's leader election:

- someone else's lease is free once this process has **seen it unchanged** for its duration **by
  its own clock**. The holder's `renewTime` is the holder's clock and is never compared with ours,
  so skew between pods cannot make two holders.
- a holder stops calling itself the holder at its renew deadline, which is shorter than the
  duration: it stops before anyone else may start, and the gap is the margin for a slow request.
- a released lease is free at once.
- every write is conditioned on the version just read.
- every interval is timed on a monotonic clock (`performance.now()` unless injected). The wall clock
  only stamps `renewTime` for an operator, so an NTP step on either pod moves no deadline.

`kubernetesLeaseStore` keeps the record as a `coordination.k8s.io/v1` Lease through the caller's own
API client (it needs `get`, `create` and `update`), whose request timeout should sit well inside the
renew deadline.

## 🧪 Commands

```sh
bun run test  # serve over real sockets, the probe split, the drain's ordering and deadline, the lease
bun run ci    # type-check, tests (fmt and lint run from the repo root)
```
