# 🛠️ Development

## 📋 Prerequisites

Tool versions are pinned in the checkout root's [`mise.toml`](../../../mise.toml).
Install [mise](https://mise.jdx.dev), then let it provision Bun:

```sh
mise install      # installs the pinned Bun
```

Running the real [pi harness](harnesses.md) (`kind: "pi"`) additionally needs pi — it is not a
project dependency. In an image the adapter spawns the harness layer's `/opt/ryph/bin/pi` by
absolute path (images/harness/Dockerfile); from a checkout, install pi and point the runner at it
with `RUNNER_PI_BIN`:

```sh
npm install -g @earendil-works/pi-coding-agent
RUNNER_PI_BIN=pi bun --no-env-file src/main.ts …
```

Everyday development doesn't need it: the test suite drives the adapter against
`tests/fixtures/fake_pi.ts`, and only the opt-in e2e run (`PI_E2E=1`) touches the real binary.

A run **with tools** (an agent with a tool policy) additionally loads the ryph MCP extension,
[`@ryph/pi-mcp`](../../pi-mcp/README.md), which the harness layer bakes at
`/opt/ryph/pi-mcp/index.ts`. Driving pi from a checkout instead, install the extension's npm
dependencies beside it and point the adapter at the file:

```sh
(cd packages/pi-mcp && npm ci)
RUNNER_PI_MCP_EXTENSION=$PWD/packages/pi-mcp/index.ts bun --no-env-file src/main.ts …
```

Without the variable the adapter passes the image's path, and pi fails to load it — loudly, as a
run error, never as a toolless run. The variable also places the images extension, which every
run loads: the `images.ts` beside the file it names, so a checkout run needs it even without
tools.

## ⚡ Tasks

Defined in [`package.json`](../package.json):

| Script                  | What it does                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `bun run ci`            | typecheck, architecture guard, tests; with the root's `bun run fmt` and `bun run lint`, run this before pushing |
| `bun run test`          | runs the test suite in `tests/`                                                                  |
| `bun run check`         | type-checks `src/`, `scripts/`, and `tests/` without running anything                            |
| `bun run guard`         | architecture guard (enforces the import/dependency rules)                                        |
| `bun run compile`       | builds the `ryph-runner` and `ryph-bake` binaries into `dist/`, as the agent image does          |
| `bun run debug`         | seeds the debug fixtures, then runs the runner under the debugger — see below                    |
| `bun run debug:setup`   | seeds the local debug fixtures on its own (`debug` already does this for you)                    |
| `bun run debug:clean`   | removes the local debug fixtures                                                                 |

## 🐛 Debugging the runner

`bun run debug` runs the whole runner end-to-end under Bun's inspector, against a disposable local setup —
no network, credentials, or personal git config involved.
It stands up a throwaway bare git origin under `debug/`, writes a work item and injected context pointing at it,
and drives the run through the real path: clone → write `AGENT_NOTES.md` → commit → push.
Everything it creates is regenerated on each run and ignored by git.

The bare origin has no working tree to browse, so the setup also leaves a plain clone of it at
`debug/inspect` — open that in an IDE or a git GUI (Sourcetree, etc.) to inspect what a run pushed.
After each run, `git -C debug/inspect fetch --prune origin` (or the GUI's fetch button) makes the
runner's pushed branch appear; it is recreated on every reseed, so it never points at a vanished history.

One gotcha when running agent-produced code inside `debug/inspect`: the directory sits inside this
repository, so a package manager run there may resolve upward to the checkout root's workspace and
its `bun.lock`.

The runner prints the result JSON on stdout and everything else — narration and diagnostics — on
stderr, so when a run isn't attached to your terminal (a script, an agent, a CI-ish wrapper),
plain redirection captures the whole thing under the git-ignored `debug/`:

```sh
bun --no-env-file \
  src/main.ts --work-item debug/workitem.json --context debug/context.json \
  > debug/result.json 2> debug/run.log
```

`tail -f debug/run.log` (or opening the file in an IDE) follows the run live.

[`architecture.md`](architecture.md) names the ports and the outside system behind each.
The composition root binds one self-contained adapter per port,
and a debug run exercises them against the throwaway origin — the whole pipeline on your machine alone:

| Port                      | Adapter   | How it stays self-contained                                                      |
| ------------------------- | --------- | -------------------------------------------------------------------------------- |
| `Harness`                 | `echo`    | writes the task into `AGENT_NOTES.md` instead of driving a coding-agent CLI      |
| `GitTransport`            | git CLI   | clones and pushes over the `file://` origin under `debug/` — real git, no remote |
| `OrchestratorGateway`     | `noop`    | accepts every result and drops progress, so nothing is reported upstream         |
| `MemoryStore`             | spec      | serves the brief the `--context` file carries (the debug seed writes a sample one) |
| `Narrator`                | console   | prints the transcript to the terminal                                            |
| `Diagnostics`             | `@ryph/logger` | prints the machinery log to the terminal, on stderr like everything else    |

Commits are authored as the work item's agent, with git's own config ignored (`helpers/git_exec.ts`),
so the run never touches your personal git identity.

### ⚙️ One-time setup

Install the **Bun** extension for VS Code (`oven.bun-vscode`), then add an attach configuration
(`.vscode/` is git-ignored, so it stays local to your machine):

```jsonc
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Attach to Bun",
      "type": "bun",
      "request": "attach",
      "url": "ws://127.0.0.1:9229/runner",
    },
  ],
}
```

### ▶️ Run it

1. Set breakpoints anywhere in `src/`.
2. Start the run:

   ```sh
   bun run debug
   ```

   It seeds the fixtures, then launches the runner with `--inspect-wait` and blocks until a debugger attaches.

3. In VS Code, launch **Attach to Bun** (`ws://127.0.0.1:9229/runner`; the inspector also prints a
   `debug.bun.sh` link for the browser). Execution begins and stops at your breakpoints.
4. Step through.
   When the run finishes, the result JSON — the signed, pushed branch — prints to the terminal.

### 🧹 Clean up

```sh
bun run debug:clean
```

Removes the throwaway origin, the inspection clone, the work item, and the injected context.
(`bun run debug` also resets them at the start of every run, so this is only for tidying up when you're done.)
