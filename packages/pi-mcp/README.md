# 🧩 @ryph/pi-mcp

The ryph MCP extension for [pi](https://pi.dev): how tools reach a run.

pi has no MCP client of its own; MCP reaches it through extensions, and the
[runner](../runner/README.md)'s pi adapter switches extensions off wholesale (`--no-extensions`)
because the workspace is untrusted third-party code. This is the extension it loads back in, by
explicit path (`-e`), when the run's agent has a tool policy (the only other one, the images
extension below, lives in this package too). It is small and it is
plumbing: connect to the MCP servers one config file names, register every tool they list as a pi
tool, forward calls. The security story lives in the [MCP gateway](../mcp-gateway/README.md),
which is what every one of those servers actually is.

## What it does

1. Reads **one file**: `mcp.json` in `$PI_CODING_AGENT_DIR`, the throwaway config dir the runner
   writes per run. One entry per server in the run's scope, keyed by the server's slug:

   ```json
   {
     "mcpServers": {
       "linear": {
         "url": "http://mcp-gateway:7430/v1/mcp/run_…/linear",
         "headers": { "Authorization": "Bearer ${MCP_GATEWAY_TOKEN}" }
       }
     }
   }
   ```

   The workspace's `.mcp.json`, `.pi/mcp.json`, `.cursor/mcp.json` are never read: repo-authored
   MCP config is `setup.yml`-trust code choosing its own servers, and it does not get to.

2. Expands **`${VAR}` only** in header values, from the environment. No `!command`, no keychain, no
   token files. The runner puts the run's virtual token into pi's spawn environment as
   `MCP_GATEWAY_TOKEN` — and nowhere else: not in this file, not in argv, not in a log line or an
   error message. An unset variable is fatal, named by its name and never its value.

   What that does and does not buy, plainly. **Repo-authored `setup.yml` steps and the runner's
   own children never hold the token**: it sits in the runner's environment under a brand-scoped
   name the scrub removes from every child, and the runner's git subprocesses take a built
   environment (`helpers/git_exec.ts`), so a workspace-planted git hook cannot read it either.
   **The agent itself can.** It is pi's own environment, and pi hands that to every subprocess the
   agent's shell tool spawns, so an injected instruction can read `$MCP_GATEWAY_TOKEN` and send it
   anywhere the run can reach — live, for the rest of the run. That is accepted design, not an
   oversight: what an exfiltrated token buys is exactly the run's own allowlist, metered, and dead
   the moment the run concludes (see the [gateway README](../mcp-gateway/README.md)).

3. **Connects** to each server over streamable HTTP with the `@modelcontextprotocol/sdk` client,
   lists its tools, and registers each as a pi tool named `<slug>__<tool>` — `linear__create_issue`.
   The prefix means two servers exposing `search` cannot shadow each other in the model's view;
   the call goes upstream under the tool's own name. A name that is not provider-safe as is (a
   character outside `[A-Za-z0-9_-]`, or over 64 characters with the prefix) is folded, clipped,
   and suffixed with a hash of the slug and the tool's own name — `linear__issues_list_fff4d6ee`
   — so every tool gets a name and `issues.list` never collides with `issues_list`. A plain name
   that already ends the way a rewritten one does is rewritten too, so the two forms can never
   spell the same string: distinct tools get distinct names, and a name the server lists twice is
   fatal rather than one silently dropped tool. The list is read to its last page; a cursor that
   repeats is fatal. The server's JSON Schema is the tool's
   parameter schema as is (pi validates plain JSON Schema). What the model sees is exactly what
   the gateway's `tools/list` answered, which is the run's allowlist and nothing more.

4. **Forwards calls** and maps results: text and image blocks pass through, anything else is
   described as text, an `isError` result becomes an error tool result for the model.

