# @ryph/shared

The plain helpers several ryph packages used to carry a copy of each: the router and body reading
every service is built on, the address rule every door that dials a chosen URL asks, the environment
a process refuses to start under, fence writing and reading, the ref and patch-line contract the
runner, forge and orchestrator share, and the core of an MCP tool server. No dependencies,
web-platform globals only.

## ⚙️ What it does

One module per subpath, no barrel:

| Import                  | Does                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `@ryph/shared/http`     | `route` / `makeRouter` over URLPattern, `json`, `readCapped` and its stream forms, `parseBody` against any zod-shaped schema |
| `@ryph/shared/net`      | `parseIp`, `isBlockedAddress` (the strictest union of every copy's ranges), `isLoopbackHost`                                 |
| `@ryph/shared/env`      | `hostileEnvironment`: the Bun and TLS variables a process refuses to run under, and which one it was                         |
| `@ryph/shared/markdown` | `fence` (a fence no content can close), `fenceOpen` / `fenceCloses` (one CommonMark fence recognizer), `codeRanges`          |
| `@ryph/shared/refs`     | Base-ref normalization, `isGitRefName`, `checkoutBranchOf` — the cache's contract with the runner                            |
| `@ryph/shared/lines`    | Patch lines: `isLineName`, `lineBranch`, `parseLineBranch`, `runBundleKey`, `lineOfBranch`                                   |
| `@ryph/shared/mcp`      | A transport-agnostic MCP JSON-RPC server: one message in, one reply (or none) out                                            |

Tokens, hashes and the service bearer gate are not here: they are
[`@ryph/sealed`](../sealed/README.md)'s.

## 🧬 Why a package

Every one of these was "duplicated on purpose" once, with a note that the copies must stay in
lockstep. They did not: a router that percent-decoded its path groups beside nine that did not, an
address guard that let NAT64 through beside one that refused it, a fence parser that closed on any
line starting with three backticks. Rules that must agree belong in one place, tested once.

## 🔒 The rule: `src/` imports nothing outside `src/`

No npm package, no `node:` built-in, no sibling member — only what a browser and a server both have
(`crypto.subtle`, `TextEncoder`, `URLPattern`, `Response`, `ReadableStream`). Two reasons:

- The app's browser code imports it, and the services import it from their fenced `core/` scopes,
  which are allowed nothing with I/O in it. A leaf that reaches nothing can be imported from
  anywhere.
- The service guards walk direct edges only. A fence that allows `../shared/` stays transitive only
  for as long as this package reaches nothing; an import of `@ryph/orchestrator` from here would
  otherwise leave every one of them reporting "clean".

"Nothing" is checked, not promised: `bun run guard` walks every file in `src/` and fails on any edge
that is not another file in `src/`.
