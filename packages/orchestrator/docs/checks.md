# ✅ Checks

How a repo says _"these commands must pass before anything merges"_, and how ryph runs them on the
exact commit it received, in a container nothing from the run touched, and reports the verdict to
the forge.

Off by default: `RYPH_CHECKS=on` turns it on, and until then no `.ryph/checks.yml` is read. The
`ryph` binary under docker, and so [deploy/compose](../../../deploy/compose/README.md), turns it on
with environment builds.

## 📜 `.ryph/checks.yml`

```yaml
setup:
  - run: npm install --prefer-offline
keep: [node_modules]
checks:
  - name: lint
    run: npm run lint && npx prettier --check .
  - name: test
    run: npm test
    timeout: 20m
    watch: [package.json, "**/*.test.ts", "tests/**"]
  - name: e2e
    run: npm run test:e2e
    services: [postgres]
    pod: own
    size: large
```

| Key                 | Required | Meaning                                                                                                                                                                                                                                                        |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup[].run`       | no       | Run in order, in the tree the checks run in, before they run: once per suite, or once per check when the image baked this repo (see [The check pod](#-the-check-pod)). At most 16 steps. Services: see the check pod                                           |
| `keep`              | no       | Gitignore-style patterns for the image's ignored files a check keeps when the image baked this repo. Everything else ignored is removed. Default `[node_modules, target, .venv]`; `[]` keeps nothing. At most 32, no `..`. See [below](#what-keep-should-name) |
| `checks[].name`     | yes      | Lowercase letters, digits and dashes, starting and ending with a letter or digit, at most 40 characters, unique. The forge shows it as `ryph / <name>`, which is what a ruleset requires, so renaming one breaks it                                            |
| `checks[].run`      | yes      | One shell line, at most 4000 characters, run as `sh -c` by the check container's own entrypoint. The control plane never interprets it                                                                                                                         |
| `checks[].timeout`  | no       | `90s`, `20m`, `1h` or whole seconds. Default 15 minutes; capped by `RYPH_CHECKS_TIMEOUT_MAX`                                                                                                                                                                   |
| `checks[].services` | no       | Names from the base's `.ryph/services.yml`, `checks_only` or not. Only the services some check names are started; checks that name the same one share it. Where `RYPH_SERVICES` is off, a suite with any is an error                                           |
| `checks[].watch`    | no       | Path globs the check depends on beyond the code under test, matched against the whole repo-relative path: `*` and `?` within a segment, `**` as a whole segment only, at most 16 wildcards. `.ryph/**` is always watched                                       |
| `checks[].pod`      | no       | `own`: the check runs in a pod of its own, alone, with only the services it names (see [Pods of their own](#pods-of-their-own)). Absent: the suite's shared pod                                                                                                |
| `checks[].size`     | no       | Only with `pod: own`: a size class for that pod, one the operator lets checks use (`RYPH_CHECKS_OWN_SIZES`). Any other fails the suite at launch, without naming the classes that would do. Absent: the size the shared pod gets                               |

At most 32 checks, at most 3 of them `pod: own`. Unknown keys, YAML anchors and aliases are refused,
with a message for the repo's author. An empty file, or `checks: []`, is the same as no file.

### What `keep` should name

`keep` matters only when the suite's image is an environment image that baked this repo's checkout
(see [The check pod](#-the-check-pod)). Each check then starts from that checkout, moved to the
head, and removes every ignored file the image left except what `keep` names. What it keeps is the
build cache the image is for; what it removes, the check rebuilds or reinstalls in its own setup.

A `keep` pattern is a line of a `.gitignore`: `target` is every file or directory of that name,
`/target` only the root one. It cannot be negated (`!`), and a pattern is at most 200 characters.

What `keep` names is trusted the way a run trusts it: the build tool, not ryph, decides what of it
is stale. That is the whole question for each entry: **does the tool notice when the head changed
something this output was made from, including a deleted source?** If it does, keeping it is safe
and makes the check warm. If it does not, the check can pass on the image's old output instead of
the head's: a head that deletes a test or a generator would still pass on what the image built from
it. ryph cannot tell the two apart, which is why the default is only a guess, and why every
`checks.yml` should declare `keep` for its own toolchain.

| Toolchain                    | Keep                                    | Why                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust (cargo)                 | `target`                                | cargo fingerprints every unit against its sources, flags and dependencies, and rebuilds what changed. A deleted source drops out of the build, except files a build script wrote into its `OUT_DIR`, which stay until that script runs again                   |
| npm, pnpm, yarn, bun         | `node_modules`                          | Packages come from the registry by the lockfile, not from the head's code, and setup's install (`npm install`, `pnpm install`) brings them in line with the head's lockfile. Linked workspace packages point into the tree, so they are the head's             |
| Deno                         | `node_modules` (when it has one)        | As npm. Its own cache lives in `DENO_DIR`, outside the checkout, and reaches checks untouched                                                                                                                                                                  |
| Python, synced with uv       | `.venv`                                 | `uv sync` installs the project editable (a link to its sources) and makes the venv match the lockfile exactly, removing what the head dropped. Run it in setup. `poetry sync` and `pdm sync --clean` do the same                                               |
| Python, installed with pip   | nothing                                 | pip never removes a package the head dropped, so an import of it still passes. `pip install .` also copies the project's own code into the venv, so tests import the image's copy. Keep nothing, or move to an exact sync                                      |
| Go                           | nothing                                 | Its build and module caches are outside the checkout (`GOCACHE`, `GOMODCACHE`) and reach checks untouched                                                                                                                                                      |
| Maven, Gradle (Java, Kotlin) | nothing                                 | Maven's incremental build can leave the `.class` file of a deleted source in `target/`, and tests run against it. Declare `keep: []`: the default's `target` would keep it. Gradle's `build/` is not kept by default. `~/.m2` and `~/.gradle` stay warm anyway |
| Generated output             | nothing (`dist`, `build`, codegen dirs) | The generator, not a build tool, made it, and nothing checks it against the head                                                                                                                                                                               |

When a repo mixes toolchains, list the safe entry of each: `keep: [target, node_modules]`. Without
`keep`, the default `[node_modules, target, .venv]` applies, which is right for Rust, Node and a
uv-synced venv, and wrong for Maven and a pip-installed venv. An explicit `keep` replaces the
default entirely, and `[]` keeps nothing: every check then starts from the head's sources with none
of the image's build output, which is correct for any toolchain, just slower. Caches outside the
checkout (`$HOME`, `DENO_DIR`, `~/.cargo/registry`, `/opt`) are never touched, whatever `keep` says.

**When the head changes the dependencies.** The image installed and built the dependencies of the
commit it baked. A head that changes a lockfile (`Cargo.lock`, `package-lock.json`, `uv.lock` and
the like) needs what changed installed and built again, in each check, all of them at once out of
the suite's one memory pool. cargo fetches and builds what changed by itself. npm, uv and the rest
install only when told: `setup` must run the install (`npm install`, `uv sync`), or the check runs
against the image's old packages. With that, the check is correct, only slower, and its log names
the changed lockfiles. Cargo rebuilds mostly the crates whose versions moved, so a one-crate bump
costs little; a large upgrade costs every check about what a cold build of those crates costs.

## 🧑‍⚖️ The judge is the base

The declaration is read at the change request's **target**, never its head: a PR run's base, a fresh
run's own base branch, the default branch for a ref that is not the repo's own branch
(`core/checks.ts` `checksRef`). The forge pins that branch to one commit and every other read — the
base's `services.yml`, its `.ryph/` tree, whether it has a Dockerfile — is at the same commit. A
patch that edits `checks.yml` is checked against the old one; the new one takes effect when it
merges.

A read the forge could not answer is retried (30 s, doubling to 30 min, given up after a day). It is
never read as "no checks", and there is no stale answer: a stale base is a wrong judge. A ref the
forge refuses outright is the declaration's problem, reported at once.

## 🏷️ Suites, and nothing running twice

A suite is every check of one declaration against one commit in one environment, for one kind of
pod. Its identity is `(repo, commit, checks.yml blob, environment key, inputs key)`:

- the environment key names the image, chosen once as the suite is claimed, by the rule runs follow
  (`core/environment_resolve.ts`): wait only when the image would be wrong, never when it is old.
  With environments off it is `default:<RYPH_AGENT_IMAGE>`. Otherwise:
  - the base is the default branch, or a branch whose `.ryph/` tree is the default branch head's, or
    a branch where neither side has a `.ryph/Dockerfile`: the newest ready default-branch image (one
    whose `.ryph/setup.yml` finished before one whose did not, below), whatever tree it was built
    from, keyed `image:<reference>`, with no wait. The check's own `setup:` runs on top of it either
    way. With nothing ready: `default:<RYPH_AGENT_IMAGE>` when the base has no Dockerfile, else
    `tree:<the base's .ryph tree id>`, waiting for a build (below)
  - the base is a branch whose tree differs and that has a Dockerfile: `tree:<its tree>`, waiting
    for an image of exactly that tree
  - the base is a branch whose tree differs and that dropped the default branch's Dockerfile:
    `default:<RYPH_AGENT_IMAGE>`

  So a merged edit to `.ryph/` never holds a PR's checks for a build, and a failed build of the new
  tree errors no suite that can take an older image. The default branch head's `.ryph/` is read once
  a minute per repo; when it cannot be read, the suite takes the run's fallback (below). A check pod
  runs none of the harness, so it launches the baked image under it, and the key names that: a
  re-layer onto a new harness keeps the key and the suite. A newer build makes the next ask a new
  suite; asks at one base commit within a minute share one choice, so asks that land together join
- the inputs key hashes the requesting run's network scope and the services resolved for it (or why
  they could not be). An asker with no run (a push to a change request, a person's local ask) has
  the scope an agent with no network policy gets: the deployment's allowlist as it stands, never
  anything taken from the event or the person, so every such asker of one head lands on one
  identity. A run with a narrow network policy never joins a suite that reaches more, and fixing
  `services.yml` makes the next ask a new suite rather than a join of the refusal. A run of only
  some checks adds their sorted names to it, so a partial suite and a full one never join, and two
  asks for the same names do

A new suite takes the passes its commit already has (`reusePasses`). A check that passed in another
suite of the same commit, read from the same checks file, in the same environment, with the same
network scope and the same services for what it names, is copied into the new suite's first
generation as passed, its log included, and is left out of the pod. The base commit need not match:
those are all a check takes from the base, so a merge that moved the base between two asks takes
nothing away. The row names the suite that ran it (`inheritedFrom`): the page marks it Inherited,
and the run's note and the forge's check run say it came from an earlier run. So an agent that runs
the checks its change most likely breaks first, then all of them, pays only for the rest. When every
check passed already, the suite is `passed` at once, with no pod, and whether the commit changed
`.ryph/` comes from the suites it took from. A join that restarts a cancelled or broken suite takes
them too, its own last generation's among them. Only passes are taken: a failure is run again, since
asking again is how a flaky check is retried. A re-run of the whole suite, the page's or the forge's
"Re-run all checks", takes none. The forge's Re-run on one check takes every pass of the suite's own
last generation but that check's, never another suite's, so it runs that check and whatever else
failed. A relaunched pod leaves out the checks that already hold a verdict.

What that accepts:

- a copied pass may have run in a pod shared fewer ways: a check that passed alone had the whole
  pool to itself, and is not asked whether it still fits beside the others
- the base moving between the two asks, or the environment's key changing (a newer default-branch
  image becoming ready), makes a new suite that takes nothing. A `tree:` key names the tree, not the
  image, so a pass from one image of the tree is taken by a suite that runs another
- the page shows the copied check's log, which another task's suite may have produced: the same
  commit, the same command and the same inputs, so the same output a pod of its own would print
- a suite that passes on copied rows alone launches nothing, so the launch's check of the network
  scope against the deployment's ceiling is not made again

A second request for the same identity joins the suite, running or finished: an agent that ran
`ryph__run_checks` on its final commit and submits gets its patch reported from that suite, with no
second pod. Joining a suite that was **cancelled**, or that the platform could not run, starts a new
generation of it from the joiner's own bundle: neither is an answer about the commit.

Requests come from:

- the agent's `ryph__run_checks` (`POST /v1/runs/:id/checks`). It answers within 10 seconds: past
  that, "requested", and a refusal found later reaches the run as a message, posted before the
  request leaves `pending`. A post that fails leaves it pending, and the tick tries again within
  seconds. A refusal already being written when the 10 seconds run out is the tool's own answer. A
  newer call replaces the run's earlier ones on the same line (the branch checked out; other lines'
  requests stand), and cancels those suites still going unless a patch, another run, or a request
  for the same head and the same checks not yet read also asked for them. An earlier suite that
  already settled stays on the run's record with its verdict, but the run is not told about it
  again: a re-run of it is someone else's. It may name `checks`: the suite then runs only those, in
  a pod split among fewer checks. A name the base does not declare refuses the request with the
  names it does, and naming every check is the full suite. The names ride the request's `source`
  (jsonb), and the suite's `definition` holds only the named checks with `partial: true`, so no
  column was added. A partial suite counts toward `RYPH_CHECKS_MAX_PER_RUN` and holds the run like
  any request, and the run is told its verdict. It is never reported to the forge, never the suite a
  patch is judged by, and the forge cannot re-run it; the suite page's Re-run runs the same checks
  again
- every patch's birth (`core/open_patch.ts`), before approval. The run that submitted it is told the
  verdict too, and a finish waits for it (see Who is told). The birth's request and the submit's
  forge row are written best-effort; one that did not land is filed by the minute sweep, which looks
  at the 50 newest patches born a minute to a day ago while checks were on: since the control plane
  started, or since the oldest of them that did file a request, so turning checks on files nothing
  for older patches
- a push to any change request of a connected repo (`change_request.pushed`): a GitHub pull request
  opened, reopened, pushed to, or retargeted (`edited` with `changes.base`), or a new revision of a
  Radicle patch, the first one included (and a Radicle reopen, which checks the head again). The
  event names the head, the base branch, a fetch ref (`refs/pull/<n>/head`, none on Radicle), the
  change request's URL (https, or none), its `author`, and `before`, the head a GitHub `synchronize`
  moved away from. Its request has kind `push`, no run and no patch, and its `source` is the change
  request's head on the forge: `{runId: null, changeRequest, fetchRef, branchName, baseRef, url}`,
  with `branchName` `pull/<n>/head` or `patches/<id>`. It is read at the change request's base,
  normalised as every other base is (one that is not a branch of the repo reads the default branch),
  on the tick.
  - **The forge's live state decides.** The event is only a claim: deliveries arrive late and out of
    order, and neither forge's clock orders them. So the change request's head is read live first, a
    lean read of its state, heads and base alone (15 seconds at most; a forge that cannot answer is
    a 503). Closed, merged or gone: its push asks are withdrawn and nothing is filed
    (`change-request-closed`), so a late push to a merged pull request runs nothing. The head
    compared is the author's own newest: on GitHub the only head, on Radicle the patch author's
    latest revision (anyone may add a revision to a patch). Another head than the event's is stale
    (`checks-stale`), and any ask of the event's head is withdrawn, since the live head's own event
    comes or came, unless it is the event's `before` within three minutes of the forge receiving the
    push: then the forge's read is behind this very push, and a 503 has the mailroom ask again (its
    first four retries fit). Past that it is stale like any other head: a change request pushed back
    to where it was (A, then B, then A again) leaves the first event's `before` live for good, and a
    503 for ever would hold the forge's one queue behind it, every delivery after it waiting out the
    mailroom's ten attempts. Otherwise the live base is the base, whatever the event said. Once
    filed, the head is read again before anything else is withdrawn: still the event's, it stands;
    moved on, only this event's own request is withdrawn and the push is `checks-stale`, so a slow
    delivery of an older head never replaces the live one; no answer, a 503 with everything left for
    the retry to settle, which cannot lose the live head either way
  - **Who may make it run.** The change request's author must pass the command gate on every action,
    and so must the actor when that is someone else: `commandTier`, write on GitHub, delegacy on
    Radicle (where write is anyone on a public repo), with the repo's command allowlist as the
    Radicle fallback, the same rule a `/ryph` comment meets. So a maintainer reopening, retargeting
    or updating a stranger's pull request does not make this deployment run the stranger's code, and
    a stranger pushing onto a maintainer's does not either. On a change request ryph itself opened
    (the head read's `openedByUs`), the author is ryph's own identity, the App or the node, so only
    the actor is asked there. A pull request of a person's that a ryph run pushed onto is still
    theirs, and still gated on them. Denied runs and posts nothing; a forge that cannot say is a 503
    the mailroom retries.
  - **Ryph's own heads.** A head one of ryph's live patches carries, on this change request or on
    none yet, is the patch's (`ryph-patch`): the patch asked at birth, and the change request's push
    asks of other heads are withdrawn. A person pushing onto ryph's pull request makes a head with
    no patch, and that is asked for like any other.
  - **Order.** The live head's push supersedes every other live push request of the change request,
    pending or active, and cancels their suites nobody else wants. Two deliveries handled side by
    side each look again once their request is in, and one rule decides what stands: the head of the
    newest-filed request, and of that head and base the earliest-filed request. The same head and
    base again files nothing new, re-files the request's forge row in case it never landed, and
    withdraws any other ask of the change request still live. No delivery is claimed: all of this is
    idempotent, so a call that failed half way is finished by the mailroom's retry.
  - **The end.** Its merge or close withdraws them the same way, and a suite that already settled
    keeps its verdict. Nothing else ends a push request: the minute sweep never treats one as
    abandoned. A head someone already checked at the same identity opens green at once, with no pod
- a person's ask from their own machine (`ryph checks` in `@ryph/cli`, or its MCP server), before
  any change request exists: a request of kind `local`, with no run and no patch, its asker in
  `check_requests.user_id`. It never gets a forge row: the push request of the pull request opened
  later on the same commit and base reproduces the identity (both are runless), joins the suite, and
  reports it at once, with no pod. A rebase before opening makes a new commit and runs again. Two
  ways to name the commit:
  - `POST /v1/check-suites` `{repo, commit, branch, base?, checks?}`: the commit is on the forge, on
    `branch`. Before anything is filed the branch's head is read live from the forge
    (`POST /v1/service/branch-head`), and the commit must be it: a commit named by id would
    otherwise run, or join a suite of, whatever the forge's cache holds, a fork's included. Not the
    head, or no such branch: 409, telling the person to push it or upload a bundle (on Radicle only
    a delegate-canonical branch is found, so a contributor's own branch takes a bundle); a forge
    that cannot say: 503. The source is a head on the forge with no change request:
    `{runId: null, changeRequest: null, fetchRef: "refs/heads/<branch>", branchName: <branch>,
    baseRef, url: null}`,
    fetched by id, else through the branch
  - `POST /v1/check-suites/bundle?repo=&branch=[&base=][&check=]...`: the body is a git bundle,
    streamed through to the forge's `POST /v1/service/check-bundle` and never held here. The forge
    verifies it as intake verifies a patch (one ref, `refs/heads/<branch>` exactly, prerequisites
    the base satisfies, refreshing the base once when they do not) and files it under
    `users/<userId>/<branchKey>/<baseKey>/<connectedRepoId>/<headSha>.bundle`, `branchKey` and
    `baseKey` the first 16 hex of the sha256 of the branch's and the judged base's names, so the
    same commit on two branches, or against two bases, is two bundles, each its own branch's and
    base's (the key is derived here too, and one the forge answered otherwise is a 503); the request
    is filed on the `headSha` it answers, with the source
    `{runId: null, userId, bundleKey, branchName, baseRef}`, which the gateway serves exactly like a
    run's bundle. A forge 400 or 413 is the same status here, with the forge's words; anything else
    is a 503

  `repo` is a connected repo's id or its address (`owner/name`, matched case-blind, or the `rad:`
  RID); `base` defaults to the repo's default branch and is normalised as a push's is; `checks` is a
  subset by name, partial as an agent's is, so it never stands in for anything. The gates, in order,
  each before the next reads anything: `checks:request` (a member's; a token may carry it), checks
  and `RYPH_CHECKS_LOCAL` on (404 otherwise), the body or query (400; a branch or base is bare or
  `refs/heads/<name>`, and any other `refs/` spelling or `HEAD` is refused here), the repo connected
  (404 unknown, 409 archived), live `write` on it through the caller's linked identity (as a
  Re-run), a person (break-glass is refused: there is nobody to quota or to show the suite to), and
  room under `RYPH_CHECKS_MAX_LOCAL_PER_USER` (429); the bundle route adds
  `RYPH_CHECKS_LOCAL_UPLOADS_PER_HOUR` (429), counting ATTEMPTS: after every other gate, and before
  the body is read, the upload writes its row of `check_local_uploads` and only then counts the
  person's rows of the last hour, its own included. Over the cap it deletes its own row and answers
  429, so a refusal costs nothing; otherwise the row stands whatever the forge then answers, so a
  bundle it refuses still counts. Recording before counting is what makes the cap hold for uploads
  side by side, on one replica or several: each sees the others' rows, so they cannot all slip under
  it, and at worst all of them are refused and the person tries again (a re-ask on the same branch
  is another upload; a pushed ask uploads nothing and is not counted). The minute sweep drops rows a
  day old. The route runs every gate before it reads a byte of the upload. The answer is
  `201 {suite, request}` once the base is read, which the route waits up to ten seconds for as the
  agent's tool does, `202 {suite: null, request}` while the tick still reads it, and
  `422 {error, request}` when the base refuses it (no checks, a name it does not declare); `request`
  is `{id, state, suiteId, reason?}`. `GET /v1/check-requests/:id` reads one back,
  `{request, suite}`, for its asker or a reader of every task; anyone else gets a 404.
  - **One per branch.** A person's new ask on a repo and branch supersedes their earlier live asks
    there, and cancels what nobody else wants. The same pushed commit, base and checks again answers
    the request standing and gives it another day (`expires_at`), but only when that request is the
    newest-filed on the branch, and the renewal withdraws only older ones: a newer ask is never
    undone by a re-ask of an older commit, which files its own instead. Its day already over, or its
    suite cancelled or unable to run, or the renewal finding it withdrawn meanwhile: a live ask on
    the branch filed after it is the answer, and with none a new request is filed. Only
    `extendRequest` moves `expires_at`, so a resolve writing the row meanwhile never puts the old
    end back, and the minute sweep withdraws an ask only while its stored `expires_at` is still past
    (`withdrawExpired`), so an ask renewed after the sweep listed it stands, as its asker was told.
    Asks on one branch made side by side each look again once their own is filed and keep only the
    newest-filed (by time, then id), so they leave the same one whichever way they interleave, and a
    call whose ask lost answers with the one that stands. The cap counts their asks still going on
    other branches: being read at the base, or on a suite that has not settled. One whose suite
    settled costs nothing and is not counted, though it stands for its day. It is checked before
    anything is filed and again once the new ask is in, before that ask replaces anything: over the
    cap then, the new ask is withdrawn and the answer is 429, so asks on two branches side by side
    cannot both slip under it (at worst both are refused).
  - **A day.** A local request is withdrawn by the minute sweep once its `expires_at` passes, a day
    after it was filed or last asked again, whatever its suite did: one still going is cancelled
    unless someone else wants it, a settled one keeps its verdict
- a person's Re-run on the suite page, or the forge's re-run button: a new generation of any settled
  suite, passed included. A suite whose services could not be resolved reads the base again, and may
  land on another suite of the same head: the runs and patches that asked for the old one, and the
  forge rows reporting it, move to the new one. A read the forge could not answer is retried on the
  tick like any other, and they move when it lands. A suite whose environment build failed asks for
  a new build of its base rather than taking that failure again

Nothing runs for nobody: every minute, the tool requests of runs that ended, the requests of patches
that were superseded or rejected, and local asks a day old are withdrawn, those still being read
included, and a suite no one else asked for is cancelled. A suite a replica holds mid-launch or
mid-settle is not cancelled under it; the next sweep cancels it once it is let go.

A `tree:` suite waits for the newest ready image of exactly its `.ryph/` tree built from the default
branch or from the base branch itself (never another branch's), else one already building, else one
queued with trigger `check`. A check's subject is always its one repo, never a workspace the repo
belongs to, and a one-repo environment's definition is its `.ryph/` tree id as it is
(`definitionKey` in `core/environments.ts`). So the tree in the key is compared with a row's
definition directly. A waiting suite that follows its own build takes a ready image of the same tree
that lands first, and its own build is then called off unless something else waits on it. A waiting
suite that is cancelled leaves its build going, for the next suite to join. A check's build is a
branch build of the base at its pinned commit: it reads the shared layer cache and writes none, it
supersedes no other build, it is never a default-branch image runs pick up, and nothing supersedes
it while a suite waits on it. A build that fails makes the suite `error`; so does waiting a day. A
failed build of the base at that commit is the answer for every new ask there, with no rebuild per
suite; a re-run (the page's or the forge's) asks for a build of its own. When a build would be due
and the builder is not answering, the suite does not wait: it takes the fallback a run takes, the
newest ready default-branch image, else `RYPH_AGENT_IMAGE`, keyed on that image. A suite that was
waiting when environments went off is `error`.

A ready image whose `.ryph/setup.yml` did not finish when it was built (`setupWarnings`, see
[environment-builders.md](environment-builders.md)) is the last choice of both pickers — a `tree:`
suite's and the newest ready default-branch image an `image:` suite takes: a check pod runs
checks.yml's `setup`, never `.ryph/setup.yml`, so its checks would inherit the half-done tree. The
newest image of the same pick whose setup.yml finished is taken instead, even when it is older, and
retention keeps that one ready until a clean build of its branch settles after it. With no such
image the one whose setup.yml did not finish is used, and the note the run is told and the report
the forge is told both say so, naming the repos, so a failure reads as possibly setup's rather than
the change's.

The stages run as the run user (uid 1994, `RYPH_K8S_RUN_USER` on kubernetes), as a run does, and set
no `HOME` or `PATH`: the runtime takes `HOME` from the image's passwd entry for that user (the one
the build baked as) and `PATH` from the image. So a setup step finds what the build baked under the
run user's home (Deno's and other caches) and mise's toolchains on its `PATH`. Where setup runs in a
container of its own (no baked checkout), what it writes outside the tree stays there, so a check
reuses what the image baked, not what setup fetched beyond it. Where setup runs in the check's
container, the check sees all of it.

## 🫙 The check pod

One shared pod per suite, through the `CheckLauncher` port (`ports/check_launcher.ts`): kubernetes
and docker only. Any other provisioner with `RYPH_CHECKS=on` boots with a warning and runs none. A
check declared `pod: own` runs in a pod of its own beside it ([below](#pods-of-their-own));
everything here holds for each pod.

- **Clone** — an init container fetches the head from the git gateway with a key of the suite's own,
  which resolves only while that generation runs and only to that one commit (the candidate bundle
  intake stored or a person uploaded, or for a head on the forge, the commit fetched by id, else
  through its `fetchRef`), and is revoked once the clone is done and again at settle. Git LFS
  objects are not fetched. It prints the changed-paths list (`@@ryph-changed <path>` …
  `@@ryph-changed-end <n>`): what the change touched, from its merge base with the checks commit to
  the head. What the base gained since the head branched is not in it. When the merge base cannot be
  found in the fetched history, the list is unknown. A clone that fails is retried, on another
  asker's source of the same commit when there is one: a run's bundle, a person's, or a head on the
  forge, any way round.
- **Setup and checks** — one container per check, in parallel, with no credential of any kind: no
  run token, no forge credential, no orchestrator address. Where a check works, and where setup
  runs, depends on whether the suite's image baked this repo's checkout:
  - **Baked.** The image is an environment image whose build checked this repo out under
    `/ryph/work`. The orchestrator tells the pod which directory, from the environment row that
    built the image. Each check container moves that checkout to the head in place, as a run's
    adoption does. It first drops the image's remotes, their refs and `refs/replace/`, and keeps a
    ref on the image's commit. Then it fetches the head and the clone's branches from the clone's
    tree, which is mounted read-only, so the clone stays the only stage with the git credential.
    Since the image's commit is a have, the fetch moves only what the head adds to it. It checks the
    head out with `checkout -f`, proves HEAD is the recorded sha, drops every ref but the clone's
    branches, and runs `git clean -x`: every untracked file goes, ignored ones too, except what
    `keep` names. Last it expires the reflogs. Every git command of the move ignores the image's
    global and system git config and attributes, runs under `env -i` with only the variables it
    names, runs no hook and no fsmonitor, uses no transport but the local one, does not recurse into
    submodules, and fetches no Git LFS object. Before anything moves, the checkout's own
    `.git/config` is rewritten to its repository format alone (what a fresh clone's would say), and
    its `.git/config.worktree` and `.git/info/attributes` are removed: no filter, include, URL
    rewrite, line-ending setting or anything else the image left there applies. A repository kept
    elsewhere (`.git/commondir`) or a repository extension the move does not know fails the move,
    and git looks for no repository above the tree. So no git config the image wrote and nothing the
    head adds runs before HEAD is proven. The image's object store and index are trusted, as its
    build output is. The checkout rewrites only the files that differ, so the rest keep their mtimes
    and builds stay incremental. The move also fails when it cannot finish, when HEAD is not the
    recorded sha, or when the tree it leaves may not be the head's: an index entry marked
    skip-worktree or assume-unchanged (a sparse checkout leaves those), or a submodule the image
    checked out at another commit than the head's (or files it left where the head has a submodule).
    A failed move falls back: the baked checkout is removed and the clone copied in its place, cold,
    and the check runs there. What fails a move is usually the image's own, and would otherwise fail
    every suite until the image is rebuilt. Only a copy that fails, or is not at the head, is the
    platform's (`125`). Then the setup steps run there, in order, then the check. Each container has
    its own copy-on-write view of the image, so parallel checks never meet, and only the files a
    check writes take disk.

    Setup runs once per check this way, since nothing one container writes reaches another, and all
    N of them run at once out of the suite's one pool ([below](#-one-memory-pool)), each guaranteed
    1/N of it. In the other shape setup has the whole class to itself. On a warm tree setup is
    cheap. A heavy setup with many checks can be slow, or run the pool short and have the check
    furthest over its share stopped. Then declare fewer, heavier checks, or put the heavy build in
    the image's `setup.yml`, so check setup finds it done — on an image whose `setup.yml` finished:
    one whose did not lacks it, and the suite's note says so.

    The services start right after the clone, beside setup. Setup can reach them, but nothing waits
    for them before it runs; the check waits for them after setup. A service that keeps failing ends
    the suite as the platform's while setup still runs.
  - **Not baked.** The default image, or an environment this repo is not a member of. One init
    container per setup step runs it once, in the clone's tree, with the whole class and no
    services: they start once setup is done. Each check copies that tree to a private one and runs
    there.

  Two shapes rather than one because each is the cheap one for its case: setup in every container
  would make a cold tree install everything N times, and one setup copied N times would copy every
  build output a warm tree has (a Rust `target/` can outgrow the pod's disk on copies alone). Setup
  and checks share an egress claim minted from the **requesting run's** network scope (for a change
  request's head, which no run shipped, the scope an agent with no policy gets), held to the
  deployment's allowlist as it stands at launch; a scope the allowlist no longer covers makes the
  suite `error`.

The verdict is the exit code the backend observed:

| Observed                                                                                                                   | Check                                     |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `0`                                                                                                                        | passed                                    |
| `124` (the entrypoint's `timeout`), or the pod's `DeadlineExceeded`                                                        | timed out                                 |
| anything else (`OOMKilled` is named)                                                                                       | failed                                    |
| a setup step's non-zero exit (`124` too: its share of the pod's deadline)                                                  | setup failed, for every check of that pod |
| with a baked checkout, a setup step's non-zero exit in a check's container (its own `124` and `125` as `1`)                | failed, for that check                    |
| a check that used more disk than its share (the launcher answers `1`, with that reason)                                    | failed                                    |
| `122`: stopped when the pod's memory pool ran short, as the check furthest over its share (setup in its container too)     | failed, with that reason                  |
| not baked: a setup step still running at the pod's deadline (on docker, where no deadline kills it)                        | setup failed (`124`)                      |
| baked: a setup step still running at the pod's deadline, in a check's container                                            | timed out                                 |
| `125` from any stage, a setup step with no exit code, a pod evicted, preempted or lost, a pod that never starts its checks | the platform's: relaunched                |

A command's own `122`, `124` and `125` are reported as `1`: those codes are the entrypoint's. The
platform's failures, a clone that failed, a pod that could not be scheduled or disappeared, and a
launch that threw are retried twice, then the suite is `error`. A suite is not relaunched once one
of its checks failed on its own account, on any of these paths, since a relaunch would only repeat
it, nor on its last attempt: the suite then settles with each check's own verdict, the checks
without one are `error`, and the suite is `failed` if any check failed on its own account. The same
holds when the platform gives up on a suite: a pod that could not be read past its deadline, or the
last attempt used up. Nor is a suite relaunched once every check has its own verdict: it settles on
them.

A check's verdict is recorded as soon as its container exits with its own answer: an exit from `0`
to `127` (`125` aside), a timeout, or out of memory. Its row, its log and its forge check run
complete while the other checks still run. A platform fault waits for the suite, and so does any
other kill by signal (`137` with no reason but `Error`, say): the pod's own reason may not have
landed yet, and a pod-level kill is not the head's. A verdict recorded once stands for the
generation. The suite's settle reuses it without reading the log again, a relaunched pod leaves the
check out, and a suite the platform gives up on still shows it. A check that failed early blocks a
relaunch as one failing at the end does. The suite's own state, the run's message and the Radicle
job run still wait for every check. The early write is not leased; the store never replaces a
settled result, so two replicas reading one finished container keep the first write, and both store
the same log.

Suites outlive the replica that launched them: the launch is a compare-and-set with a lease, the
backend record is named `ryph-check-<suite>-g<generation>` (and an own pod's
`ryph-check-<suite>-g<generation>-o<n>-<check>`, below), and whichever replica ticks next polls that
record — it adopts a running pod rather than launching a second. Settling is leased too. Logs (4 MiB
per check) are stored beside build logs under `checks/<suite>/<generation>/`, as plain text, with
the terminal escapes a tool printed taken out. Anything shaped like a credential (a URL's userinfo,
an egress claim, an `Authorization` value) is redacted. Then the rows are stored, then the verdict;
the record is discarded last. Records no running suite owns are swept every minute. A backend that
cannot be read decides nothing until the pod's deadline and twelve minutes more have passed, counted
from the launch (a pod may wait ten minutes to be scheduled, and its deadline counts from its
start); then the suite is `error` and its slot is given back.

The redaction is best-effort. It matches shapes, because the replica storing a log is not the one
that minted the pod's credentials: a pod that re-encodes one (`echo $HTTPS_PROXY | base64`) prints
something no shape matches. What bounds that is what either credential reaches: both are
short-lived, and neither reaches more than the requesting run could; for a change request's head,
which no run shipped, no more than an agent with no network policy may.

The changed-paths list is trusted only when it adds up: a list holding fewer paths than its end line
counts (its front cut from the log), a path git quoted that does not unquote, or no list at all, is
**unknown**, and the note and the check run say so rather than read it as "nothing changed". The
paths are the head's, so matching them is bounded: every check's globs are matched in one pass over
the list, a path longer than 1024 characters or deeper than 64 directories is not matched, and the
whole pass has a fixed budget. A path skipped, or a budget spent, makes a "no" unknown; a match
found stays a match.

### Pods of their own

A check whose memory or time does not fit beside the others, one that needs about the whole class
while its share of the pool is a quarter of it, say, is declared `pod: own` (at most 3 per file, so
each own pod and the shared pod take a slot of `RYPH_CHECKS_CONCURRENCY`, default 4; the `ryph`
binary on docker runs two, where a file needing more fails and the repos view flags it). It then
runs in a pod of its own, alone: its own clone (with a git key of its own) and its own setup steps
(the same steps, cheap on a baked checkout), only the services it names, its own deadline (the setup
budget, its timeout and the grace), and the pod's memory to itself. Its share of the pool is the
whole pool, so the pool watcher never stops it: what holds it is the pod's own limit, and on docker
and on kind (runc) a lone check that uses more is OOM-killed by the kernel (exit 137, `OOMKilled`,
reported as out of memory). Its size is its `size`, else the shared pod's. The shared pod keeps
every other check and only the services they name; when every check is `pod: own`, there is no
shared pod. A declaration without `pod: own` is the one shared pod it always was.

`size` is honoured only for a class the operator lists in `RYPH_CHECKS_OWN_SIZES` (and the
deployment defines: a listed class it does not define refuses the boot). With the list empty, the
default, every `size` fails its suite. The refusal is a check's public output on the forge, so it
names the variable and not the classes. An own pod without `size` gets the shared pod's size, which
is the operator's (`RYPH_CHECKS_SIZE`, else the repo's), and is always allowed.

Each pod is a record of its own, `ryph-check-<suite>-g<generation>-o<n>-<check>`: `n` is the check's
place among the file's own checks, and the check's name is cut to what fits the 52 characters every
launcher takes (none of it is left at a long enough generation). The place keeps every record and
every docker object (`<record>-<stage>`) of one pod apart from every other pod's, whatever the
checks are named. Launch checks every pod's name and makes every pod's spec before it launches any,
so a refusal launches none; a launch that fails part way discards the pods it made, the one whose
launch threw included (a Secret it half made), while its claim still holds. A pod whose every check
is already **answered**, any settled row (`error` included): a pass reused from another suite of the
commit, or a pod this generation already settled, is not launched again and holds no slot, in the
launch, the slot count, the poll and the orphan sweep alike; a re-run starts afresh. A partial suite
naming only an own check launches only its pod.

The suite is one suite, with one generation and one verdict, but each of its pods lives its own life
(`pollPods` in `core/checks.ts`, its life in the suite's `pods` column: attempts, launch time, clone
key). Only an **open** pod, one with a check still without its settled row, is read:

- A pod's checks settle as soon as **that pod** is done: their rows written and their logs kept,
  signal kills and the platform's exits included, its key revoked, and the pod discarded and never
  read again. So a finished pod may vanish (a Job's TTL, a node scaled down) while another runs, and
  costs nothing: its slot is free for the next suite at once.
- A pod the platform failed, **gone**, **unschedulable**, whose **clone failed**, cut short in a
  setup step with no exit code or the platform's own, or with a check the platform could not run,
  **relaunches alone**, with a clone key of its own, while the others run on. Its attempts are its
  own: the third failure, or any once one of its own checks failed on its own account (which a
  relaunch would only repeat), ends its checks without a verdict `error`, the suite's reason naming
  the pod (`e2e's own pod could not be scheduled with size class large (after 3 attempts)`; the
  class is named only when the check's own `size` asked for it, the operator's choice never is). A
  container that cannot start (an image that will not pull) is named in the kubelet's words; the
  scheduler's message, which names the cluster's nodes and taints, goes only to the operator's log
  (`checks.unschedulable`), on a single pod as on several. A relaunch that finds the suite's image
  gone takes the whole suite back, as a launch that finds it gone does: every pod discarded, the
  build retired, and the suite waits for its environment's next image, keeping the verdicts it has.
  A failed setup step's log is kept under `_setup` for the shared pod and `_setup-<check>` for an
  own pod, with or without other pods: names no check can have.
- A **setup step that failed on the head's account** fails the checks of its own pod only: they are
  `setup failed`, with the step's log as theirs. The other pods run on, and the suite is `failed`
  once they are in, its reason naming the pod (`setup step 1 failed in e2e's own pod (exit 1): …`).
  On a single pod a setup failure still fails every check.
- Each pod is held to **its own deadline**, counted from its own launch. Past it, a pod the backend
  cannot read has its open checks `error`, a pod still in a setup step has that step's hang
  (`setup failed`), a pod not yet at its checks the platform's failure to run them (`error`), and a
  pod at its checks settles from what they show. Before it, a pod the backend **cannot read**
  decides nothing, about itself only: what the other pods say is recorded on every poll, and a check
  that answered keeps its verdict and log whatever becomes of the unreadable pod.
- Each pod's clone key is revoked once **that pod** is past its clone (and its life says so, so
  once), and all of them at the settle. A single pod's launch writes its life too, of which only the
  key is read. Every revoke of a suite's keys is of one generation, so a settle, a requeue or a
  cancel racing a re-run never takes the next generation's key.
- The suite settles once every check has its row, its verdict from all of them, its reason each
  pod's in turn.
- Progress (a check started, a check's own early verdict, a key revoked) is written unleased, as a
  single pod's is. The `.ryph/` answer is stamped unleased too, and is the one suite write that
  leaves `version` alone (every whole-row write keeps a stamp over its own null), so it never costs
  a lease holder its write. A single pod past its clone revokes the key its life names, by id, and
  clears it by compare-and-set: a stale read takes only that key, never a successor's. A pod
  settled, relaunched or discarded happens under the suite's lease, taken by a compare-and-set on
  the row exactly as that poll read it, its `version` included (one more on every write, in SQL, so
  two writes in one millisecond still differ): a replica whose read is older than another's act
  takes nothing, so no pod is relaunched twice or discarded under another replica's launch of it. So
  does revoking every key of the generation for a pod adopted with no life written, one pod or
  several, which would otherwise take a key another replica's relaunch just minted. A relaunched
  pod's life (its key, attempt and launch time) is written the moment it launches, under the lease;
  a pass whose write finds the lease lost revokes the keys it minted since its last write. The
  settle and every other transition name the version they read too, so a stale read never overwrites
  a pod's reason. A launch found interrupted or a pod failed the platform's way (one pod, or the
  interrupted launch of several) takes the lease the same way before anything is discarded or any
  key revoked, so a stale read never tears down another replica's relaunch. Replicas from before
  `version` never bump it: do not run old and new control planes side by side for longer than a
  rollout.
- A requeue, an environment wait, an adoption and a new generation clear the open pods' lives: the
  next launch starts them afresh. A done pod's life stays, so its reason reaches the suite's.
- A cancelled or settled suite discards every pod; the orphan sweep keeps a running suite's open
  pods and takes any other record, a done pod whose discard failed included.

## 🔁 The tick

Every replica ticks every 10 seconds; a lock lets one of them work at a time. A tick, in order:

1. **Launch** into the free slots, fairly: the repos with a suite queued take turns, each repo's
   oldest first, and while another repo has one queued a repo launches a suite only if the slots it
   holds and the pods the suite brings stay within half the slots (`RYPH_CHECKS_CONCURRENCY` / 2,
   rounded up). A suite of more pods than that half launches only while its repo holds none, or it
   would never run while anyone else waits. With nobody else waiting, one repo may use them all. A
   slot is a pod: a suite holds one per pod it has running (the shared pod and each `pod: own`
   check's), and gives each back as that pod is done; a pod a reused pass spared a launch holds
   none. A suite launches only when every pod it has to launch fits the free slots together. One
   next in turn that does not fit yet stops the pass, so no suite behind it, of any repo, takes the
   slots it waits for, and a suite of several pods is never starved by suites of one. Its images
   start pulling while it waits, so they are in when its slots are. One whose image is still pulling
   when its turn comes holds no slot: those behind it may launch while it pulls, rather than every
   repo waiting on one pull. A suite with more pods to launch than `RYPH_CHECKS_CONCURRENCY` can
   never fit, and is `error`, its reason naming the variable and how many pods it needs, never the
   value; the repos view (`GET /v1/checks/repos`) says so of the file before anything is pushed. The
   trade-off: a suite that needs every slot waits until the running pods drain, which can hold every
   launch for a while; that is what keeps a big suite from starving behind small ones. The early
   pull happens only where the launcher pulls itself (docker); on kubernetes the node pulls at
   launch.
2. **Poll** every running suite, and settle what finished.
3. **Tell** the runs whose suites settled.
4. **Waiting** suites move along their builds, from the database alone, a page of 50 at a time by id
   and the next page on the next tick: a build that is ready queues the suite, one that failed ends
   it, and a suite waiting over a day is given up on. One with no build to wait on yet is left for
   the forge.
5. **The forge**, two passes side by side, each under its own budget of 90 seconds per tick and four
   at a time, so a forge that hangs in one never costs the other its tick:
   - the waiting suites' reads of their bases' `.ryph/` trees, to queue a build; suites of one base
     go one after another, so they ask for one build. A read that failed (or timed out) is not tried
     again before a backoff of as long as the suite has waited, from 30 seconds up to 30 minutes
   - requests read at the base, then reports, the rows of one head one after another, so two patches
     of one commit never post the same check runs side by side

   A budget is looked at before each item, so a call already started runs to its own timeout (two
   minutes for a read or a report). Whatever is left waits for the next tick; a waiting suite whose
   read was left is read when its page comes round again.

Nothing before the forge passes calls the forge, so a forge that hangs never holds up a settle. That
also keeps a verdict from being lost: the backend deletes a finished Job an hour after it ends, and
a poll reaches it within a tick or two.

## 📣 Who is told

- **The run** — a platform message in its inbox once per generation, with each check's state and the
  fenced last lines of every failing check's output. The message carries no payload. It is marked
  told once it is in: a post that failed is tried again. `GET /v1/runs/:id/checks` answers
  `awaiting` beside the text, how many verdicts are owed, and `?awaiting=1` answers `owed` alone,
  which they are: the suites the run's own tool requests and patches will still be told about
  (`core/check_awaiting.ts`), one per suite, and each request still being read. Each is named — a
  suite as `<suite id>@<generation>`, a request being read by its id — with the ids of the run's
  requests owed it, which a request keeps from the ask to the verdict. It is empty only once every
  such message is in. The runner reads it at every stop: a run that asked for checks or submitted a
  patch is held when the agent stops until nothing is owed that it still waits for (75 minutes per
  wait), and the agent gets the verdict as one more turn. A wait that runs out gives up on the
  verdicts it named, for good: one that reports late leaves the list, one that never does is never
  waited on again, and only a new request or patch holds again, for its own verdict alone. The hold
  keeps the idle clock from ending the run, and a `ryph__finish` does not end it while a verdict is
  owed: the tool says the checks are still running, the verdict arrives, and the next stop ends the
  run with the finish's outcome and summary unless the agent reports again. The agent is asked to
  get checks passing before it submits: commit, `ryph__run_checks`, stop, fix and repeat, then
  `ryph__submit_patch`, whose suite joins the passing one. That is an instruction only; a submit is
  never refused, and the hold covers a run that submits first. The prompt also lists what each
  repo's checks run: `GET /v1/runs/:id/checks/declared` answers `{declared, unread}`: `declared`
  holds each connected repo's setup steps and checks (name, command, timeout, services) read at its
  base (`declaredForRun`), and `unread` the paths of the repos whose read did not answer
  (unavailable, an error, past the deadline), so the runner can say their checks are unknown rather
  than absent. A repo with no checks file is in neither. When the run's repos could not be listed at
  all, `unread` is `["*"]`; with checks off both are empty. It is a route of its own so the spec
  fetch never waits on the forge; the spec carries only `checks.enabled`. The read is bounded at 15
  seconds in all: each repo races that one deadline, so a slow repo costs only itself, and the route
  never fails because of the forge. One read of a repo at a ref answers every run that asks within a
  minute, the read still going included, so a burst of boots reads it once; a read the forge could
  not answer is not kept. The list says to run a check through `ryph__run_checks` rather than by
  hand, the checks the change most likely breaks first and all of them before a submit
- **The forge** — one row per asker the forge hears about (`check_forge_reports`): a submitted
  patch's, or a push request's, each keyed by an id of its own and holding the base its asker is
  read at. When a patch is submitted, or a push request is made (its head is on the forge already),
  every check is posted `queued` once its names are known, then updated as the suite moves. GitHub
  gets a check run per check (`ryph / <name>`, `external_id` `<suite>:<generation>:<name>`); Radicle
  a run on the commit's job. A suite that could not run is `action_required` with the suite page as
  `details_url`, or `failure` without `RYPH_APP_URL`. A head with no checks posts nothing, which
  leaves a required check "Expected". An App without `Checks: write` answers `unsupported` and is
  not asked again for ten minutes. While an asker's own request is still being read, the head's
  newest full suite read at the same base is reported for it, and its own takes over once it
  resolves. A push request that a newer push or the change request's close set aside is reported
  until its own suite's current generation has posted its settling (a cancel, usually), since that
  head is no longer the change request's; a re-run of that suite is a new generation, and is
  reported. One that only ever showed another suite of its head stops with what it last posted. A
  suite that moves while its report is in flight is reported again, and a report in flight never
  moves a row back off the suite a re-run moved it to. A partial suite is never reported, and never
  stands in for an asker's own. A local ask has no row: its suite reaches the forge only through a
  push request that joins it
- **Radicle** — one run per suite generation, found again by its log URL. It is finished `Succeeded`
  only when every check passed. A cancelled suite is reported `cancelled`, with no conclusion: it
  neither passed nor failed, so its run is not finished as failed. A suite the platform could not
  run (`error`) is finished `Failed`. When a new generation starts while the old one's run is left
  going — its settled report never landed, or it was cancelled — the new report names the old
  generation (`suite.previousGenerations`) and the old run is finished `Failed`; GitHub ignores it,
  since the newer check runs of the same names take their place. An old generation whose checks all
  passed is not named, so a pass is never finished as a failure: its run is left going.
- **The run, looking up** — `ryph__check_status` names each repo's checked-out head, or one commit
  the agent asks about, and answers the suites on it the run may read beside its own, so a run
  reviewing a change request sees the checks its pushes got. `ryph__check_log` saves one check's
  whole log (`GET /v1/runs/:id/checks/:suite/log`) to a file in the pod for the agent to read with
  its shell: the one place a check's output reaches the agent unfenced, as a file it was told is the
  check's own words, never as a message. A run reads its own task's suites (its runs' asks, its
  patches), and, on a repo its task checks out, suites a change request's push, the forge's re-run
  or a patch that reached the forge asked for: a commit anyone holding the repo can fetch, so what
  its checks printed tells the run nothing its clone does not. Never another task's `run_checks` or
  unpublished patch, which is that task's unshipped work, nor a person's local ask. A suite outside
  that answers as one that does not exist. A run that may not open patches is told checks are on for
  this, and runs none.
- **People** — the suite page (`/checks/<id>`), the run page and the approval queue, which shows the
  suite the patch's forge is told about. A suite, its logs and its Re-run are visible to a caller
  who reads every task (`tasks:read-all`); to readers of a task that asked for it, or of the task
  whose patch it judges; to the person whose local ask asked for it (active, or superseded since);
  and, for a suite a runless ask wanted (a push, a local ask), to anyone with write on its repo, the
  bar for putting that head there at all (the scope's `writableRepoIds`, the forge's answer cached
  as task scoping caches it). Anyone else gets a 404. `repos:read` is every connected repo's at
  once, private ones included, and a log is head-authored text, so being a repo reader is not enough
  (its Re-run also takes `patches:review` and write on the repo). The checks page (`/checks`) reads
  three lists, each behind `repos:read`, scoped the same way, and empty with checks off:
  - `GET /v1/check-suites?repo=&state=&asked=&cursor=&limit=` answers `{suites, nextCursor}`, newest
    first (default 50, at most 100). `state` is `any`, `failing` (failed or error), `passed` or
    `active` (not settled); `asked` is `anyone`, `tool`, `patch`, `push` (a push to a change
    request), `forge` (a re-run, by a person or the forge's button) or `local` (a person's ask from
    their machine). Every filter and the scope are in the store's query, so a page is full whenever
    more suites match. Each item carries the suite's view, the branch its head was pushed on, and
    `askedBy`: the task (by title) for a run's ask, the change request for a patch's or a push's
    (`#12`, or a Radicle patch's short id, linked on the forge when it gave a URL), "Run again",
    "Re-run on GitHub/Radicle", and "<name> · local" for a local ask (the name the person had when
    they asked, else their id). A push's branch is `pull/<n>/head` or `patches/<id>`; a local ask's
    is the person's branch. A task the caller cannot see is left out of `askedBy`, and its run and
    patch out of the view's `requestedBy`. A listed view carries no `logTail`s: the suite page reads
    them
  - `GET /v1/checks/active` answers `{active, capacity}`: up to 50 suites not yet settled, and
    `{inUse, total}`, the pods running (what the launch pass counts) of `RYPH_CHECKS_CONCURRENCY`.
    The slots are the deployment's, so `inUse` counts suites the caller cannot see. A view's checks
    carry `pod` and `size` as declared
  - `GET /v1/checks/repos` answers `{repos}`: every connected repo, its checks file on the default
    branch (`declared` with setup, checks and `podsNeeded`, the pods a full suite of it runs at
    once, plus a `warning` when that is more than `RYPH_CHECKS_CONCURRENCY`, so such a suite would
    fail; `none`, `invalid` with the error, or `unread` with why), read through the same one-minute
    cache and 15-second deadline as `declaredForRun`, and `latest`, the newest full suite the caller
    can see that read its checks on the default branch. Enabled but unable to run, each file is
    `unread` with why. The file is shown to any repo reader, as the environment definition is: it is
    the repo's own configuration, while `latest` stays scoped

## ⚙️ Operator knobs

### Instance-wide remote backend

Set `RYPH_CHECKS_REMOTE_URL` and `RYPH_CHECKS_REMOTE_TOKEN` together to delegate checks to another
instance. The URL is its base URL (an optional path prefix is supported); the token is an
operator-managed API token (`ryph_pat_…`) minted on that instance, not a repository setting. Neither
is read from `.ryph/`. `RYPH_CHECKS=on` is still required: configuring the backend does not enable
checks. Pairing and URL validation happen at startup even when checks are off.

Use HTTPS, except for loopback development addresses (`localhost`, `127.0.0.0/8`, `[::1]`), where
HTTP is allowed. Embedded URL credentials, queries, fragments and malformed URLs are refused. A URL
with this instance's known public/app origin or local listening origin is refused, including
loopback aliases; operators must also avoid self-routing through DNS aliases or proxies that cannot
be detected from configuration alone. The token must be non-empty visible ASCII, without whitespace;
it is never logged or injected into check containers.

Remote mode needs no local check launcher: Docker capability negotiation does not require checks,
and no Kubernetes check launcher is built. Runs and their environment builds keep their local
provisioner and environment services; this setting changes only checks. With the remote pair absent,
the existing local checks backend is unchanged. There is no local fallback when the remote is
unavailable: the request retries and reports an infrastructure error rather than changing its judge.
While it waits, the run is told why from B's status alone, never its body (`remoteChecksNote`): B's
per-person limits (a 429: `RYPH_CHECKS_MAX_LOCAL_PER_USER`, `RYPH_CHECKS_LOCAL_UPLOADS_PER_HOUR`,
both counted against the token's owner), a refused token (401/403), or B unreachable. Every
delegated check of an unpushed commit uploads a bundle, so size B's hourly upload limit for runs
that work on several branches.

Configure the receiving instance **B** first:

- Connect the same repositories (matched by forge address, not instance-local repository IDs).
- Enable checks and local requests (`RYPH_CHECKS=on`, `RYPH_CHECKS_LOCAL=on`). B must have a working
  local check backend; chaining remote backends is refused.
- Mint an API token holding `checks:request` and `repos:read` (on B's account page, under API
  tokens), owned by a person with live write permission on those repositories. Store it only in A's
  deployment configuration/secret store.
- Keep B connected to the forge and receiving its change-request events, with
  `RYPH_CHECKS_CHANGE_REQUESTS=on`. **B owns forge reporting.** A does not process push-triggered
  checks or publish competing check statuses while remote mode is configured. B's normal forge event
  handling joins prior delegated results when the suite identity matches.

For example, on the sending instance **A**:

```sh
RYPH_CHECKS=on
RYPH_CHECKS_REMOTE_URL=https://checks.example.com
RYPH_CHECKS_REMOTE_TOKEN=ryph_pat_…
```

B reads the target branch's check declaration and chooses its own environment images, services,
resource limits and network policy. A sends exact committed heads, streaming verified bundles for
unpublished work, and mirrors results for its runs and patches. Both instances must support the
delegation API (upgrade B first). Multiple requests sharing a token have independent identities, but
share that person's request/upload quotas on B. Remote credentials never enter a run or check
container. Cancelling a delegation withdraws its waiter, not other requests sharing B's suite.

This first version is instance-wide (no per-repository routing). Explicit re-runs of a remote suite
are performed on B; A refuses rather than pretending to restart a cached verdict. Full logs are read
from B, so its availability and retention apply. Keep the remote endpoint configured until
outstanding delegations have settled or their cancellation has been acknowledged. Likewise, drain
existing local checks before enabling remote mode: it does not migrate already-launched local pods.

| Variable                             | Default | Meaning                                                                                                                                         |
| ------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `RYPH_CHECKS`                        | `off`   | `on` runs checks. On means head code from any connected repo runs in pods on your machines                                                      |
| `RYPH_CHECKS_TIMEOUT_MAX`            | `3600`  | Seconds: the ceiling every declared timeout is capped at                                                                                        |
| `RYPH_CHECKS_CONCURRENCY`            | `4`     | Check pods running at once, deployment-wide (`pod: own` checks count one each); at most 50. The `ryph` binary on docker defaults it to `2`      |
| `RYPH_CHECKS_CPUS`                   | `auto`  | Docker: the most cores any one check, setup or clone container may use. `auto` is half the daemon's, `off` no cap; else a cpu quantity          |
| `RYPH_CHECKS_MEMORY`                 | `auto`  | Docker: the most memory any one check, setup or clone container may use. `auto` is half the daemon's, `off` no cap; else a quantity like `6Gi`  |
| `RYPH_CHECKS_MAX_PER_RUN`            | `60`    | Suites one run may ask for through `ryph__run_checks`                                                                                           |
| `RYPH_CHECKS_SIZE`                   | —       | The size class check pods get. Unset: the repo's class, else the default. A `pod: own` check's allowed `size` wins for its pod                  |
| `RYPH_CHECKS_OWN_SIZES`              | —       | Comma-separated size classes a `pod: own` check may name in `size`; each must be in `RYPH_RUN_SIZES`, once, or the boot is refused. Unset: none |
| `RYPH_CHECKS_CHANGE_REQUESTS`        | `on`    | With checks on, a push to any change request of a connected repo asks for its checks. `off`: only runs, patches and re-runs ask                 |
| `RYPH_CHECKS_LOCAL`                  | `on`    | With checks on, a person may ask from their own machine (`ryph checks`). `off`: the local ask routes answer 404                                 |
| `RYPH_CHECKS_MAX_LOCAL_PER_USER`     | `4`     | A person's local asks still going at once on other branches, across repos                                                                       |
| `RYPH_CHECKS_LOCAL_UPLOADS_PER_HOUR` | `30`    | Bundle uploads one person may attempt for local asks in an hour, refused ones included; pushed asks are not counted                             |
| `RYPH_CHECKS_REMOTE_URL`             | —       | Another instance's base URL: delegate every suite to it ([above](#instance-wide-remote-backend)). Needs the token                               |
| `RYPH_CHECKS_REMOTE_TOKEN`           | —       | An API token minted on that instance, holding `checks:request` and `repos:read`. Needs the URL                                                  |

Checks also need `RYPH_GIT_GATEWAY_URL` (where the clone dials), a forge (`RYPH_FORGE_URL`) and
`RYPH_AGENT_IMAGE`; without one of them the boot log names what is missing and nothing runs.
`RYPH_APP_URL` gives the forge a details page. Logs go to the same store as build logs
(`RYPH_PATCH_STORE`).

## ☸️ Kubernetes

- **RBAC** — the provisioner's Role in `ryph-runs` gains `jobs: list` and `pods/log: get` beside
  what runs already use (`deploy/helm/ryph/templates/runs.yaml`).
- **NetworkPolicy** — check pods carry `app.kubernetes.io/component: check-run` and get their own
  `check-run-egress`: DNS, the forge's git port (the clone) and the egress proxy. No rule for the
  control plane, the historian, the model proxy or the MCP gateway. The forge's and the proxy's
  ingress admit `check-run`.
- **Deadline** — on the pod, so a check the deadline kills keeps its pod, its exit code and its log;
  the Job's own deadline is 15 minutes later, as a backstop.
- **CPU and memory** — every check container requests its share of the class and is limited to the
  same share; their limits sum to the class, which is the pod's cap under gVisor
  ([One memory pool](#-one-memory-pool)). The clone and setup containers request and are limited to
  the whole class, one at a time. No pod-level resources (`spec.resources`): under gVisor a pod that
  has them is held to no cap at all.
- **Disk** — every check container's ephemeral-storage limit is (the class's ephemeral storage − 1
  GiB per service) ÷ N, and the clone's `emptyDir` gets `sizeLimit` = that total ÷ (N + 1).
  - Not baked: the tree is needed `N + 1` times after setup (the clone and one copy per check). Each
    check's copy is an `emptyDir` of its own with the same `sizeLimit` as the clone's.
  - Baked: there are no per-check volumes. A check's tree is its container's writable layer, held by
    its container limit along with its log. Only what the move, setup and the check write counts,
    but overlay copy-up is whole-file: a baked file a build rewrites counts in full.

  A volume or a container that outgrows its limit evicts the pod, and the check (or setup step) it
  belonged to fails on its own account with exit `1`. So does the pod going over its total once the
  clone is done, which fails whatever it cut short. The clone going over stays the platform's. An
  eviction for any other reason is the platform's.
- **Services** — restartable init containers placed after the setup steps (after the clone, with a
  baked checkout, where setup runs in the checks before they wait on them), so **setup gets no
  services**; a check that needs a database gets it, setup that needs one should move into the
  check. They carry no startup probe: a check waits up to 180 seconds for its services and then
  exits `125`, and a service that restarted twice ends the suite early. A service the checks need
  and the runs do not is marked `checks_only: true` in `services.yml`: runs leave it out, checks
  start it like any other
  ([service-containers.md](service-containers.md#checks_only-a-service-the-checks-need-and-the-runs-do-not)).

On docker, a suite's images (the environment's and the services') are pulled before it launches, in
the background, so a cold pull never holds up the other suites: the suite waits in the queue,
holding no slot and spending no attempt, until they are in. A pull is killed after 30 minutes, and
one that fails is a failed launch attempt naming why, for every suite on the image; each suite\'s
next attempt pulls again. A record counts as launching for 15 minutes; a service that stopped ends
the suite early.

## 🫗 One memory pool

A suite's checks run at once, and share the suite's memory as one pool (a pool per pod: a `pod: own`
check has its pod's to itself, and the watcher never stops it, [above](#pods-of-their-own)): the
size class's memory on Kubernetes, `RYPH_CHECKS_MEMORY` (or the class's, if smaller) on docker. Each
check has a **share**, the pool split evenly (with N checks, 1/N), and that is what it is
guaranteed. Above it a check may borrow whatever the others leave (under gVisor only: not on docker
or runc, below). When the pool runs short (90% of it in use), the check furthest over its own share
is stopped: TERM, then KILL 3 seconds later, and it fails with exit `122` and the reason "was
stopped when the suite ran short of memory, as the check furthest over its share (its share of the
suite's pool)". Its log ends on a `ryph: stopped:` line with what it used, its share and what the
pool held. A check within its share is never stopped for the pool, whatever the others do. Ties go
to the first name.

ryph polices the pool itself because the backend cannot:

- under gVisor (GKE) a container's own cpu and memory limits are ignored. The only cap is the pod's,
  the sum of its containers' limits, and a pod over it is OOMKilled whole: every check at once, with
  nothing to say whose memory it was. Writes to a check's own filesystem count as memory there, so a
  baked check's tree is part of its use

So on Kubernetes each check container requests and is limited to its share of CPU and memory: under
gVisor that limit holds nothing on its own, so a check borrows above it freely, and the limits' sum
caps the pod at the class (plus the services' own). On a cluster without gVisor (runc) the kernel
holds each check to its share, and a check over it is OOMKilled alone, which is the failure the pool
exists to give anyway. On docker each check container gets all of the suite's cpus (`--cpus` at the
cap: contention for cpu only shares it, nobody is killed) and its share of the memory (`--memory`,
with `--memory-swap` the same, so it cannot swap past it unseen): the kernel kills a check over its
share alone, so there the watcher runs but never fires. Docker has no limit for a group of
containers, and a watcher is not one either (below), so a check is not let past its share there.

A watcher in every check's entrypoint does the rest. Every second it reads its own container's
memory use from its cgroup (v2 `memory.current`, or v1 `memory.usage_in_bytes`, less the page cache
it can drop) and writes it to its own directory of the pool, `/pool/<check>`. Each check has one: an
`emptyDir` `pool-<check>` (`sizeLimit` 64Ki; filling it fails that check as its own disk) or the
docker volume `<record>-pool-<check>`, mounted read-write in that check's container alone and
read-only in every other check's. No check can write anywhere another check's watcher writes. The
watcher then sums its own use with the files of the suite's other checks (their names come in its
env; a directory under any other name is ignored, and a list without its own name runs it
unwatched), ignoring any more than 10 seconds old. Whether it is the one to stop it decides on its
own numbers alone: its use as it just read it, its share from its env, which is every check's share.

A sibling still chooses what is in its own directory, so what is read there is only what the sibling
says. One reader child per tick reads every file in turn, opened read-only and read only when the
open file is a regular file (asked of `/proc/self/fd` where there is one), 80 bytes at most (counted
by `head`, so a sparse file of NULs or a device swapped in costs no more), and counted only as two
plain numbers; it is killed after a second, and the first name it reads moves on each tick, so a
FIFO costs only the files after it, that tick. So a sibling can lie about its own use, and no more:
a huge claim makes it the furthest over itself, so no other check is stopped for it; a claim of
exactly its share adds no more than it was entitled to. It can leave the others less room to borrow,
but never make a check within its share stop.

The stop mark lives in a directory the watcher makes fresh in the container's own `/tmp` (a `/tmp`
that is a link, or a name already taken, runs the check unwatched). The mark is written only once
its TERM reached something running, and names the stage it reached: a stop that lands on what a
finished stage left behind fails no later stage. The watcher runs from the container's start, and
every stage after the stage's mark runs as a process group it can stop: the tree's copy or the move
(and a failed move's copy), the setup steps, the wait for the services, the check. A container whose
memory use cannot be read runs unwatched and says so in its log; its check is never failed for that.
A suite whose class sets no memory (and, on docker, no cap) has no pool and nothing is watched.

CPU is shared the same way without a referee: each check is guaranteed its share and may use idle
cores up to the whole class (under gVisor and on docker; runc holds it to its share). Disk is still
split and held per check (below).

## 🫥 Residual risks

- The command is the base's; what it resolves to (the head's `package.json`, install scripts) is the
  head's. A patch can weaken its own tests and pass honestly. The report says when watched paths or
  `.ryph/` changed, and when that could not be told; it cannot say more.
- Nothing checks that a run asking for a commit uploaded it: the first asker's source (a bundle, or
  a head on the forge) is the suite's until a clone of it fails, when another asker's is used.
- A person's uploaded bundles are not garbage-collected yet: each distinct commit asked about stays
  in the patch store. Both local caps are recorded-then-counted, so asks or uploads racing exactly
  side by side may all be refused, never all let through.
- On docker, egress is not enforced for check pods, as it is not for runs.
- A fork's pull-request head is fetched into the shared cache entry as an unreferenced object, so no
  run's clone is advertised it, but the gateway serves any object it holds by id. Acceptable:
  `refs/pull/*` already makes those commits public on GitHub.
- A change request runs only when its author, and whoever acted on it, may command agents. So an
  outside contributor's pull request gets no checks at all, whoever pushes to or reopens it, and
  neither does a bot's (Dependabot and the like): a required `ryph / <name>` stays "Expected" there.
  The way through is a follow-up: an `action_required` check for an untrusted author's head that a
  maintainer approves to run.
- On Radicle only the patch author's revisions count, as heartwood's own `Patch::latest` has it: a
  revision someone else adds to a patch is not checked, and on a patch ryph opened that means a
  person's revision on top of ryph's is not checked at all.
- Not handled yet: `merge_group` (a merge queue keeps forge CI for it), GitHub's "Re-run all checks"
  (`check_suite.rerequested`), and that maintainer approval for an untrusted author's head.
- With a baked checkout, ignored files built from the image's commit can stand in for the head's: a
  build output the head's sources would make differently, or a dependency the head no longer
  declares, is there unless the build tool notices. Runs make the same trade. The tool (cargo, npm,
  uv) decides what is stale, and a setup step that installs from the lockfile (such as
  `npm install`) brings the dependencies in line. A check that must start clean can run
  `git clean -fdx` itself.
- The memory pool is policed from inside, and the watcher is cooperative, not a boundary. The head
  runs as the same user in the same container as its check's watcher, so it can always kill or
  confuse it, and lie to the other checks about its own use: that takes away its own check's
  protection, and can keep the pool from stopping anyone. What it cannot do is make a sibling within
  its share fail: each watcher judges itself on its own numbers, and each check's pool directory is
  read-only to every other check. The real bounds are the backend's caps: under gVisor the pod's,
  the sum of the share limits (the class) plus the services'; on docker each check's share; under
  runc each check's share.
- The services' sidecars are not in the pool: they are vendor images that cannot run a watcher.
  Under gVisor their own limits are no more enforced than the checks', so a service that grows past
  its limit eats into the checks' room, and the pod's total can still be passed with every check at
  its share.
- The watcher looks once a second. A check that grows faster than that can still take a gVisor pod
  past its total before its watcher sees it, and that is still every check `OOMKilled` at once. Two
  watchers judging a moment apart can, rarely, both stop themselves.
- Not measured yet: pod overhead on GKE, the tree copy per check on a large repo without a baked
  checkout, the disk a large baked build writes per check, the ruleset behaviour with
  `ryph / <name>` sourced to the App.
