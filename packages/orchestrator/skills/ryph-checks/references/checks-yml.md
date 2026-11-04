# .ryph/checks.yml reference

Every key and limit the platform's parser enforces. The file lives at `.ryph/checks.yml` in the
repository root; `.ryph/checks.yaml` is read when there is no `.yml`. It is read at the change's
target branch, at one pinned commit, and the base's `.ryph/services.yml` is read at the same commit.

## Top level

A mapping with at most three keys, `setup`, `checks` and `keep`. Any other key refuses the file.

- An empty or comments-only file is no checks, the same as no file.
- `checks: []`, or `checks` left out, is no checks.
- YAML anchors (`&name`) and aliases (`*name`) are refused anywhere in the file.

## `setup`

A list of at most 16 steps, run in order before the checks, each in the repository root: once per
suite, or once in each check's own container when the environment image baked a checkout of the repo
(see "How a check runs"). A step is a mapping with exactly one key:

| Key   | Rule                                                                                       |
| ----- | ------------------------------------------------------------------------------------------ |
| `run` | Required. A non-empty string of at most 4000 characters, without NUL bytes, run as `sh -c` |

Steps run with the same network allowlist as the checks. A step that exits non-zero, or runs past
its share of the pod's deadline, fails every check of that run as "setup failed", and gets no
services: they start after setup.

Where steps run in each check's container (a baked checkout), a failing step fails that check, and a
step still running at the pod's deadline times it out. Every check's steps run at once, out of the
pod's one pool of CPU and memory. A heavy `setup` with many checks is slow and can run the pool
short, and the check furthest over its share is then stopped: declare fewer, heavier checks, or put
the heavy build in `.ryph/setup.yml` so the image holds it. The services start beside these steps,
but nothing waits for them before a step runs, and a service that keeps failing ends the suite as a
platform error.

## `keep`

A list of at most 32 gitignore-style patterns. It matters only when the environment image baked a
checkout of the repo: of the ignored files that checkout holds, a check keeps those a pattern names
and every other one is removed before `setup` runs. Left out, it is `[node_modules, target, .venv]`;
`[]` keeps nothing.

- a pattern means what it means in `.gitignore`: `target` is any file or directory of that name at
  any depth, `/target` only the root one
- each pattern is a non-empty string of at most 200 characters, without control characters, not
  negated (no leading `!`), not a comment (no leading `#`), and with no `..` segment

What `keep` names is trusted as a run trusts it: a cache the build tool checks for staleness itself,
against changed and deleted sources alike. Anything else would let a check pass on the image's old
output of code the head changed or deleted. Declare it for the repository's toolchains:

- Rust: `target`. npm, pnpm, yarn, bun, Deno: `node_modules`. Python synced exactly (`uv sync`,
  `poetry sync`): `.venv`
