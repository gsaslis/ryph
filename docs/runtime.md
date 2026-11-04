# Runtime

The workspace runs on Bun (pinned in `mise.toml`, with the Node the artifact sanitizer needs). It
moved off Deno in October 2026; this is what that left behind: the conventions every package
follows, what Deno's permission flags enforced and what replaced each, and the Bun behaviour we
measured the hard way.

## Conventions

- **Runtime code uses `node:*` APIs and web-standard globals** (`fetch`, `Request`, `Response`,
  `URL`, `crypto.subtle`, `WebSocket`, `ReadableStream`, `TextEncoder`). **No `Bun.*` API in shipped
  code**, so Node stays a config change away: Node runs `serve`, `command` and `caFetch` unchanged.
  Build scripts (`packages/ryph/scripts/compile.ts`, `Bun.build`) are the exception.
- Three shared helpers stand where a pattern repeats: `serve` and `caFetch` in `@ryph/service`,
  `command` in `@ryph/process` (below).
- Errors are node's: `(err as NodeJS.ErrnoException)?.code === "ENOENT"`. Permission failures are
  `EACCES` **or** `EPERM`; check both.
- Node API pitfalls that bit us: `rm(p, { recursive: true })` throws on a missing path unless
  `force: true`, and `rm` without `recursive` refuses any directory; `mkdtemp(prefix)` appends the
  random part to the prefix, so pass `join(tmpdir(), "ryph-")`, never an empty prefix; `readFile`
  returns a `Buffer`, which `assertEquals` does not equal to a `Uint8Array` (wrap it);
  `networkInterfaces()` is an object keyed by name; `process.platform` says `"win32"`.
- A build-time fact is a constant baked at compile
  (`bun build --compile --define
  RYPH_STANDALONE=true`), not a runtime check.
- A process group is signalled with `process.kill(-pgid, sig)`.
- Every ryph process refuses to start under the variables `@ryph/shared/env` lists:
  `NODE_TLS_REJECT_UNAUTHORIZED` set to anything but `1` (Bun's global `fetch` honours `0`, Deno
  ignored it), any `BUN_INSPECT*` (a debugger listener, or a dial out to one),
  `BUN_CONFIG_VERBOSE_FETCH` (every request's headers on stderr, only `Authorization` redacted), and
  `BUN_OPTIONS` and `BUN_BE_BUN` (Bun bugs). Services refuse them through `refuseHostileEnvironment`
  in `@ryph/service` (run first by `refusePublicDevSecrets`; the browser sidecar calls it directly);
  `ryph`, `ryph-runner` and `ryph-bake` judge the same list with
  `hostileEnvironment`/`hostileVariables`. The runner and the baker run on a user's environment
  image, whose `ENV` reaches them, so their reasons name the image's `ENV` line and, for TLS,
  `NODE_EXTRA_CA_CERTS` as the fix. The baker's line is the environment build's failure line
  (`failureLine`). The runner posts its reason as the run's boot failure when
  `NODE_TLS_REJECT_UNAUTHORIZED` is the only refusal: it drops the variable first (Bun reads it per
  request, so `fetch` verifies again, measured compiled on 1.4.2), then redeems the bootstrap. Under
  any other the process is already changed, so it redeems nothing and the reason is only in the
  pod's log; the reaper's startup grace concludes the run. The environment skill's
  `references/dockerfile.md` tells agents to keep all of them out of an image.
- `globalThis.addEventListener("unhandledrejection", …)` is `process.on("unhandledRejection", …)`.

### Package layout

`tsconfig.json`, beside `package.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "tests"] }
```

Add `"scripts"` to `include` when the package has scripts. `tsconfig.base.json` deliberately has
**no DOM lib**: bun-types declares the web globals itself, and with the DOM lib its stream types and
node's collide. `types/web.d.ts` (pulled in by the base config's `files`) re-declares the few names
only the DOM lib had (`HeadersInit`, `BodyInit`, `ResponseInit`, `RequestInfo`,
`ReadableStreamReadResult`, `BinaryType`) and merges `json(): Promise<any>` back into `Request` and
`Response` (undici-types says `unknown`). Add to it rather than reaching for the DOM lib.

`package.json` scripts:

| Script                         | Value                                                      | Notes                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test`                         | `bun test --no-env-file --parallel --timeout 60000 tests/` | bun's default per-test timeout is 5 s; raise the number if a package needs it. `bunfig.toml`'s `[test] timeout` is not honoured. `--parallel` runs the files side by side, one worker per core, each file in a fresh global; a package's suite takes as long as its slowest file, so split a file that grows past ~20 s |
| `check`                        | `tsgo -p .`                                                | TypeScript 7 (`@typescript/native-preview`): orchestrator in 0.9 s against `tsc`'s 5.8 s, same diagnostics. `tsc -p .` (5.9) is the fallback                                                                                                                                                                            |
| `guard`                        | `bun --no-env-file scripts/check_architecture.ts`          | See Architecture guards                                                                                                                                                                                                                                                                                                 |
| `ci`                           | `bun run check && [bun run guard &&] bun run test`         | fmt and lint are root scripts (dprint, oxlint)                                                                                                                                                                                                                                                                          |
| `db:generate`, `db:migrate`, … | `bunx drizzle-kit generate` etc.                           | `drizzle-kit` as a devDependency; `bunx` runs the installed one                                                                                                                                                                                                                                                         |
| `dev`                          | `bun --env-file=.env src/main.ts`                          | An explicit `--env-file` still loads, autoload or not                                                                                                                                                                                                                                                                   |

Workspace imports (`@ryph/<pkg>`) need `"@ryph/<pkg>": "workspace:*"` in `dependencies` (or
`devDependencies` when only tests use it), then `bun install` at the root. JSR packages install
through JSR's npm registry: `"@std/assert": "npm:@jsr/std__assert@1"` (the `@jsr` scope is in
`bunfig.toml`).

Lint is oxlint (`.oxlintrc.json`); a suppression is `// oxlint-disable-next-line <rule>`, and an
unused one is an error. Format is dprint (`dprint.json`) plus `scripts/fmt-svelte-blocks.ts` for the
`<script>`/`<style>` blocks of `.svelte` files.

### `.env` autoload: off

Bun loads `.env`, `.env.local` and `.env.<NODE_ENV>` from the working directory into `process.env`
by itself. Left on, a stray `.env` in a package directory changes what its tests see, and the `ryph`
binary would read the `.env` of whatever project directory a user runs it in. So it is off:

- the root `bunfig.toml` has `env = false`. Bun reads `bunfig.toml` from the working directory only
  (not its parents), so this covers runs from the root and nothing else;
- package scripts pass `--no-env-file` (`bun test --no-env-file …`, `bun --no-env-file script.ts`);
- a dev script that wants its `.env` names it: `bun --env-file=.env src/main.ts`;
- container entrypoints: `bun --no-env-file src/main.ts`;
- `bun build --compile` must pass **`--no-compile-autoload-dotenv --no-compile-autoload-bunfig`**.
  By default a compiled binary also loads `bunfig.toml` from the user's working directory, **and
  runs its `preload` scripts**: measured on 1.4.2, a `bunfig.toml` with `preload = ["./x.ts"]` in
  the cwd ran `x.ts` inside a default-compiled binary. For `ryph`, run in arbitrary repositories,
  that is code execution from any checked-out repo. The hardened build did not run it, and every
  build of the `ryph` binary checks that (Host, the binary and the playground, below).