5. **Fails loudly.** A config it cannot read, a variable it cannot expand, a server it cannot
   reach, a tool a server listed twice: one `ryph pi-mcp: …` line on stderr and exit 1, so pi
   never starts, the runner reports a run error, and no run ever limps on toolless without saying
   so. Success is announced too — `ryph pi-mcp: ready — N tool(s) from M server(s)` — because
   `-e` is not acknowledged by pi: the runner's adapter warns when a run it gave tools to never
   printed that line, which is what a pi that stopped honouring the flag would look like.

   One exception holds a failure back for a while: a server that is not there yet. That is no
   answer at all from the gateway (a network error), a 503 or 504, or a 502 whose body is the
   gateway's `upstream unreachable` or the tool guard's `the hosted server did not answer` (the
   gateway passes the guard's answer through). Connecting and listing the server's tools is then
   tried again, with a fresh client each time and waits of 250 ms doubling to 4 s, within 60 s of
   wall clock per server, the attempts' own time included. The last wait is shortened so another
   attempt still gets about 1 s, and no retry starts with less; an attempt still waiting
   when the window closes is cut off. The fatal then reports what the server said on the attempt
   before, and how many attempts there were; only a server that never answered at all reports
   the cut-off itself. Servers connect one after another and the first that runs out ends
   startup, so a gateway that is down costs one window, not one per server. That covers a hosted
   server moved to another node by a scale-down, which is unreachable for a few seconds and then
   fine. One that has to wait for a new node (a minute or two) is still fatal. Everything else is
   fatal at once: a 401 or 404, a malformed answer, and the 502s that are the gateway refusing
   (its policy, a platform server this deployment did not wire, a credential the upstream
   rejected).

## The images extension

`images.ts` is a second, separate extension in this package, with no dependencies, loaded in
**every** run (tools or not): it keeps every request pi sends within the provider's image limits.
Images stay in pi's history once in — inline on a prompt, read from a file, returned by a tool —
and every later request carries all of them; pi's compaction counts an image as 4,800 characters
whatever its size, so it never compacts for them. Measured: four large task images plus ten the
agent read made a 36 MB request, a strict mock of Anthropic's limits answered 413, and with the
images still in the history every retry failed the same way. The runner cannot prevent that: it sees only the images it sends.

So the extension hooks pi's `context` event, which fires before each model call with a copy of the
conversation that is used for that call only (pi never stores what the handler returns). It keeps
the newest images that fit **16 MiB of base64 and 20 images**, and puts a short line in place of
each older one, saying how to see it again: open its file (named in the
runner's note of the same message), read the file again, or run the tool again. An image over
5 MiB of base64 never goes. Half of Anthropic's 32 MB request leaves the text of even a full
1M-token window room three times over, and 20 images keeps every request out of Anthropic's
2000x2000 rule for requests holding more. Compaction and branch summaries need nothing: pi turns
those conversations into text first.

Where that line falls is a trade with the prompt cache: the line is where a request first differs
from the one before, and everything after it is billed as a cache write (1.25x) rather than a read
(0.1x). Cutting at exactly what fits moved the line with every new image once a run was past the
budget. So it falls only on boundaries counted from the start of the conversation (every tenth
image, and the first image to start in each next 8 MiB), plus the start of the newest message's
images so a prompt's images that fit together arrive together. The line then stays put while the
next block of images arrives, and a request carries between about half and all of the budget.

A model that cannot see images gets none at all: the runner's pi adapter sets
`RYPH_MODEL_TEXT_ONLY=1` on pi's environment when the run's model takes no images, and the
extension then puts a line saying so in place of every image in every request. pi 1.0.0 puts its
own placeholder in for such a model as well; this does not depend on it.

It also names every image a tool returns, MCP tools and pi's `read` alike: a text block
`Image ref: img-<12 hex>` right after the image, the first 12 hex of the SHA-256 of its bytes.
The agent writes `![alt](img-…)` to show that image in a summary, a patch description, a forge
body or a chat post, and the runner uploads the image under the same ref. The line is added in
pi's `tool_result` hook, so it is in the history and in the `tool_execution_end` the runner
narrates; pi resizes an oversized image after that hook, so a `message_end` hook puts the stored
line right again (the runner hashes the bytes itself and trusts a narrated line only when it
matches). The line is its own block, so an image left out of a request keeps it.

It prints `ryph pi-images: ready — …` on stderr once loaded, and the runner warns when a run never
printed it, for the same reason the MCP extension announces itself.

## Where it runs

Baked into the [harness layer](../../images/harness/Dockerfile) at `/opt/ryph/pi-mcp/` with
its npm dependencies installed beside it (`npm ci` from the committed `package-lock.json`); pi
loads it through jiti, so the TypeScript needs no build. The runner passes
`-e /opt/ryph/pi-mcp/index.ts` when — and only when — the run has tools, and
`-e /opt/ryph/pi-mcp/images.ts` always.

For a checkout driving pi outside the image, install the dependencies here (`npm ci` in this
directory) and point the runner at the file with `RUNNER_PI_MCP_EXTENSION=$PWD/packages/pi-mcp/index.ts`;
the runner finds `images.ts` beside it.

## Tests

`bun run test` drives the MCP extension against a real SDK server behind a fetch-shaped door — no
sockets — with a fake pi recording what gets registered: the namespaced names and schemas, the
round-tripping call, the error mapping, two servers with one tool name, and each fatal path. The
same bare specifiers resolve under Bun through `package.json`, so the file tested is the file pi
loads. The pi-facing surface (`registerTool`, `session_shutdown`) is typed as a structural slice
rather than imported from the pi package, so neither runtime depends on it; the runner's opt-in
`PI_E2E=1` run is what exercises the real pi.

The images extension's tests (`tests/images_test.ts`) are pure: pi-shaped conversations in, the
request's images out — which ones are kept, what replaces the rest, the measured failures held
within the limits, the line moving only at boundaries as images arrive one by one, and pi's
history left untouched.