- nothing for Go (its caches are outside the checkout), Maven (its `target/` can keep the classes of
  deleted sources), a venv pip installs into (pip keeps packages the head dropped, and
  `pip install .` copies the project's old code), or generated output (`dist/`, codegen)
- the default suits Rust, Node and a uv-synced venv, and is wrong for Maven, whose output is also
  `target/`: a Maven repository declares `keep: []`
- a head that changes a lockfile runs on the image's old dependencies until something installs the
  new ones: cargo does by itself, npm and uv need their install in `setup`. Its log names the
  lockfiles

## `checks`

A list of at most 32 checks. Each is a mapping with these keys and no others:

| Key        | Required | Rule                                                                                                                      |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `name`     | yes      | `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`: 1–40 lowercase letters, digits and dashes, no dash at either end. Unique        |
| `run`      | yes      | As a setup step's `run`                                                                                                   |
| `timeout`  | no       | A duration (`90s`, `20m`, `1h`: one to six digits and a unit) or a positive whole number of seconds. At most 24h declared |
| `services` | no       | A list of at most 20 service names from the base's `.ryph/services.yml`. A name repeated is counted once                  |
| `watch`    | no       | A list of at most 32 path globs                                                                                           |
| `pod`      | no       | `own`: the check runs in a pod of its own. Absent: the suite's shared pod                                                 |
| `size`     | no       | Only with `pod: own`: a size class name (`^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$`) the deployment lets checks use            |

### `timeout`

Without one, a check gets 15 minutes. Whatever is declared is capped by the operator's
`RYPH_CHECKS_TIMEOUT_MAX` (one hour by default), and the default is never above that cap. A check
past its timeout is reported as timed out.

### `services`

Each name must be a service the base's `.ryph/services.yml` declares, and must be a service name
(`^[a-z]([a-z0-9-]{0,57}[a-z0-9])?$`). Only services some check names are started, after `setup`,
and every check that names one shares the same instance. A check reaches a service by its name and
port (`db:5433`), never by `localhost`, and waits up to three minutes for it to answer before it
fails as a platform error. The deployment must run service containers at all (`RYPH_SERVICES=on`):
where it does not, a suite in which any check names a service ends in an error, saying so. A service
only the checks need is marked `checks_only: true` in `services.yml`, so runs do not start it; a
check names it the same way as any other.

### `watch`

Globs matched against the whole repository-relative path of every file the change touched:

- `*` and `?` match within one path segment; `**` must be a whole segment and matches any number of
  directories (`**/x`, `x/**`, `a/**/b`)
- `package.json` matches only the root file; `**/package.json` matches it at any depth; `tests/**`
  matches everything under `tests/`
- each glob is relative (no leading `/`, no `..` segment), at most 200 characters, with at most 16
  wildcards and no control characters

`watch` changes only the report: a check whose watched paths the change touched is marked "watched
paths changed". `.ryph/**` is always watched. Every check runs on every change regardless.

### `pod` and `size`

`pod: own` runs the check alone, in a pod of its own beside the shared one: its own clone and setup
steps, only the services it names, its own deadline, and the whole pod's memory instead of a share
of the suite's pool. For a check that needs far more than its share, and gets stopped for memory
(exit 122) when the others peak with it. It costs a pod (and a slot) of its own, and its setup runs
again there. At most 3 checks of a file may be `pod: own`. A suite waits until all of its pods fit
the deployment's free slots together, and one with more pods than the deployment runs at once fails;
the repos view (`checks` tool, `repos`) shows `podsNeeded` and a `warning` when a file needs more.

`size`, only beside `pod: own`, names one of the deployment's size classes for that pod; without it
the pod gets the shared pod's size. A `size` without `pod: own` is refused. Which classes a check
may name is the deployment operator's choice (`RYPH_CHECKS_OWN_SIZES`, none unless they list some):
any other fails the suite when it launches, and the failure does not say which ones are allowed —
ask the operator. A check in an own pod reports as any other, and the suite's verdict is still all
of them.

## How a check runs

- One shared pod per suite (every check of one file against one commit, in one environment), and a
  pod of its own for each `pod: own` check. The head is cloned fresh in each. Git LFS objects are
  never fetched: a file tracked by LFS that the head changed or added holds its pointer, and with a
  baked checkout a file the head shares with the image holds what the image had.
- Each check runs in its own container, all in parallel. Disk is split evenly. CPU and memory are
  one pool: each check is guaranteed an even share and may borrow what the others leave, and when
  memory runs short the check furthest over its share is stopped (122). A check within its share
  never is.
- When the environment image baked a checkout of the repo, each check moves that checkout to the
  head in place (`checkout -f`, then `git clean -x` sparing what `keep` names), runs the `setup`
  steps there, then runs. So `setup` runs once per check, and should be cheap on a warm tree. The
  move runs no git hook and none of the image's git config: the checkout's own is rewritten to its
  repository format first. It cannot finish on a sparse checkout, a file marked skip-worktree or
  assume-unchanged, or a submodule the image left at another commit than the head's. Then the check
  runs on a cold copy of the clone instead: still a verdict, but slow, so fix the image's setup.
- Otherwise the `setup` steps run once, as init containers, in the fresh clone, and each check runs
  on a private copy of the tree as `setup` left it.
- Everything runs as the run user (uid 1994) with `HOME` and `PATH` from the environment image, so
  caches and toolchains the image baked are there. Without a baked checkout, nothing written outside
  the tree by `setup` reaches a check.
- No credential of any kind is in a check container. Outbound network goes through the egress proxy
  with the requesting run's allowlist.

| Exit observed                                      | Reported                      |
| -------------------------------------------------- | ----------------------------- |
| 0                                                  | passed                        |
| 124, or the pod's deadline                         | timed out                     |
| anything else (out of memory is named)             | failed                        |
| a `setup` step's non-zero exit                     | setup failed, for every check |
| the same, in a check's own container (baked)       | failed, for that check        |
| a baked `setup` step still running at the deadline | timed out                     |
| a check that used more than its share of disk      | failed                        |
| 122: stopped when the pod's memory ran short       | failed, naming its share      |
| 125, an evicted or lost pod, a launch that failed  | the platform's: retried twice |

A command's own 122, 124 or 125 is reported as 1, because those codes are the platform's.

## Which commit and which file

| Run                                             | The file is read at                |
| ----------------------------------------------- | ---------------------------------- |
| A run working a pull request or patch           | that change's target (base) branch |
| A run on one of the repository's own branches   | that branch                        |
| A run on a ref that is not the repository's own | the default branch                 |

A read the forge could not answer is retried, never taken as "no checks".

## Reuse

A suite is identified by the repository, the head commit, the checks file, the environment image,
and the requesting run's network scope and services. Asking again for the same identity joins the
existing suite, running or finished. A new suite copies the passes the same commit already has under
the same inputs, so only the rest run. A failure is never copied: asking again is how a flaky check
is retried.
