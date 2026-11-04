# @ryph/browser 🧭

A real Chromium for one run, as a **sidecar** beside the agent: the agent drives it through MCP
tools (`browser__navigate`, `browser__click`, …) and a human watches it live from the run page. It
shares the run's network namespace, so `http://localhost:5173` is the dev server the agent just
started in its own shell — on Kubernetes and under docker alike.

It keeps nothing. No database, no volume, no credential at rest: one process, one browser, and a
stream of what the browser is doing, of which it keeps only the last few hundred lines in memory.

## ⚙️ How it works

**It boots knowing nothing.** The runner, which holds every credential of the run, configures it
once — `POST /configure` with the bearer its MCP client will present and the egress proxy's per-run
Basic credentials — and from then on it is bound. First call wins; every later one is `409`, and
every route but `/healthz` answers `503` until then. The pod's network namespace is shared with the
agent's shell and any service container, which is exactly why the configure is one-shot: whoever
configured it owns it.

**It listens on `127.0.0.1` only.** Its one client, the runner, shares its network namespace on
both platforms — a native sidecar in the run's pod, `--network container:` beside the agent under
docker — so nothing outside the namespace needs to reach it, and on docker's shared network
nothing else can.

**Chromium launches on the first tool call**, not at boot, so a run whose agent never opens the
browser pays for one sleeping process. The **sandbox goes first**: Chromium's own (a user
namespace per renderer and a seccomp filter) works under gVisor, which is how runs are confined on
Kubernetes, and fails under runc ("No usable sandbox") — docker. The orchestrator says which it is
with `RYPH_BROWSER_SANDBOX`: `required` launches sandboxed or not at all (a failed launch is a
plain refusal on every tool and `closed` on the live stream, never a quiet fallback), `off` goes
straight to `--no-sandbox`. Left unset, a failed sandboxed launch logs **one** line
(`browser.sandbox_unavailable`, with Chromium's reason) and launches again with `--no-sandbox`, and
the process never tries the sandbox again. A launch that fails after Chromium started (no context,
no page) closes that Chromium. Egress goes through Playwright's `proxy` option with the run's
credentials; `localhost`, `127.0.0.1` and `::1` are always bypassed. A browser that dies is
reported `closed` on the live stream and relaunched by the next call, with the agent's init scripts
re-applied. One context, 1280×800. Dialogs are answered at once and reported: dismissed, except
"Leave site?" (`beforeunload`), which is accepted — dismissing it would keep an agent on a form it
typed into, every navigate failing.

**On docker, Chromium runs without its own sandbox**, as it does on Kubernetes when no RuntimeClass
lets the sandbox start. The container is the boundary: non-root (uid 1994 on docker), no
capabilities, no escalation, no mounts, and the agent's network namespace, so the same way out
through the egress proxy. That is the boundary that already holds the agent, which runs whatever
code it likes inside it, so a page that exploits the renderer gets about what the agent has. For
defense in depth, run where the sandbox works: gVisor on Kubernetes (`runs.runtimeClassName`),
where it is required, or `RYPH_DOCKER_RUNTIME=runsc` on docker, where it is tried first.

**No page can wedge it.** Calls run one at a time, so one call that never returns would take every
later one with it, and `<button onclick="while(true){}">` is enough to make a renderer answer
nothing. So every call into a page is bounded (Playwright's own timeouts, and 5 s on the calls it
gives none: a locator count, a key press, the wheel, a viewport change, a CDP command), each tool
call has an overall **45 s** deadline after which it is answered with an error and the queue moves
on, and a call that ended badly makes the next one **probe** the page first (a CDP
`Runtime.evaluate` of `0`, 2 s to answer). A page that stays silent has its script stopped
(`Runtime.terminateExecution`); one that is still silent — stuck in a synchronous XHR, say — is
closed and **replaced** with a blank tab in the same place. A renderer that **crashes** is replaced
the moment it does, screencast and all. Either way the next tool result opens with what happened. And a tab navigated over and over does
not hoard: Chromium keeps every old document until V8 runs a full collection, which it puts off
because it sizes its heap by the machine rather than the container (measured: 844 MiB of heap and
634 detached documents after 600 visits to a tiny page, with calls stalling for seconds), so after
each report the tab's heap is collected once it passes 64 MiB and twice what the last collection
left on the current document (a main-frame navigation resets that floor; a collection that times
out records the usage it found, so the next report does not ask again).

**Element refs are Playwright's own.** `snapshot` is `page.ariaSnapshot({ mode: "ai" })` — public
API in playwright-core 1.63, the same tree `@playwright/mcp` serves — which prints each interactive
element with a ref (`button "Save" [ref=e12]`, `f1e3` inside a frame), and the tools resolve a ref
with the `aria-ref=` selector engine, which looks it up in the last snapshot taken of that frame. So
a ref is good until the next snapshot, and every page-mutating tool answers with a fresh one. A ref
that is gone is a refusal that says to take a new snapshot, checked before the action rather than
discovered by a ten-second actionability timeout.

**Every page-mutating tool answers the same way**: what it did, then — inside one fence — the
URL, the title, the tab list (when there is more than one), dialogs and how they were answered,
console errors since the last report, and the snapshot capped at **12 KB** with the cut said
(`snapshot` itself goes to **28 KB**). The whole answer, notice and fence included, serializes
(`JSON.stringify`, escapes counted) to at most 30,000 characters, under the runner's 32,000 cap on
the whole history event, so the transcript records what the agent read. The
snapshot is the whole page, scrolled-away parts included, so a cut note never says to scroll: it
points at `snapshot`, or at `evaluate` on a ref (`(el) => el.innerText`). Before writing it the
tool lets the action land: a navigation it started reaches `load` (10 s at most), and fetches it
fired come back (2 s at most), so "click Save" answers with the saved state rather than the
spinner.

**`evaluate` takes function source** and wraps it before it goes into the page: called with the
element when a ref is given, its promise awaited, and its value serialised _inside the page_, where
a DOM node can still be described (`<button#save.primary> "Save"`) instead of arriving as `{}`. The
serialiser is bounded on every axis (depth 8, 200 items, 200 keys, 4000 chars per nested string)
before the 20 KB cap is applied, so `() => document` cannot become a ten-megabyte reply first.
**The cap is not the page's to keep**: the function, and the serialiser with it, run in the page's
main world — they must, since an isolated world shares the DOM but not the app's JavaScript state
(measured: `window.__store` is `undefined` there) — so on builtins the page may have redefined.
The serialiser's answer therefore stays in the page as a handle, and at most 20 KB + 1 characters
are pulled out of it by a function that uses only language operations (`typeof`, a string's
length and index, `+`), as one primitive string. A page that replaces `JSON.stringify` or
`String.prototype.slice` gets its 20 KB like anyone else.
**The deadline is enforced from outside the page**: `while (true) {}` holds the renderer's main
thread, so on timeout the sidecar sends CDP `Runtime.terminateExecution`, which stops the script and
frees the page for the next call (measured: a 1000 ms timeout answers in ~1005 ms, and the next
call works). The function is sent through Playwright's function path rather than as a string, so a
page whose CSP forbids `eval` does not stand in the way.

**Everything the page wrote is framed as untrusted**: one line saying it is third-party content
to be read as data, then a fence longer than any backtick run inside it, so the page cannot close
its own quote and continue in the platform's voice. The technique is the runner's `fence`
(`packages/runner/src/helpers/layout.ts`) and @ryph/web's; a title or a dialog message printed
outside the fence is flattened to one line first. A label is not enforcement — it is the
difference between a model that has been told and one that has not.

## Offline artifact thumbnails (separate deployment)

`bun run src/thumbnail.ts` runs a **different service**, not the agent sidecar. The existing
`images/browser` image accepts that command through its entrypoint; its default command remains
`src/main.ts`. The thumbnail service listens on **`0.0.0.0:7491`**, has no configure route,
credentials, database, object-store access, browser reuse, or authentication. Deploy it in its
**own isolated container/network**, allow ingress only from the thumbnail caller, deny all
outbound network (including metadata, cluster services, DNS and the public Internet), and provide
no secrets or service-account token. Never put this unauthenticated listener on a public ingress
or in an agent's network namespace. Keep container CPU/memory/PID limits and the non-root UID.
Optionally set `RYPH_THUMBNAIL_SOCKET=/run/ryph-thumbnails/render.sock` to bind only a Unix socket
instead of TCP (for example a shared socket volume with `network_mode: none`). The image seeds
`/run/ryph-thumbnails` as **1994:1994, mode 0750**; the listener socket is changed to **0660**.
Mount that directory read-write for the renderer, read-only for the caller, and give the caller
supplementary group **1994**. The read-only mount permits connecting but not changing directory
entries. No TCP listener is opened in this mode. Startup requires an absolute normalized path in
a renderer-owned directory without symlinks or group/world write permission. Only a same-owner
socket that refuses a connection is removed as stale (with its identity checked again before
unlinking); regular files, symlinks, foreign-owned sockets and active/ambiguous listeners refuse
startup instead of being replaced.

| Request | Response |
| --- | --- |
| `GET /health` | `200 ok` while running; listener opens only after a trusted startup render succeeds |
| `POST /render`, `Content-Type: text/html` (optional `charset=utf-8`) | raw `image/png`, exactly **1200 × 750**, device scale 1, viewport only, `Cache-Control: no-store` |

Before opening either listener, the service renders a tiny fixed, trusted HTML document with
its actual configured Chromium and sandbox policy, under the same **15-second deadline**,
and waits for browser cleanup. Failed launch, missing libraries/executable, or rendering failure
refuses startup with a nonzero exit and actionable, allowlisted stderr diagnostics. `/health`
therefore cannot report green before this readiness check succeeds (it is not a continuous
browser probe). Later render failures also emit bounded generic categories, never document text,
raw Playwright exceptions, paths or credentials. SIGTERM during startup aborts the self-test and
waits for cleanup. The one-shot CLI already tests readiness by doing its one requested render;
it does not perform this additional service startup render.

The body is **prepared HTML with its images already inlined**; this service does not sanitize or
rewrite it. It accepts at most **24 MiB of UTF-8 bytes**, counting chunks as they arrive rather
than trusting `Content-Length`. Invalid UTF-8 is `400`, unsupported media/charset is `415`, and
oversized input or output is `413`. PNG output is capped at **4 MiB**. Unsupported routes/methods
are `404`. One request owns admission (including body reading); concurrent jobs get **`503 busy`**,
not a queue. A **15-second deadline** includes reading the body, launching Chromium, rendering and
cleanup; expiry returns **`504`**. Other launch/render failures return a generic `500` without
leaking HTML or browser diagnostics. Admission remains occupied until browser cleanup completes,
even if a timed-out caller already has its response. Shutdown cancels the current job and waits
for cleanup before closing the listener.

Every job launches a fresh Chromium process. The renderer owns a Playwright browser server so it
can **kill/reap the browser process tree**, rather than relying on a responsive page or graceful
close. Launch itself has the remaining deadline as a Playwright timeout, which cleans up failed
launches; a browser that finishes launching after cancellation is killed before it is connected.
There is **no sandbox fallback**: unset or `RYPH_THUMBNAIL_SANDBOX=required` requires Chromium's
sandbox. `RYPH_THUMBNAIL_SANDBOX=off` is an explicit escape hatch **only for an externally isolated
runtime** whose container/kernel boundary has been reviewed (for example a dedicated gVisor
workload); other values refuse startup. `RYPH_BROWSER_SANDBOX` does not affect this renderer.
`RYPH_BROWSER_EXECUTABLE` may select a locally installed Chromium, as for the sidecar.

JavaScript, service workers and downloads are disabled. Every routable browser request is aborted
except one synthetic main-document navigation, fulfilled locally with the supplied HTML and this
**HTTP response header** (a document cannot weaken it with a meta tag):

```text
Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox
```

WebSockets are closed as well. Inline styles and data images/fonts can render; external assets,
scripts, frames and active functionality cannot. This is deliberately not a faithful screenshot
of an interactive application. Large/expensive data assets can still exhaust renderer resources:
the deadline, process isolation and deployment resource limits are part of the boundary. Request
routing is defense in depth, **not a substitute for deployment-level egress denial** (browser
background traffic is not necessarily a page request). No artifacts or previews are persisted.

`tests/thumbnail_test.ts` checks bounded admission, streamed bytes, deadlines, sandbox policy and
late-launch cleanup without Chromium. `tests/thumbnail_browser_test.ts` exercises real PNGs,
inlined images and blocked network/script behavior. The harness skips only when Chromium's
binary is missing; installed browsers with broken libraries, sandbox or runtime fail tests. Like the existing harness it explicitly disables the sandbox for
that local test only; production launch policy is covered by the unit tests.

### One-shot local Docker mode (no host sockets or ports)

`bun --no-env-file src/thumbnail_cli.ts` reads **one UTF-8 HTML document from stdin until
EOF** and writes **only the raw PNG bytes to stdout**, then exits. The image's entrypoint
accepts this command and enforces `--no-env-file` too. This mode does not start the HTTP
service or compose the interactive sidecar. It works across Docker Desktop's VM boundary:
use `docker run --rm -i --network none ... IMAGE bun --no-env-file src/thumbnail_cli.ts`,
not `-t`, port publishing, or a host Unix-socket bind mount. The caller closes stdin after
the document, collects stdout, and accepts it only if the process exits **0**. On any error
it must discard stdout (a cancelled output pipe may contain a partial PNG). Failure exits
**1** with one generic stderr line, never HTML or raw browser diagnostics.

The same renderer and streamed-input validation apply: **24 MiB** input, fatal UTF-8
decoding, **1200 × 750** PNG with **4 MiB** output cap, JavaScript/network disabled, and
sandbox **required** unless explicitly opted out under the policy above. The **15-second**
deadline begins before stdin reading and also covers stdout backpressure. Writes are
awaited in at most **64 KiB** chunks. SIGTERM/SIGINT abort input/render/output and wait for
browser-process-tree cleanup, including a launch still in progress. As with the service,
cleanup must retain ownership until Playwright finishes reaping; the caller additionally
needs a wall-clock watchdog which kills/removes the **container**, not only the local
Docker CLI process, if the runtime itself wedges. Do not forward agent credentials,
`.env` files, arbitrary host environment, browser debug settings, or workspace mounts.
Keep the image's non-root UID, resource limits, dropped capabilities and no-new-privileges.

**Sandbox caveat:** plain Docker's default seccomp profile generally prevents Chromium's
unprivileged namespace sandbox; non-root plus `--cap-drop ALL` and
`--security-opt no-new-privileges` alone does not fix it. The setuid sandbox cannot acquire
privileges under no-new-privileges either. Do **not** make local rendering work by silently
setting `RYPH_THUMBNAIL_SANDBOX=off`, adding SYS_ADMIN, using privileged mode, or disabling
seccomp wholesale. A reviewed, pinned Playwright-compatible seccomp profile permitting
user-namespace `clone`, `setns` and `unshare` is the recommended local option while keeping
Chromium sandbox required. The profile must preserve an ENOSYS fallback for `clone3` on
modern glibc; host kernel/user-namespace policy can still refuse launch. Such hosts should
fail closed (no thumbnail), or select an explicitly reviewed isolated runtime. Docker is
not installed in the coding test environment, so Docker Desktop sandbox readiness must be
verified on the actual runtime; the HTTP service now performs a real startup render before
opening its listener, so readiness failure is visible rather than a misleading green `/health`.

`tests/thumbnail_cli_test.ts` injects the renderer to cover streamed UTF-8, size limits,
backpressure, cancellation, broken pipes and cleanup without Chromium. The browser test
also exercises the CLI stream path with real Chromium, skipping only when the binary is missing.

## 📡 The live stream

`GET /live` is NDJSON, one consumer at a time (the runner's relay; a new connection replaces the
old), opening with a `snapshot` line — status, tabs, the latest frame — then a **replay** of the
newest 500 `console`, 200 `network` and 200 `action` lines in the order they happened (kept whether
or not anyone was listening, so a relay that reconnects, or a historian that restarted, refills its
room), and then `frame`, `tabs`, `console`, `network`, `action` and `status` lines as they happen. The shapes are the contract's
`LiveEvent`; frames carry `viewport` so the app can place an action's `target` rectangle on them.

The screencast is CDP `Page.startScreencast` on the **active tab only** (JPEG q60, at most
1280×800), restarted on a tab switch. Chromium sends a frame per paint and **every one is acked**
(an unacked screencast stops); what is forwarded is **at most one per 100 ms**, and a frame that
arrives inside the window is held and sent when it closes, so a burst always ends on its last frame
and a page that changes once and goes still is never left showing the state before. Frames,
`tabs` and `status` produced while nobody is listening are dropped, except the state the next
`snapshot` line needs. The replay rings are the historian's own sizes and their strings are clipped
to the stream's caps (console text and URLs 2 KB, summaries and failures 300 characters), so they
hold at most about 2.6 MB however long the run; the replay goes out as one chunk. A consumer that
stops reading gets no more frames after four queued lines and nothing at all after a thousand.

## 🦕 Runtime, measured

Bun drives Chromium through playwright-core without trouble — pipe transport, CDP sessions, the
screencast, `ariaSnapshot`, `aria-ref`, `addInitScript` and `Runtime.terminateExecution` all work;
every test here, real Chromium included (`tests/integration_test.ts`), passes under `bun test` on
macOS. The boundary that matters is the container's (uid 1994, no capabilities, no escalation) and
Chromium's sandbox: the process ran with `--allow-all` when it was a Deno process, so no runtime
permission was lost in the move to Bun.

Measured in the image when it still ran Deno (the Bun image is within a few MB of it) under docker (OrbStack, arm64, `--cap-drop ALL`, no-new-privileges, uid
1994): the image is **562 MB** on arm64 and **543 MB** on amd64 (Chromium headless shell 266 MB); the sandboxed launch fails and the
fallback logs once; launch **~100 ms** after that (the first `navigate`, launch included,
**231 ms**); **~250 MiB** for the container with one simple page open; an animating page forwards
**9.8 fps** of **~7 KB** JPEGs at 1280×800. The screencast is not free: on a page that animates
forever the container sits at **~35 % of a core** with every frame encoded and acked (~23 % at
every third frame, which the contract's "never lose the last frame" rules out).

## 🔌 Surfaces

| Route             | Auth            | What                                                                          |
| ----------------- | --------------- | ----------------------------------------------------------------------------- |
| `GET /healthz`    | none            | `200 ok` once listening                                                       |
| `POST /configure` | none, one-shot  | `{ token, proxy: { server, username?, password?, bypass? } \| null, vision? }` → `204`; again → `409` |
| `POST /mcp`       | `Bearer <token>` | MCP over streamable HTTP, stateless: initialize, ping, tools/list, tools/call |
| `GET /live`       | `Bearer <token>` | the NDJSON live stream                                                        |

`vision` (default `true`) says whether the run's model can see images. With `false` the tools
list has no `screenshot` (a call to it is refused, saying why) and no description sends the model
to one. Screenshots are held to what pi and the images extension accept: at most 2000 px on a side
(a larger region is scaled down, to half size at most, then cropped to its top-left, and the
result says so) and 3 MiB (`src/core/screenshot.ts`).

The MCP server is the one every ryph tool server shares (`@ryph/shared/mcp`): one request, one JSON
response, no sessions, batches refused. The SDK is only the tests' client.

| Variable                  | Effect                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| `RYPH_BROWSER_PORT`       | The listener, on `127.0.0.1` (default `7490`). Local development only: the orchestrator always uses 7490 |
| `RYPH_BROWSER_SANDBOX`    | `required`: sandboxed or no browser; `off`: no sandbox attempt (runc); unset: try, then fall back once |
| `RYPH_BROWSER_EXECUTABLE` | A Chromium other than Playwright's installed headless shell            |
| `RYPH_LOG_LEVEL`, `RYPH_LOG_FORMAT` | As every ryph process (@ryph/logger); logs go to stderr      |

## 🧱 Layout

`src/core/` is pure and unit-tested without a browser — framing, the configure latch, the frame
throttle, the live hub and event shaping, the evaluate wrapper and serialiser, the tool schemas and
the report text — and the guard (`bun run guard`) fails if it imports anything outside itself
or playwright-core at all. `src/adapters/chromium.ts` is the browser; `src/mcp/` the tool table and
JSON-RPC; `src/http/server.ts` the routes; `src/sidecar.ts` composes them and `src/main.ts` owns the
socket and SIGTERM (Chromium is closed before the process goes).

## ⚡ Commands

```sh
bun run install-shell    # Playwright's headless shell, by the pinned playwright-core's own CLI
bun run test             # the pure parts, the routes over the handler, and — when a headless
                         # shell is installed — real Chromium driven through the MCP SDK client
bun run dev              # the sidecar on :7490
docker build -f images/browser/Dockerfile -t ryph-browser .   # from the workspace root
```

## 🔭 The live path, end to end

`scripts/e2e_live.ts` runs the whole live path on this machine with every seam real: a page
server in an "agent" container that owns the network namespace, the image launched beside it with
the docker provisioner's own `browserArgs`, the runner's `startBrowserSidecar` (wait, configure,
relay) unmodified, the historian's live routes in process, and an SSE consumer on
`GET /v1/runs/:id/live/stream`. Only the host's two gates are stubbed. It calls the tools the way
the agent would, prints what reached the consumer (frames and their lag, actions, console,
network, `done` at conclusion), and removes both containers on the way out.

```sh
docker build -f images/browser/Dockerfile -t ryph-browser:dev .   # once, from the workspace root
bun packages/browser/scripts/e2e_live.ts                          # scripted pass: PASS or FAIL
bun packages/browser/scripts/e2e_live.ts --watch                  # until Ctrl-C
bun packages/browser/scripts/e2e_live.ts --soak 600               # the loop flat out, measured
```

The sidecar listens on loopback, which the real runner — inside the namespace — dials directly;
this script is outside it, so the agent container carries a small TCP relay (`:7491` →
`127.0.0.1:7490`) and publishes that instead.

`--watch` repeats a short type-and-click loop every few seconds (an iteration that fails is logged
and the loop goes on) and prints a URL for the app's dev page, `/dev/browser?live=<stream url>`,
where the pane shows the real stream (dev server, signed in). `--soak <n>` runs that loop n times
with no pauses and prints, every 50 iterations, the calls' latency and the browser container's
memory, CPU and process count. `--port` moves its historian off 7497, `--image` picks the image,
`--app` changes the origin in the printed URL.