### HTTP: `serve` (`@ryph/service`)

**`await serve(opts, handler)`**, handler `(req: Request, info) => Response | Promise<Response>`,
options `port`, `hostname`, `signal`, `onListen`, `onError`, `keepAliveTimeoutMs`,
`headersTimeoutMs`. The returned `HttpServer` has `addr`, `finished`, `shutdown()`,
`ref()`/`unref()` and `[Symbol.asyncDispose]`. Types: `HttpServer`, `ServeHandler`,
`ServeHandlerInfo`, `NetAddr`.

- **Binding is async.** The promise resolves once listening and **rejects** with a node error
  (`EADDRINUSE`, `EADDRNOTAVAIL`, `EACCES` on `err.code`). The code is the real one: Bun's node:http
  calls every bind failure `EADDRINUSE` (Bun bugs, below), so `serve` re-asks node:net
  (`bindError`). A bare node:http server binds through `listenNode(server, port, host)` for the same
  reason.
- Default hostname `0.0.0.0` and port 8000 (node's own default is `::`). The default `onListen`
  prints a banner to stderr; pass `onListen: () => {}` to silence it.
- `info.remoteAddr` is `{ transport: "tcp", hostname, port }` of the peer.
- `req.signal` aborts when the client disconnects **and** once the response has been sent; cleanup
  hung off it runs either way.
- Request and response bodies stream with backpressure; a request body cut short **errors** the
  handler's read, and a response body that errors after its headers resets the connection (the
  client's read fails) and is reported to `onError`. `streams.ts`'s drain relies on both.
- A body that is complete by the next event-loop turn goes out with `Content-Length`; anything else
  is chunked with its headers flushed at once (SSE).
- **The real length goes out, never the handler's.** A body complete by the next turn is sent with
  its own byte count whatever `Content-Length` the handler set (Bun's `fetch` keeps an upstream's
  compressed length on the body it decompressed, so a proxy relaying it would otherwise split the
  response); a streamed body with a declared length is held to it, as `Deno.serve` held it: past it
  or short of it, the connection is cut. Hop-by-hop headers (`connection`, `keep-alive`,
  `transfer-encoding`, `upgrade`, `te`, `trailer`, `proxy-connection`) are dropped;
  `connection: close` still closes the connection. A null body goes out with `Content-Length: 0`
  (none on a 204 or 1xx); only HEAD and 304 keep the handler's.
- A body with no `Content-Type` goes out as `text/plain;charset=UTF-8`. Deno sent that for a string
  body; Bun's `Response` leaves it off and cannot tell a string body from bytes, so every untyped
  body gets it, and a browser never sniffs one as HTML.
- **A body is cancelled on every path that does not send it whole**, a client that left before the
  handler answered included (its `close` has fired by then). A source nobody cancels (a git process,
  an open file, a tail's subscription) stays forever.
- `keepAliveTimeoutMs` defaults to **620 s**, past a Google Cloud load balancer's 600 s idle reuse:
  node's 5 s default is the empty-502/503 we hit on GKE before. `headersTimeoutMs` defaults to 630 s
  but Bun ignores it (Bun bugs). No overall request timeout: an NDJSON uplink is one request for a
  whole run.
- No response compression.
- `shutdown()` stops accepting, closes idle keep-alive connections, makes in-flight responses close
  their connection, and resolves once they finish. Upgraded WebSockets are not waited on or closed:
  that is the caller's job, as `previews.ts` does. `finished` waits for them too: Bun 1.4.4's
  `server.close()` waits on upgraded sockets, as Node's does (1.4.2's did not), so `serve` counts
  the connections `shutdown()` waits on itself.

**WebSockets:** **`info.upgradeWebSocket(req, opts?)`** (the handler's second argument) returns
`{ socket, response }`; return `response` and `socket` opens. `socket` is a standard `WebSocket`
(`binaryType`, `onmessage`, `addEventListener`, `send`, `close`, `readyState`). Options: `protocol`,
`idleTimeout` (seconds between pings, default 120), `maxPayload` (default 64 MiB; a bigger message
closes the socket as its header arrives) and `refusePings` (default false: a ping from the peer
terminates the socket instead of being answered, as does a pong when `idleTimeout` is 0 and this end
sends no pings; for a peer with a heartbeat of its own, since `ws` queues a pong per ping with no
regard for its backlog). Beyond the standard, `socket.terminate()` destroys the socket at once,
whatever it has queued (`ws`'s own): a close frame would wait behind that queue. A socket its
handler closes or terminates before the handshake is refused and never opens, and ends `CLOSED` with
a `close` event and no `error`, whatever the handler then answers or throws. A handler that answers
an upgrade request with a plain `Response` refuses the upgrade with that status, streamed and
cancelled when the client goes. Only `Upgrade: websocket` with a `Sec-WebSocket-Key` is an upgrade
(`shouldUpgradeCallback`, honoured by Bun 1.4.2, 1.4.4 and Node): anything else, an `Upgrade: h2c`
POST from curl or Java's HttpClient among them, is served as a plain request, body and all.

**`ws`:** `import "ws"` under Bun gives Bun's stand-in, which **does not enforce `maxPayload`**.
Anything that relies on `ws` to refuse an oversized frame (`packages/previews` does) loads the real
package through `realWs()` from `@ryph/service` (it resolves `ws/package.json` and requires the
entry by path, which Bun does not redirect). Same API. In the compiled `ryph` there are no package
files to resolve (a lookup there would load whatever `node_modules/ws` sat above the unpacked
runtime), so the build bundles the package's entry as `ryph:ws` and `realWs()` loads only that.

### Processes: `command` (`@ryph/process`)

```ts
import { command } from "@ryph/process";

const out = await command("git", { args: ["status"], cwd, stdout: "piped" }).output();
const child = await command("pi", { args, stdin: "piped", stdout: "piped" }).spawn();
await new Response(child.stdout).text();
```

The shape `Deno.Command` had, on node:child_process: `output()` pipes stdout/stderr and inherits
stdin; `spawn()` inherits all three and is **awaited**; `stdin`/`stdout`/`stderr` are
`WritableStream`/`ReadableStream`; `status` resolves at exit; `code` is 128 + signal number for a
signalled child and `signal` its name; `clearEnv` gives the child `env` only, yet the program is
looked up on this process's PATH unless `env` has its own (relative entries skipped: checked against
this cwd, they would run from the child's); `signal: AbortSignal`, `uid`, `gid`, `detached`;
`kill()` defaults to SIGTERM and throws `TypeError` once the child has exited; a pipe that was not
piped throws `TypeError` on access; `output()`'s `stdout`/`stderr` are plain `Uint8Array`s. **A
program that cannot start rejects `spawn()`** (`code` ENOENT/EACCES). Types: `Child`,
`CommandOutput`, `CommandStatus`.

It is its own zero-dependency package, not part of `@ryph/service`, because `src/helpers/` in runner
and forge spawn git and may not import `@ryph/service`; architecture guards allow `"../process/"` in
every scope that spawns.

### Fetch with a private CA: `caFetch` (`@ryph/service`)

**`caFetch(pem)`** is a fetch-shaped function for an API server behind a private CA (the Kubernetes
clients pass it as their `doFetch`). Measured on Bun 1.4.2, against a server whose certificate a
test CA signed:

| Approach                                                             | Bun                                                     | Node  |
| -------------------------------------------------------------------- | ------------------------------------------------------- | ----- |
| global `fetch` + undici `Agent({ connect: { ca } })` as `dispatcher` | **ignored**: fails verification                         | works |
| the `undici` package's own `fetch` + that `Agent`                    | **ignored** (Bun redirects `undici` too)                | works |
| `fetch(url, { tls: { ca } })`                                        | works, but a `Bun.*`-only extension: not allowed        | n/a   |
| `node:https` `request` with `ca`                                     | **works**, and a certificate from another CA is refused | works |

So `caFetch` is built on `node:https` with `ca` and `rejectUnauthorized: true`. Its security
property: **only certificates the given CA signed are accepted**; the CA replaces the default roots
rather than adding to them (Deno's `caCerts` added), which for a cluster API server is stricter.
There is no option to turn verification off, and the tests check that another CA's certificate and
the global fetch are both refused. It handles `method`, `headers`, a string or bytes `body`,
`signal`, and streams the response; it follows no redirects (the API server sends none).

### Tests

- `bun:test` registration (`test`, `describe`, `test.skipIf(c)`, `test.skip`, `test.failing`,
  `beforeAll`, `afterAll`) with the `@std/assert` assertions (`assertEquals`, `assertRejects`, …).
- `@ryph/db/testing`'s `reusableDbSuite`: each case is a test under `describe(<suite>)`, the fixture
  closes in a file-level `afterAll`, filter with `-t`.
- Bun runs a file's tests in order, and every file in one process. `process.env` is shared, so env
  changes leak between files.
- A server in a test listens on `127.0.0.1` with port 0 explicitly; nothing stops a test from
  reaching anything else (What we lose).
- No sanitizers: a leaked timer, op or descriptor shows as a hang or cross-test noise, not a
  failure.
- A test that cannot pass on Bun stays, skipped (or `test.failing`, which turns red once Bun fixes
  it) under a `// TODO(bun):` that says why.

### Architecture guards

Every package's `scripts/check_architecture.ts` is a rules table handed to
`scripts/architecture_guard.ts`: `checkArchitecture` for fenced scopes (`src/core/`, …), and
`checkSelfContained` for the kits (`@ryph/sealed`, `@ryph/shared`), whose `src/` imports nothing
outside itself. Both build the graph with `moduleGraph(path)` from `scripts/module_graph.ts`
(`modules[]` with a file:// `specifier` and `dependencies[].code.specifier`) using the TypeScript
compiler's resolution: a workspace package resolves through its symlink to its real file under
`packages/` and is a local edge; registry packages and `node:`/`bun:` built-ins keep their specifier
and are not walked; an import that resolves to nothing is reported as written. When changing a
guard, check it still fails: add a forbidden import, run it, take it out.

### Typing (bun-types)

- bun-types' `typeof fetch` carries a `preconnect` member, so a test's fake no longer satisfies it.
  Cast through `unknown`: `(() => Promise.reject(new Error("…"))) as unknown as typeof fetch`
  (parenthesise the arrow, or the cast lands on its body).
- bun-types' `Request` constructor has separate overloads for `string` and `Request` and none for
  `URL`: write
  `input instanceof Request ? new Request(input, init) : new Request(String(input),
  init)`.
- `RequestRedirect` is a DOM-lib name: `Request["redirect"]`.
- `req.clone()` returns undici's own `Request` class, which the `json()` merge in `types/web.d.ts`
  does not reach: cast that one result.
- A web `Worker` module declares the members of `self` it uses
  (`declare const self: { onmessage: …; postMessage(m): void }`); there is no worker lib. Bun runs
  `new Worker(new URL("./w.ts", import.meta.url), { type: "module" })`.
- An npm package with no declaration file (nodemailer, turndown, turndown-plugin-gfm) is TS7016: put
  `// @ts-expect-error: <pkg> ships no declaration file.` on the import. It holds in every program
  that type-checks the file (a consumer's too), where a package-local `declare module` would not.

## Runtime-only dependencies (memory's embeddings)

`@ryph/memory` loads `@huggingface/transformers` (onnxruntime-node's native addon, sharp) through a
non-literal `import(specifier)`, so it is in no package.json or lockfile. Measured on Bun 1.4.2:

- the specifier is the bare `@huggingface/transformers`, and the loader refuses any runtime whose
  `env.version` is not the pinned `TRANSFORMERS_VERSION`;
- a bare `pkg@version` auto-installs only where no `node_modules` exists up the tree, so never in
  the workspace. A developer installs it with
  `cd packages/memory && bun add --no-save --exact @huggingface/transformers@3.8.1` (package.json
  and bun.lock untouched); the image does the equivalent before `scripts/fetch_model.ts`;
- the native addon loads and embeds, in-process and in the `Worker`, and `fetch_model.ts` verifies
  the four recorded digests;
- `bun build --compile` leaves the non-literal import out of the bundle and the compiled binary does
  not resolve it at run time, from any cwd, and does not auto-install it. So the binary carries its
  own copy and imports it by file URL (`LocalEmbedderOptions.runtime`):
  `packages/ryph/scripts/embeddings.ts` installs `images/memory/embeddings/` (same lockfile as the
  image) into a temp dir, bundles transformers into one module for `node` (`sharp` stubbed; the
  onnxruntime-node addon required from beside the bundle), and packs it with the TARGET platform's
  `onnxruntime_binding.node` and the one library it links (`libonnxruntime.1.21.0.dylib`, found by
  `@loader_path`; `libonnxruntime.so.1`, found by `$ORIGIN`) and the four weight files at the pinned
  revision, each checked against `LOCAL_EMBEDDING_FILES` (cached in
  `node_modules/.cache/ryph-embeddings`). Embeddings are on by default in the binary
  (`RYPH_MEMORY_EMBEDDINGS=local`), load on the first write or search on memory's worker, and a load
  that fails is warned once and leaves search on full-text.
- Chosen over onnxruntime-web's WASM backend (11 MB of WASM, no native code), which transformers
  3.8.1 does not drive outside a browser without patching: its node build only knows
  onnxruntime-node, and handing it onnxruntime-web through `Symbol.for("onnxruntime")` leaves it no
  supported device. The native path measured on darwin-arm64: the bundled runtime's vectors match
  the image's path (`@huggingface/transformers` over onnxruntime-node from `node_modules`) at cosine
  1.000000 on five texts; load about 1 s cold and 0.1 s warm; 1.4 ms a text on the worker; +150 to
  +180 MB resident once loaded (526 → 704 MB for a whole `ryph up`); the same query's relevance
  agrees to six digits on darwin-arm64, darwin-x64 (Rosetta), linux-arm64 and linux-x64 (emulated,
  in Docker).

## Compiled binaries

Every `bun build --compile` passes `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`
(`.env` autoload, above).

- **The runner:** `bun run compile` in `packages/runner` builds `src/main.ts` → `ryph-runner` and
  `src/bake.ts` → `ryph-bake`, about 63 MB each on darwin-arm64 and 81 MB on amd64. A debug echo run
  of the compiled binary (clone, ssh-keygen, commit, push, result on stdout) exits 0.
- **The `ryph` binary's files.** In a compiled binary every bundled module's `import.meta.url` is
  the binary's entry (`file:///$bunfs/root/<outfile>`), so every
  `new URL("../../../skills", import.meta.url)` in the workspace (and PGlite's
  `new URL("./pglite.wasm", import.meta.url)`, and the workers' URLs) points nowhere.
  `packages/ryph/scripts/compile.ts` packs those files (the built UI without source maps, every
  migration set, the MCP and service catalogues, the skills, PGlite's `pglite.wasm` and
  `pglite.data`, the three workers, each bundled on its own, and memory's embeddings runtime and
  weights for the target, above) into one gzipped archive embedded with `with { type: "file" }`, and
  a `Bun.build` plugin rewrites `import.meta.url` in every workspace module (and PGlite's) to that
  module's path in the archive's tree, which mirrors the repository. `src/resources.ts` unpacks it
  once into `~/.ryph/runtime/<id>` (every boot removes other builds' ids, except one a live process
  has registered in `runtime/.in-use/<id>.<pid>.<token>` before looking for its copy, so an upgrade
  or a second build never pulls files from under a running `ryph up`; a dead pid's registration is
  cleared, a reused pid only keeps a copy longer), checked against its digests as it is written and
  **again at every boot** (a copy that does not match is unpacked again; about 100 ms for its 118
  MB), sealed read-only (files 0444, directories 0555: `rm -rf ~/.ryph` needs a `chmod -R u+w`
  first), under a directory that must be this user's own, not a link and writable by nobody else
  (which is what makes the temp-dir fallback for a user with no home safe). So workers, `readdir` of
  the migrations, the UI's dynamic `import()` and its static files all see real files, from the same
  code a source run uses. `tests/binary_test.ts` builds a probe entry the same way and checks the
  converter's worker, the migrations, the UI, PGlite and the sanitizer from inside it.
- Every build of the `ryph` binary runs it once in a directory holding a `bunfig.toml` with a
  `preload` and a `.env` that would move `RYPH_HOME`, and fails if either was read. Checked to fail
  with either `autoload` option turned back on. It then runs it under `BUN_OPTIONS`,
  `NODE_TLS_REJECT_UNAUTHORIZED=0`, `BUN_INSPECT` and `BUN_CONFIG_VERBOSE_FETCH`, and fails unless
  it refused to start under each.
- The artifact sanitizer in the binary runs **confined** when a Node 25 or later is on PATH (or
  named in `RYPH_ARTIFACT_SANITIZER_NODE`), as a source run does: the archive carries its three
  modules as source and parse5 and entities under `node_modules/`, and node is granted the unpacked
  copies (the runtime directory is returned by its real path, since node resolves every directory
  above the module it runs). With no such node it is the binary itself (`__artifact-sanitizer`),
  unconfined; the host passes `onUnconfined`, so `ryph up` says so once at boot. That one starts
  with an empty environment, so the control plane names its runtime directory as the argument after
  the subcommand, and the sanitizer only checks that copy: it never unpacks, prunes or looks for a
  home of its own. (It used to fall back to the account's home, so a binary run under a temporary
  HOME, as `tests/binary_test.ts` does, unpacked into the real `~/.ryph/runtime` and pruned the copy
  a running `ryph up` was using.) With neither RYPH_HOME nor HOME set, the runtime copies go to the
  temp dir, never the account's home.
- **Numbers** (darwin-arm64): `dist/ryph` 115 MB with memory's embeddings, 82 MB without (Deno's,
  built 2026-10-08, without: 175 MB); linux-x64 132 MB (100 without), linux-arm64 131 (100),
  darwin-x64 123 (89), all from one machine with `--target=bun-<os>-<arch>`, and both linux ones run
  `ryph up` and an embedded memory search in debian:bookworm-slim. `ryph --version` 0.24 s warm,
  with the digest check (0.20 s without the embeddings; Deno 0.24 s), and 0.71 s on a fresh home
  (0.52 s without); `ryph up` on a fresh home to a healthy control plane and UI 1.3 s (Deno 1.9 s),
  warm 0.29 s (Deno 0.49 s). The build itself: about 3 s after the UI (the first also fetches the 34
  MB of weights).

## Images (images/, deploy/compose-networked, deploy/helm)

- **Base:** `oven/bun:1.4.4-slim`, pinned by digest (Debian trixie, 70 MB smaller than
  `oven/bun:1.4.4`). Every service runs `bun --no-env-file src/main.ts`; the radicle bridge adds
  `--no-install` (it has no egress, so a missing package must fail at once, not try a registry).
- **Install:** `COPY --parents packages/*/package.json ./` then
  `bun install --frozen-lockfile --production --filter @ryph/<pkg>`, as root, before `USER`. bun
  wants on disk every workspace a filtered package names, **devDependencies and their own workspace
  deps included** ("depends on workspace … which is listed in bun.lock but not on disk"), so every
  manifest is copied and only the service's production closure is installed. `.dockerignore` allows
  `packages/*/package.json`.
- **No world-writable files:** bun leaves some bin targets 0777 (esbuild, drizzle-kit's `bin.cjs`,
  tsx's cli, node-which), writable by the service uid under a root-owned tree. Every image runs
  `chmod -R go-w /app /opt /root` before `USER`, and its build fails if `find / -xdev -perm -0002`
  (sticky directories aside) still finds anything.
- **PATH:** every image drops the base's `/usr/local/bun-node-fallback-bin`, whose `node` is bun.
- **Read-only root:** compose runs every bun service `read_only` with a `/tmp` tmpfs, and k8s sets
  `readOnlyRootFilesystem` with a `/tmp` emptyDir; what a service writes goes to its volume.
- **Migrations:** `bun --no-env-file node_modules/drizzle-kit/bin.cjs migrate` (drizzle-kit is each
  owner's dependency), never `bunx`, which downloads the latest drizzle-kit when it finds no local
  one (measured from `/tmp` in an image), after `bun --no-env-file scripts/ensure_database.ts` where
  there is one. Health checks:
  `bun --no-env-file -e "fetch(…).then((r) => process.exit(r.ok ? 0 : 1), …)"`.
- **memory's embeddings runtime:** `bun add --no-save` inside the workspace refuses ("Workspace not
  found") when the other members are not on disk, so the image installs
  `@huggingface/transformers@3.8.1` as a project of its own under `/opt/embeddings`, from its own
  lockfile (`images/memory/embeddings/`, `--frozen-lockfile`), and symlinks it into
  `packages/memory/node_modules`, then runs `fetch_model.ts` (digests checked, warm-up run).
- **harness:** the runner and baker are compiled inside the target platform's stage; the manifests
  are copied one by one, not by glob, so the paths the layer depends on can be read off the
  Dockerfile.
- **control plane:** Node 26's binary copied from `node:26-trixie-slim` (pinned) to
  `/opt/node/bin/node`, plus `libatomic1`, which it links and the bun base lacks (without it the
  sanitizer refuses every publish with the loader error, as designed).
  `RYPH_ARTIFACT_SANITIZER_NODE=/opt/node/bin/node`, `RYPH_ARTIFACT_SANITIZER_CONFINED=required`.
  The sanitizer supervisor runs in a container of its own from the same image (`/sanitizer.sh`), as
  uid 1995 (`sanitizer`): node's permission model does not gate `process.kill`, and a sanitizer
  sharing the control plane's uid could SIGKILL or SIGSTOP it (measured). k8s: a native sidecar
  (`initContainers`, `restartPolicy: Always`); compose: the `sanitizer` service. The socket is on a
  shared volume (the control plane mounts it read-only); the supervisor opens it 0600 in a 0700
  directory, and once it listens `sanitizer.sh` opens both to the `sanitizer` group (0660, 0750),
  which the control plane's uid is in (`supplementalGroups: [1995]` on k8s, where it runs as 1994).
  From the sanitizer's uid with a shared PID namespace, `kill` on the control plane is `EPERM`;
  without one (both deployments) it cannot see it at all. The control-plane entrypoint refuses to
  start without `RYPH_ARTIFACT_SANITIZER_SOCKET`, so it never starts sanitizers itself.
- **egress-proxy, run-gate, tool-guard:** `main.ts` on `gcr.io/distroless/nodejs26-debian13` under
  `node --permission --allow-net` (What we lose).
- **app:** the build stage is `bun install --frozen-lockfile --filter @ryph/app` (not
  `--production`: every app package is a devDependency vite bundles) and `bun run build`; the
  runtime stage is `node:26-slim`.
- **Sizes** (`docker images`, arm64, Deno image → Bun image): model-proxy 440 → 420 MB, historian
  436 → 420, automations 437 → 420, chat 475 → 456, mcp-gateway 481 → 456, forge 608 → 566, memory
  1.09 GB → 1.07 GB, radicle 683 → 643, web 308 → 313, previews 283 → 288, browser 802 → 797,
  harness 270 → 270, app 401 → 432 (its runtime stage moved from node 22 to 26), control-plane 538 →
  699 (the Node 26 binary for the sanitizer, about 120 MB, and libatomic); egress-proxy, run-gate,
  tool-guard 195 → 254 (Node distroless).

## Host and the playground

- **WebSocket upgrades through the router.** A route sees only the request, so the host's
  `acceptingUpgrades(handler)` (packages/host/src/previews.ts) records each request's
  `ServeHandlerInfo` in a WeakMap, outermost around the control plane's handler, and the preview
  tunnel route upgrades with it.
- The host's bind policy reads the bind error's code to tell a docker bridge that is not up yet
  (wait for it) from a port another process holds (fail); `serve` and `listenNode` give it the real
  code.
- **The runner's uplink has no private connection pool.** Deno's `createHttpClient({})` kept a
  historian that answered early (503, 410) without reading the streamed body from leaving the upload
  stalled on a pooled connection. Measured on Bun 1.4.2 and Node 24: global `fetch` closes a
  connection whose response arrived before its streamed request body ended, so the global pool
  cannot hold one. `background_channels_test.ts` pins it.
- `bun run playground` runs the CLI's source with `process.execPath`
  (`bun --no-env-file src/main.ts up`) and the app's `dev` script; its fixture repos stay a Deno
  project (`acme-api`), which is data the stories edit, not code that runs here.

## Bun bugs and surprises (1.4.2, re-measured on 1.4.4)

The repo moved from Bun 1.4.2 to 1.4.4 for its security fixes. 1.4.3 rewrote much of node:http's
server side; each claim below says which versions it was measured on.

- **Fixed in 1.4.3: a WebSocket upgrade on a reused keep-alive connection lost every write** from
  the server on 1.4.2 (the 101 never reached the client; reads still worked). `serve_test.ts` keeps
  it as a plain test now, and the tests that dialled upgrades with `agent: false` for it no longer
  do.
- `import "ws"` is a stand-in that ignores `maxPayload` (above). `import "undici"` is redirected
  too.
- **Fixed in 1.4.3: `pause()` on a node:http-upgraded socket did not stop reads.** On 1.4.2 Bun kept
  reading at line rate into the paused socket's buffer: measured, 2.6 GB of `readableLength` 300 ms
  after a raw `socket.pause()`, and 6–8 GB in 1.5 s behind `ws`'s `pause()`; `pipe()` from an
  upgraded socket pauses it, so `proxyUpgrade` read a browser's WebSocket uploads past what the
  runner acks without bound (5.4 GB in 0.5 s). On 1.4.4 the socket stops at a read or two
  (`front_test.ts`, a plain test now). The previews tunnel path never relied on TCP backpressure
  anyway: `ws` parses each read whole as it arrives (`allowSynchronousEvents`), the mux decides each
  message as it comes and the first refused one terminates the tunnel, and acks, not reads, hold a
  runner back (`@ryph/tunnel`'s pace). Measured on 1.4.2 with runners flooding 64 KiB frames at line
  rate (valid until their late credit or pace ran out, then refused; frames for streams never
  opened; 64 KiB text messages that parse as nothing), one tunnel or sixteen, the host's event loop
  idle or 80% busy: the socket's `readableLength` was 0 at every message, `ws` held at most one read
  (512 KiB) unparsed, and every tunnel was cut at its first refused message
  (`previews/tests/service_test.ts` holds a flood to under 64 MiB written before the cut; it was 2
  MiB). **`frontHttpServer(server)`** (`@ryph/service`) was the fix: it accepts on
  `net.createServer` and hands each socket to the node:http server with an emitted `connection`;
  every listener whose upgraded sockets are piped or paused uses it (the previews service's public
  and peer listeners, the local binary's preview listeners). It stays on 1.4.4 for what it still
  adds over Bun's own accepting: a first-request deadline of its own, TCP keepalive (below), and an
  upgraded socket closed by its client's FIN (below). Bun's own accepting passes the rest of
  `front_test.ts` on 1.4.4, so keeping it is a choice, not a fix. Client sockets (`net.connect`,
  `http.request`'s, upgraded or not) pause as they should.
- **An emitted socket (`emit("connection", socket)`) gets less from Bun's node:http** than one it
  accepted, made up for by `frontHttpServer`: a request body is pushed into `req` whatever
  `req.pause()` says (measured on 1.4.2, 2.5 GB in 250 ms behind a pipe that does not drain; on
  1.4.4, 96 MiB in 30 ms), and there is no `maxConnections`, no `keepAliveTimeout`, no deadline for
  a first request's headers, and `closeIdleConnections()` does not close one that has served a
  request (1.4.2 and 1.4.4). Fixed in 1.4.3, and no longer made up for: a response's `drain` came at
  once whatever the socket held (3.8 GB queued in 1.5 s to a client that does not read), a request
  whose connection closed first had no `aborted`, and a request whose bytes arrived before the
  previous response on its connection had ended was never processed, its connection lost
  (`front_test.ts` pipelines four). The front costs about 6 µs a request on one keep-alive
  connection (38–41 µs against 44–47 µs, Bun's `fetch` on loopback) and 2–3 µs at eight at once
  (measured on 1.4.2).
- **A paused socket never sees its client's FIN** while bytes it has not read sit in its kernel
  buffer (an upload waiting unread): no `end`, no `close`, for good (measured on 1.4.2 and 1.4.4,
  accepted or emitted alike). A reset is seen. `frontHttpServer` turns on TCP keepalive (a probe
  after 60 s silent), which a client's kernel answers with a reset once it has forgotten the
  connection (FIN_WAIT_2): closed a minute or two after the client's kernel lets go (measured on
  macOS, `front_keepalive_test.ts`, run with `RYPH_SLOW_TESTS=1`). An abandoned upload behind a zero
  window can take longer: the client's FIN waits behind its unsent data, and its zero-window probes
  keep resetting the keepalive's idle timer. In GKE the peer is the load balancer's proxy.
- **A node:http-upgraded socket stays half-open on its client's FIN** on 1.4.4, as Node's does:
  `end` and no `close`, even when the client destroyed its socket (1.4.2 closed it). Whatever holds
  one ends it itself: `serve` destroys an upgrade's socket whose client hangs up before its
  handshake is answered (`ws` ends it after), `proxyUpgrade` closes on `end`, and a fronted
  listener's sockets are not half-open at all.
- **`server.close()` waits on more on 1.4.4**, as Node's does: on keep-alive connections that were
  busy when it was called and sit idle after, and on upgraded sockets, which `closeAllConnections()`
  no longer destroys either (1.4.2 waited on neither). `serve` closes each connection whose response
  ends after its `shutdown()` began, and counts the connections `shutdown()` waits on itself,
  without upgraded ones. A test's fixture server that keeps an upgraded socket must destroy it
  before its close calls back.
- **Fixed in 1.4.3: `resetAndDestroy()` did nothing on a socket Bun's node:http accepted itself**
  (no reset, not even a close; measured on 1.4.2): it reset only sockets node:net accepted or
  dialled. On 1.4.4 it resets a request's socket and an upgraded one alike
  (`tunnel/tests/reset_test.ts`). `reset()` (`@ryph/tunnel`) still destroys a socket the reset left
  open. It matters because **a socket closed gracefully keeps what it had not sent**: one whose
  client stopped reading sits in FIN_WAIT1 with up to its send buffer (128 KiB in a pod) for as long
  as the client answers window probes, charged to the process's cgroup and to no connection count
  (measured on kind: 8–9 MiB for 64 shed downloads, repeated waves adding up until an upload burst
  OOM-killed the pod; reproduced on macOS loopback in `tunnel/tests/reset_test.ts`). So every cut
  the proxy makes of an exchange still under way is a reset (`proxyHttp`, `proxyUpgrade`, a relay's
  charge, a drain's cut); a finished response still ends gracefully. A reset can be lost on the way
  to a client whose window it fell outside (seen on macOS loopback: RSTs are not retransmitted); the
  server's kernel lets go either way, and answers the client's next segment with another.
- **A request body answered early: 1.4.2 dropped the rest of it, whatever its size.** A response
  ended before its request's body was in made the request `end` early, and Bun discarded the rest of
  the body itself: `proxyHttp`'s drain saw a 2 MiB upload answered 413 end at once with nothing
  read, and a fronted listener took all of a 64 MiB upload refused 503, its connection kept. 1.4.3
  fixed it: the rest comes to the handler, and if nobody reads it Bun reads it to its end. So the
  drain (`DRAIN_LIMIT`, 1 MiB, then a reset) bounds an early-answered upload only from 1.4.3 on;
  `host/tests/previews_test.ts` has one larger than it cut. An early answer that says
  `connection: close` is worse on 1.4.4: Bun closes the socket at once with the upload unread, the
  kernel sends a reset, and a client still uploading can lose the answer with it (measured: a 413
  sent 20 ms into a 64 MiB upload was never read).
- **`req.pause()` does not keep the first read out of `req`** on 1.4.4: what came of a body in the
  read its headers did (up to 512 KiB on loopback, the read buffer's size) sits in
  `req.readableLength` whatever `pause()` says, as without it; 1.4.2 held it where `readableLength`
  did not show it. No more is read until the body is resumed. `proxyHttp` counts it as what a paused
  body holds.
- **node:http's server writes past a declared `Content-Length`** as asked (measured on 1.4.2 and
  1.4.4), so on a connection a load balancer reuses the excess would be read as a response of its
  own. `proxyHttp` never asks (node:http's client hands on no more body than its response's length,
  and refuses a response with both lengths, or two), and cuts a response with its connection before
  its body would run past the length it sent (`proxy_test.ts`).
- `fetch` ignores an undici `dispatcher` (above).
- `headersTimeout` is ignored; Bun applies 12 s of its own to a connection's first request, measured
  on 1.4.2 and 1.4.4.
- **`fetch` has an idle timeout** (300 s, `BUN_CONFIG_HTTP_IDLE_TIMEOUT`, firing at 360 s on its
  coarse tick) that only bytes coming DOWN reset: a streamed upload answered when it ends is cut
  however much it sends, and so is a response that is silent before its headers or between chunks.
  Deno's fetch had none. The rule: **a long-lived fetch passes `timeout: false` (cast
  `as RequestInit`; Node ignores it) and an explicit bound** of its own, an `AbortSignal` deadline
  or the caller's lifetime. Where it applies: the runner's live feeds (`tests/live_idle_test.ts`),
  the model proxy's upstream call (`tests/silent_upstream_test.ts`), the MCP gateway's upstream
  dial, and the check-bundle upload on every hop (`ryph checks`, the app's `/api` proxy, the control
  plane to the forge). A fetch with a deadline under 300 s, or one whose stream carries keepalives
  (the historian's and task tails' SSE), needs nothing.
- A compiled binary autoloads `bunfig.toml` (and its `preload` scripts) and `.env` from the cwd
  unless built with `--no-compile-autoload-bunfig --no-compile-autoload-dotenv`.
- **A compiled binary honours `BUN_OPTIONS`** (a `--preload` runs before its entry) and
  **`BUN_BE_BUN=1`** (it becomes the `bun` CLI, reading the cwd's `bunfig.toml`; its entry never
  runs). No build option turns either off. A compiled binary and a source run also honour
  `BUN_INSPECT` (and `BUN_INSPECT_CONNECT_TO`, `_PRELOAD`, `_NOTIFY`: a debugger listener, or a dial
  out to one) and `BUN_CONFIG_VERBOSE_FETCH` (request headers on stderr; `Authorization` is
  redacted, `x-api-key` and `PRIVATE-TOKEN` are not). The entries refuse to start under them, which
  stops the program, not a preload that already ran: whoever sets a ryph process's environment is
  trusted, as with `LD_PRELOAD`.
- `bunfig.toml` is read from the working directory only, never a parent.
- `[test] timeout` in `bunfig.toml` is not honoured; pass `--timeout`.
- `fetch` with a streamed request body has already closed that stream once the response is in:
  closing it again from the producer throws `ERR_INVALID_STATE` (Deno left it open).
- `child_process.spawn` of a missing program: no synchronous throw, `pid` undefined, then `error`
  (as Node). `@ryph/process` turns that into a rejected `spawn()`.
- `process.env` is mutable and shared across test files, as `Deno.env` was.
- A `command()` child's `stdin` (node's `Writable.toWeb`) errors as soon as the child exits, so
  `src.pipeTo(child.stdin)` settles then even while `src` is still waiting for its next chunk.
  Deno's stdin only failed on the next write, so the pipe waited on the source. The git door's
  upload-pack pump finishes earlier for it; radicle's lock test now keeps upload-pack reading half a
  pkt-line instead of sending a flush it exits on.
- **A fetched response with an empty body `.json()`s to `null`** instead of rejecting (Node and Deno
  throw `SyntaxError`). `await res.json().catch(() => ({}))` then yields `null`, and the next
  `body.message` throws a TypeError. Write `(await res.json().catch(() => null)) ?? {}`. Found in
  forge's GitHub adapter, where a refused off-origin redirect (an empty 307) read as a crash.
- **A `req.clone()` taken in a handler stalls when read after the handler returned** without having
  read the original (Node reads it fine). Read the clone's bytes inside the handler.
- bun-types lacks `ReadableStream.from` and the `cancel` member of `Transformer`; both work at
  runtime. `new ReadableStream({ start: (c) => c.close() })` is the empty stream.
- **node:http reports every bind failure as `EADDRINUSE`**
  (`Failed to start server. Is port N in
  use?`, errno 0), an address no interface has included;
  node:net says `EADDRNOTAVAIL`. `serve` and `listenNode` (`@ryph/service`) retry a failed bind once
  on node:net to learn the real reason.
- `npm:` specifiers do not resolve under Bun (a runtime `import("npm:…")` fails).
- **A `FileHandle` collected while open is an error, not a leak.** Bun (as recent Node) throws
  `A FileHandle object was closed during garbage collection` from the GC, which fails whatever test
  is running; a service reports it as uncaught and later exits 1 (Node crashes at once). Every
  long-lived handle needs a close on every path, including a bound that gives up on the work that
  would have closed it (the runner's background logs: `close()` closes them after its bound).
  Short-lived reads close in a `finally`.
- **Workers in a compiled binary.** Every bundled module's `import.meta.url` is the binary's entry
  (`file:///$bunfs/root/<outfile>`), and an extra entrypoint lands at its path relative to the
  common root of all entrypoints, so `new Worker(new URL("./w.ts", import.meta.url))` misses (with
  or without the worker as an extra entrypoint, for node:worker_threads and web `Worker` alike). The
  `ryph` build rewrites `import.meta.url` instead (Compiled binaries).
- **A compiled binary resolves a bare import from a file on disk without the `node` or `import`
  export conditions.** A package with only `main` resolves; `@huggingface/transformers` (`node` and
  `default`, where `default` names a file the package also ships under the web build) and
  `onnxruntime-common` (`import` and `require` only) are "not found", from a worker or the main
  thread. Bundle such a dependency at build time rather than packing its `node_modules`.
- **`process.exit` with a live worker that loaded onnxruntime-node's addon aborts** ("panic: A C++
  exception occurred", exit 134, on darwin-arm64), and so does terminating it and exiting at once.
  Wait for the worker's `close` event after `terminate()`: `workerEmbedder().close()` resolves on
  it, and the host awaits it before its exit. A natural exit with no worker is clean.
- **`compile.assets` cannot stream:** `readFileSync`, `readdirSync`, `statSync`, `import()` and
  `new Worker()` work on an asset under `/$bunfs/root`, but **`createReadStream` fails with
  ENOENT**, and `openSync` + `readSync` on an embedded file fail the same way. The UI's static files
  are served with `createReadStream`, which is why the binary unpacks its archive instead.
- **Bundler: CommonJS side-effect imports run late.** Inside a lazily initialised module (anything
  under a dynamic `import()`, as the CLI's whole graph is), Bun 1.4.2 runs the ESM imports'
  initialisers before the CommonJS `require`s, whatever the source order. @peculiar/x509 imports the
  CommonJS `reflect-metadata` polyfill and then tsyringe, which throws at load without it: the
  binary died at boot. The build plugin runs the polyfill at the top of tsyringe's entry.
- Worker `resourceLimits` are ignored (the sanitizer's unconfined fallback watches its own RSS).
- A node:worker_threads worker has no `location` global; a web `Worker`'s is its module's file: URL.
- `bun run <name>` with no such script in `package.json` runs a program of that name from `PATH`,
  `--if-present` or not: `bun run test` in a member without a test script ran `/bin/test` and
  exited 1. `.ryph/each.ts` runs only the scripts a member defines.

## What we lose

Deno's permission flags were security controls in several places. Bun has no permission model, so
each got a replacement or is an accepted gap. Rows marked "needs review" are still open:

| Where                                                                                                                                                                                                             | What the flags enforced                                                                                                                                                                                                                                                            | Gone under Bun                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orchestrator` artifact sanitizer (`artifact_html/`, `images/control-plane/sanitizer.sh`)                                                                                                                         | The process parsing **untrusted HTML** revoked every permission (`Deno.permissions.revokeSync`) before reading stdin; the supervisor ran with `--allow-run=<deno>`, read/write only its socket dir, `--allow-net=unix:<socket>`, and the control plane had no `--allow-run` at all | **Replaced where a Node ≥ 25 is present:** the sanitizer runs as `node --permission --allow-fs-read=<its 3 modules + parse5/entities, symlink and real paths> --max-old-space-size=<heap>` (no write, net, child, worker, addon, WASI, inspector), with an empty env in an empty temp cwd, and proves it before reading stdin (`process.permission.has` per scope, plus `process.execArgv` holds only those flags and no `NODE_OPTIONS`: `has("fs.write")` says false for `--allow-fs-write=/`, measured on 25.9). The node is `RYPH_ARTIFACT_SANITIZER_NODE` (then mandatory: a bad one refuses publishes) or the first on PATH, probed once at boot. Heap cap is `--max-old-space-size` (no worker). **Accepted gap — needs review:** with no such node it runs unconfined as the runtime itself (empty env/cwd, same time budget; heap via the child's own RSS watch, since Bun ignores worker `resourceLimits`), logged once at boot, or refused as unavailable under `RYPH_ARTIFACT_SANITIZER_CONFINED=required` (an empty `RYPH_ARTIFACT_SANITIZER_NODE` is unavailable too, never "find one on PATH"); each `--allow-fs-read` the child is given must be one of its modules or a parse5/entities directory. The compiled `ryph` confines it the same way under a Node ≥ 25 on PATH. The image must ship Node ≥ 25 and set `RYPH_ARTIFACT_SANITIZER_NODE`; the supervisor's split from the control plane no longer guards a run permission, only keeps the secrets out of the process that starts sanitizers |
| `images/harness` runner (`deno compile … --allow-run=git,ssh-keygen,bash,/opt/ryph/bin/pi --allow-sys=hostname,uid,gid`)                                                                                          | The runner, sharing a container with the agent, could spawn only those four programs; `runner/tests/fixtures/runner_permissions.ts` tests ran under the same flags                                                                                                                 | Defense in depth only (the agent can already run anything in that container), but the tests that asserted the runner cannot spawn other programs lose their meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `images/run-gate`, `images/tool-guard` (`--allow-net` [+ `--allow-env`] only)                                                                                                                                     | Network-only binaries: no fs read, no spawn                                                                                                                                                                                                                                        | **Kept, under Node instead of Bun:** each image is its `main.ts` on `gcr.io/distroless/nodejs26-debian13`, run as `node --permission --allow-net` (no fs read or write, no child process, worker, addon or WASI; network only, measured on 26.11: `readFileSync`, `writeFileSync` and `spawnSync` throw `ERR_ACCESS_DENIED`, and without `--allow-net` even DNS and `listen` do). Node does not gate env. Chosen over a `bun build --compile` binary, which would run with every right of uid 65534: 254 MB against 173 MB per image, for the Deno posture back. Node's model is documented as not a sandbox against malicious code (symlinks, the runtime itself); it is the same class of defence-in-depth Deno's flags were                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `images/egress-proxy` (`--allow-net --allow-env --allow-sys=networkInterfaces`)                                                                                                                                   | No fs, no spawn                                                                                                                                                                                                                                                                    | **Kept,** as the row above: `node --permission --allow-net`. Node does not gate `os.networkInterfaces()`, so the own-address check needs no grant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| control-plane runtime (no `--allow-run`)                                                                                                                                                                          | The control plane could not spawn anything, so a docker provisioner could not be enabled there by mistake                                                                                                                                                                          | Gap; the image carries no docker CLI and the docker provisioner's own config check is all that is left. The control plane runs under bun with every right of its uid; the supervisor runs in its own container as uid 1995, and the sanitizer itself is confined by Node (the sanitizer row). The supervisor's HOME is a root-owned empty dir. Bun 1.4.2 and 1.4.4 read `bunfig.toml` (and run its `preload`) only from the working directory, measured for `bun <file>` and `bun -e`, never `~/.bunfig.toml`; every image's working directory is root-owned, which is what keeps a `preload` out                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `images/model-proxy`, `images/historian`, `images/automations`, `images/chat`, `images/web`, `images/previews` (`--allow-net --allow-env --allow-read`, some `--allow-write`, `--allow-sys`; never `--allow-run`) | No spawn. The model proxy holds every unsealed provider key in memory, so a dependency that ran a program there was refused; web and previews could not write either                                                                                                               | Gap. What is left: `/app` (source and `node_modules`) is installed and copied as root and read-only to the service uid, which Deno's images only had for the source (their npm stores were writable), so a write bug still cannot plant code for the next boot. A minimal runtime image (no shell) is the next step if spawn matters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `images/mcp-gateway` entrypoint (no `--allow-run`, `--allow-sys=homedir` only)                                                                                                                                    | The master-key-holding gateway could not spawn anything, so the docker / Apple container tool host could not run in that image even if `RYPH_TOOL_HOST` named it                                                                                                                   | Gap; `RYPH_TOOL_HOST` (unset by default, `kubernetes` on GKE) is all that is left. The docker tool host's `cli()` now spawns through `@ryph/process` with nothing in the way                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `images/memory` entrypoint (`--allow-ffi --allow-sys`, no `--allow-run`)                                                                                                                                          | The memory service could load the ONNX native addon but spawn nothing                                                                                                                                                                                                              | Gap; memory spawns nothing today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `images/forge`, `images/radicle` entrypoints (`--allow-write=<data dir>,/tmp,…`)                                                                                                                                  | Writes confined to the data dir                                                                                                                                                                                                                                                    | **Replaced by the container:** a read-only root filesystem (compose `read_only`, k8s `readOnlyRootFilesystem`) with `/tmp` and the data volume the only writable places                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `forge` `shellGranted()` (`Deno.permissions.query({ name: "run", command: "sh" })`) and `process_preparer.ts` `querySync` (deleted)                                                                               | Feature detection: was `sh` grantable                                                                                                                                                                                                                                              | Always true now; delete the query and its "not granted" branch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `images/forge` (`--allow-run=git`), forge `readGithubSettings`                                                                                                                                                    | The networked forge could spawn only `git`: no `sh` for `RYPH_GITHUB_TOKEN_COMMAND`, and boot refused a token command there ("may not run `sh`")                                                                                                                                   | **Kept by env:** `readGithubSettings` refuses a token command when `RYPH_FORGE_NO_TOKEN_COMMAND=1`, which the networked forge's image sets; elsewhere a token command runs wherever it is set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `radicle` `rad` NotCapable branch                                                                                                                                                                                 | Explained `RYPH_RADICLE_BIN_DIR` vs a scoped `--allow-run`                                                                                                                                                                                                                         | The NotCapable half is dead; an `EACCES` there now means the file itself                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `radicle` dev and test tasks (`--allow-run` unrestricted, `--allow-net`, `--allow-read`, `--allow-write` unrestricted)                                                                                            | Little: deno.json already said `--allow-run` was unrestricted because `RYPH_RADICLE_BIN_DIR` makes the program an absolute path a by-name allowlist cannot cover. The bridge spawns only `rad`, `rad-job` and `git`                                                                | Accepted gap. The spawn set is fixed in code (`adapters/rad/cli.ts`, `helpers/http_backend.ts`) and every child gets a cleared, explicit env; the standalone bridge's writes are confined only by its container (the `images/radicle` row)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ryph`/host dev and compiled CLI (`--allow-run=docker,git,bash,sh,deno,rad,open,xdg-open`)                                                                                                                        | The local binary could spawn only those                                                                                                                                                                                                                                            | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ryph` binary's embedded files (`deno compile --include`)                                                                                                                                                         | The UI, migrations, catalogues, skills and workers were read and run from the binary's own read-only filesystem                                                                                                                                                                    | They are unpacked once per build to `~/.ryph/runtime/<id>` (`packages/ryph/src/resources.ts`), checked against their digests as they are written and again at every boot (a mismatch is unpacked again), sealed read-only, and the binary imports the UI's server and starts its workers from there. This user can still chmod and change a file between the check and its load, as they could replace a binary installed under the same home. Accepted gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| root scripts (`compose:init` `--allow-write=deploy/compose-networked/.env`, `compose:smoke`/`k8s:smoke` `--allow-run=docker`/`kubectl`)                                                                           | Each operator script could spawn only its own tool and write only its own output                                                                                                                                                                                                   | Accepted gap: an operator runs these by hand on trusted code, and what they spawn and write is fixed in the code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Test tasks (`--allow-net=127.0.0.1`, `--allow-run=…`)                                                                                                                                                             | Tests could not reach the network or spawn unlisted programs                                                                                                                                                                                                                       | Gap; tests listen on 127.0.0.1 by convention only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `deno test` sanitizers                                                                                                                                                                                            | A test leaking a timer, an op or a resource failed                                                                                                                                                                                                                                 | Gap; leaks now show as hangs or cross-test noise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `deno.lock` integrity and `--cached-only` for the sanitizer's module cache                                                                                                                                        | Code loaded only from a root-owned, read-only cache                                                                                                                                                                                                                                | `bun.lock` pins versions and integrity at install. The confined sanitizer can only read its own modules and parse5/entities (`--allow-fs-read`), and in the image they are root-owned and read-only to every service uid (the build fails on a world-writable file), so neither the control plane nor the sanitizer's uid can rewrite them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
