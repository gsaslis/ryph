# @ryph/radicle 🌱

**The bridge.** One small Bun service that runs beside an upstream `radicle-node`, shares its
volume, and is **the only process that touches `RAD_HOME`**. It turns a peer-to-peer forge into an
ordinary internal HTTP surface: seed a repository, clone it read-only over smart HTTP, turn a
verified git bundle into a Radicle **patch** (or a new revision of one), read and write issues,
comments and reviews — and, because Radicle has no webhooks, hold a subscription on the node's
control socket and reconcile against storage so that nothing said to us is lost.

Nothing here imports `@ryph/forge` or `@ryph/orchestrator`. The forge dials this service over
HTTP; events leave through the `EventSink` port, and wiring that to the webhook mailroom is the
host's business, not the bridge's.

That is a **deployment**: the bridge's own node, its own key. The `ryph` binary can also run it
in-process over *your* Radicle identity and the `radicle-node` you already run — see
[User mode](#-user-mode).

## 🧭 Two invariants

**Only this process touches `RAD_HOME`.** The key, the storage repositories, the COB cache: one
writer, one pod, one volume. Everything else in ryph reaches Radicle through this port, which is
what makes "the deployment signs with its own key and the key lives in exactly one place" true
rather than aspirational. *Within* the process, every write for one repository serializes on an
in-process per-RID mutex (`helpers/repo_lock.ts`): a submission builds a private scratch repo but
`git-remote-rad` writes the shared `storage/<rid>`, and so do `rad issue open`, `rad cob update`,
a seed, and the git door's mirror rewrite. In-process is enough precisely *because* the bridge is
a single replica — a second one would not need a better lock, it would break the invariant above.

In [user mode](#-user-mode) this is the invariant that bends: the profile is a person's own, and
their `rad` writes it as well. The lock still orders the bridge's own writers; against theirs,
git's ref locks are what keep a single ref from tearing, as they already are against the node.

**Events are a wake-up call; reconcile is correctness.** heartwood's `subscribe` is a bounded
channel: a consumer that falls behind is dropped without being told, and nothing is replayed
after a reconnect or a node restart. So the socket is the *fast path* only. The *correctness
path* is a scan of every seeded repository's COB references against a cursor table, which runs
at start, on every stream EOF (with backoff), and on a timer. If the socket never worked at all,
every comment would still be delivered — just later.

## 🚪 The surface

Internal only. One shared bearer, `RYPH_RADICLE_TOKEN`, on **every** route including the git
door. Ids in a path may be a full 40-hex COB id or any unique prefix of one; an ambiguous prefix
is a `409` naming the ambiguity, never a silent pick.

| Route | What |
| --- | --- |
| `GET /v1/identity` | Our DID, NID, alias, `RAD_HOME`, and the node's reachability |
| `GET /v1/repos/:rid` | The identity document, read live from verified storage — delegates, threshold, visibility, and whether **we** are a delegate |
| `POST /v1/repos/:rid/seed` | `seed{scope:"all"}` + a bounded fetch, then the same document — or a `409 repo_unavailable` when the network handed nothing back (see below). User mode: tracks it, and seeds only what the node did not already |
| `DELETE /v1/repos/:rid/seed` | Unseed. User mode: out of scope at once, cursors and mirror dropped, and only a policy ryph wrote removed — `503` and retried later when the node is down |
| `GET /v1/repos/:rid/git/info/refs?service=git-upload-pack` | Ref advertisement — canonical refs only |
| `POST /v1/repos/:rid/git/git-upload-pack` | The pack stream |
| `POST /v1/repos/:rid/changes` | A multipart bundle + `{title, description, baseSha, headSha, draft?, changeRef?}` → a patch or a new revision |
| `GET /v1/repos/:rid/changes[/:id]` | Materialized change requests, with revisions, reviews, comments and a diff stat |
| `GET /v1/repos/:rid/changes/:id/diff` | The latest revision's diff as **unified patch text**, one entry per file — what a review remark anchors against |
| `GET /v1/repos/:rid/changes/:id/compare?from=<revision>&to=<revision>&mode=diff` | Compare recorded patch revisions in storage; `to` defaults to latest, `mode` is `diff` or `range-diff`. Full revision IDs only, 60,000-byte output cap with explicit truncation, missing commits refused rather than reported as no changes. Not review anchors. |
| `GET /v1/repos/:rid/issues[/:id]` | Materialized issues |
| `POST /v1/repos/:rid/issues` | Open one |
| `POST /v1/repos/:rid/issues/:id/close` | Close one |
| `POST /v1/repos/:rid/{issues,changes}/:id/comments` | Comment; `PATCH …/:commentId` edits, `POST …/:commentId/reactions` reacts |
| `GET /v1/repos/:rid/{issues,changes}/:id/embeds/:oid` | A file the object embeds (a comment's, a revision description's, a review's), read from storage: `{embed: {name, oid, size, data}}`, `data` base64. Only a blob the object itself names (`404` otherwise), at most 5 MiB (`413`). Comments, revisions and reviews list their embeds as `embeds` / `summaryEmbeds: [{name, oid}]` |
| writes with files | `POST …/issues`, `POST …/comments`, `PATCH …/comments/:commentId` and the change submission's `meta` take `embeds: [{name, data}]` (a review takes `summaryEmbeds`): at most 10, each a plain file name and at most 5 MiB, sent base64. Each is written as a blob, named on the action as `{name, content: "git:<oid>"}` and carried in the op's `embeds/` tree (`rad cob update --embed-hash`), the way heartwood stores one itself. The body links it by that oid, as `[text](<oid>)` |
| `POST /v1/repos/:rid/changes/:id/reviews` | A review with a verdict and inline remarks |
| `POST /v1/repos/:rid/{issues,changes}/:id/labels` | Delegates only |
| `GET /v1/repos/:rid/jobs?commit=<sha>` | Every job COB about the commit, unioned, plus our NID: `{node, jobs: [{id, commit, runs: [{node, uuid, log, status, at}]}]}` |
| `POST /v1/repos/:rid/jobs/runs` | `{commit, log, finish?: "succeeded"\|"failed", supersedes?: [log], existingOnly?: bool}` → `{jobId, uuid, status, created, jobCreated}`: find the commit's job (else create it), start a run on it, and finish it when `finish` is given. Idempotent on `(our NID, log)`. Finishing with the reason the run already has is a no-op; a different one is a `409`, and so is a run a duplicate job keeps `rad-job` from reaching. `supersedes` names the runs this one replaces (at most 100): each of ours still started is finished as `failed` first, under the same lock. With `existingOnly`, a log no run has answers `{recorded: false}` and records nothing |

**Delegate-only actions answer a typed 403**, not a 500:

```json
{ "error": "forge_capability_unavailable", "capability": "add_labels", "reason": "…" }
```

An agent can read that and choose something else to do. Radicle reserves labelling, assignment,
and the lifecycle of somebody else's object for a repository's delegates; ryph is normally not
one, and that is the posture we recommend. Everything else — opening a patch or an issue, pushing
a revision, commenting, reacting, reviewing with a verdict — needs no permission from anybody, on
a public repository: every peer writes into its own namespace under its own key.

**A seed the network answers nothing for is a `409`, not a `404`**, and it carries the way out:

```json
{ "error": "repo_unavailable", "rid": "rad:z…", "did": "did:key:z…",
  "command": "rad id update --allow did:key:z…", "seeds": 0, "reason": "…" }
```

The reason it cannot be sharper is Radicle's, not ours. A **private** repository refuses the
whole fetch at the *responding* node (`doc.is_visible_to`, `radicle-node/src/worker.rs`) and the
initiator is told only that the handshake died — heartwood's own golden for it prints `an I/O
error occurred during the fetch handshake (connection reset)`. It is also kept out of every
inventory announcement and its refs are announced only to allowed nodes, so the routing table is
empty too. **From outside, a private repository and one nobody is offering are the same answer.**
So both are said, and `did` + `command` are given either way. `seeds` is the node's `seedsFor` —
the routing answer, what `rad sync` calls "N potential seed(s)" — and above zero it means a peer
*is* offering the repository and refused us, which is the sharper reading. Zero proves nothing.

**The git door is read-only structurally, twice over.** `git-receive-pack` has no route at all.
And what `upload-pack` is pointed at is a *mirror*: a bare repository whose
`objects/info/alternates` borrows storage's object database and whose refs are rewritten on each
advertisement from the canonical `refs/heads/*` and `refs/tags/*`, **plus every change request's
head**, flattened out of the namespace it is signed in and served as `refs/heads/patches/<id>`.
Two peers holding a head for the same change request are resolved in favour of ours. Everything
else — other peers' branches, every `refs/cobs/*` — is not in the mirror to serve.

The patch heads are there because a run commanded from a change request's discussion has to
check one out: a patch's head is a commit in somebody's namespace and never a canonical branch,
so without them there is nothing for the forge's cache to fetch.

## 🧾 Jobs: check suites on Radicle

A ryph check suite is recorded on the commit's **job COB** (`xyz.radworks.job`, radicle-job 0.6.0) —
what Radicle Desktop and the explorer render as CI. One **run per suite generation**, signed by this
node, `Succeeded` only when every check passed, its `log` the suite's page (`<details
URL>?generation=N`, or `urn:ryph:check-suite:<id>:<n>` without an app URL). The signature on the COB
operation is the attestation; the NID is on `GET /v1/identity`.

The writer is **`rad-job`**, the crate's own CLI, built into the image at the revision Desktop
pins (images/radicle/Dockerfile) — `rad cob` cannot touch this type (below). Its CLI decides two
things the bridge would rather have decided itself, and the bridge is built around both:

- **The run's uuid.** `rad-job run` mints a random one and takes none. So a run is found again by
  its **log URL**: our NID + the same `log` on any job for the commit is the same run, and a
  retry returns it (`created: false`). That is what makes the forge's report stateless.
- **Which job.** `run`, `succeeded` and `failed` act on the FIRST job `find_by_commit` yields,
  and a finish of a run that job does not hold exits `0`. Every write is therefore read back:
  the run is located by uuid after `run` and `finish`, and a finish that did not land (a
  duplicate job ordered ahead of ours) is a `409`, never a success. It stays ahead, so the forge
  treats that `409` as final rather than retrying it.

Find-then-create, the run and the finish are one call under one `withRepoLock` for the
repository, and announce after writing, like every other COB write here.

**What it costs.** `rad-job` has no filtered listing: every `list` reads and evaluates every job
in the repository, bounded at 120 s. A report takes at most two (find, then confirm), a retry
of a report that already landed takes one, and a forge read of a commit's CI takes one. The
cost grows with the number of jobs in the repository, not the commit's. Two nodes racing can still create two
jobs for one commit; `GET …/jobs` answers all of them and the forge unions them per node.

## 📤 Submitting a change

`POST /v1/repos/:rid/changes` takes the bundle as `multipart/form-data`: a `bundle` file part
and a `meta` JSON part. **One framing, and it streams** — the parts are read as they arrive
(`helpers/multipart.ts`), so `RYPH_RADICLE_MAX_BUNDLE_BYTES` bites while the bytes are landing
rather than after a body is already resident.

There was a second framing, `application/octet-stream` with the JSON in an `x-ryph-change`
header, and it is gone rather than deprecated. A header value is a **ByteString**: `title` and
`description` are the agent's own words, and a typographic apostrophe, an em dash or an emoji in
a title makes the SENDER throw before a socket is opened — which reads as "the bridge is
unreachable" and is retried forever — while a description near its 65 000-character cap outgrows
the 64 KiB header block a server accepts and comes back as a bare 400, which reads as terminal.
In the body both are simply bytes.

The bridge builds a scratch repository that borrows storage's objects through `alternates`,
`git bundle verify`s into it, fetches the named ref, checks the head is the one the caller
claimed, then pushes `refs/patches` (new) or `refs/heads/patches/<id>` (a new revision) through
`git-remote-rad`. It scrapes the patch id from git's stderr as a **hint** and then **confirms by
reading the COB back**. An identical head is a success no-op (`created: false`), because git
answers "Everything up-to-date" and never reaches the remote helper.

```json
{ "ref": "<40-hex>", "revision": "<40-hex>", "created": true, "url": "https://…" }
```

## 📥 Events

Each delivery is provider-neutral — no RID-shaped types and no COB vocabulary in the field names:

```json
{
  "deliveryId": "<rid>:<cob>:<op>:<actionIndex>",
  "kind": "comment.created | change_request.pushed | change_request.merged | change_request.closed",
  "repoRef": "rad:z…",
  "actor": { "did": "did:key:z6Mk…" },
  "thread": { "kind": "issue | change_request", "ref": "<40-hex>" },
  "body": "…", "sourceCommentId": "<40-hex>", "revision": "<40-hex>",
  "changeRequest": {
    "headSha": "<40-hex>", "baseRef": "main", "author": "did:key:z6Mk…",
    "url": "https://… | null"
  },
  "merged": [{ "revision": "<40-hex>", "commit": "<40-hex>" }]
}
```

`change_request.pushed` is a **revision** op on a change request — the one that opens it, and
every push of a new revision after — by anybody but our own node (ryph's own change requests
ask for their checks through the patch flow), and only while it is the change request's
**latest revision by its author** — heartwood's `Patch::latest`, which a change request read
reports as `authorHead` beside `head` (the newest revision overall, whoever pushed it), since
anybody may add a revision to anybody's change request and a stranger's on top is a proposal,
not the change request — and the change request is **open** (a draft counts), both read from
the materialized state. So a namespace seen for the first time, which walks its whole history,
mints one push for the head that matters rather than one per old revision, and a merged or
archived change request mints none.

A change request **reopened** — a `lifecycle` op back to `open` — mints one too, for the
author's latest head, whoever reopened it (our own node included: only the author may, and the
control plane decides whose change requests may run). A draft marked ready is the same op and
asks again for a head already asked for.

It carries the head commit, the repository's default branch as the base (a Radicle change
request has no other target), the change request's author (the actor is the op's), and the
change request's explorer page when `RYPH_RADICLE_EXPLORER_URL` renders an https link. Its
delivery id is the op's, like a comment's, so each revision or reopen is one event however
often it is replayed.

Delivery ids are **derived, never random**, so replaying the same storage state mints the same
ids and a redelivery is the consumer's primary key doing its job. Ops signed by our own NID are
dropped — every op is signed, so "did ryph write this" is a comparison, not a heuristic.
`merged` and `closed` are read from the *materialized state*, because a merge is a threshold
over several delegates' ops and no single op means it. A merge names what merged (`merged`): the
revision the state settled on and the commit its merge recorded — that revision's head, which
need not be the latest, since a delegate may push an older revision's head onto the default
branch. Where a state names no merge, every merge a delegate recorded rides instead, and a
commit is merged when any of them holds it. The git door serves such a head by id though no
ref it advertises names it: heartwood makes each revision's head a parent of the op that
records it, so storage keeps it.
At most twenty ride, the newest merges first: the forge's event schema and its containment
read accept no more. Every merge event carries `merged`, empty when the patch recorded no full
commit id; the bridge, the forge and the orchestrator deploy together. A merge's delivery id ends
in a digest of every commit that merged (`<rid>:<cob>:merged:<sha256>`, over the sorted heads), so
a later merge of the same patch at another commit is a new delivery rather than a duplicate. That
is rare: heartwood's push merges only an open or draft patch, so it takes two delegates merging
before they sync.

The repository's **canonical default branch** moving is the one event that is not about a
conversation — what an environment rebuilds on:

```json
{
  "deliveryId": "<rid>:heads/<branch>:<commit>",
  "kind": "branch.updated",
  "repoRef": "rad:z…",
  "actor": { "did": "<our own DID — the node that saw it>" },
  "branch": { "ref": "main", "commit": "<40-hex>" }
}
```

Only the canonical `refs/heads/<default>` counts — the ref the node computes once the delegates
reach quorum — never one peer's copy under `refs/namespaces/<nid>/`. It is **read back out of
storage** (on every reconcile, and on any `refsFetched` that wrote a branch), never taken from
the event, and its last-delivered commit is kept in the cursor table under the canonical ref's
own name. The branch is the identity document's, read live, so a renamed default arrives as a
`branch.updated` naming the new one. First sight and held deliveries follow the rules below.

**First sight of a repository emits nothing.** A repository with no cursors at all has its
cursors set and its history skipped: seeding a five-year-old repository must not replay five
years of comments into somebody's inbox.

**A cursor advances only over events that were delivered.** Storage is the only copy: if a POST
fails while the forge restarts and the cursor moves anyway, the next reconcile compares equal and
that comment is gone for good. So a *retryable* failure (5xx, 429, a dead socket) leaves the
reference's cursor exactly where it was and the whole `old..new` range is walked again next pass
— the ids are derived, so re-sending the ones that landed is the consumer's primary key doing its
job. A *terminal* refusal (400, 422: a payload that will never be accepted) does advance, because
wedging a reference forever over one unsendable event would lose everything said after it.

**One unreachable mailroom costs one delivery, not a pass.** Deliveries are sequential and each
waits out the sink's timeout, so a sink nothing can reach used to cost `refs × events × timeout`
per pass and hold every cursor anyway. The first *retryable* failure trips a pass-scoped switch:
the rest of the pass holds its cursors without attempting them — the same end state, reached in
seconds. A *terminal* refusal says nothing about the sink's health and does not trip it. Held
cursors are retried on the **pull** tick (60s), not only on the slow reconcile (300s).

## 🔁 The pull

Gossip is not a delivery guarantee. A `refs` announcement walks the peers each node happens to be
connected to, and there is no promise that any path reaches us: measured on a GKE deployment, a
maintainer's node connected to seven community nodes and none of the big seeds pushed new
sigrefs; they reached five community nodes and never iris, rosa or clem — the only sessions this
bridge had. Four minutes later the bridge had seen nothing, and one `rad sync --fetch` brought it
all down at once.

So the bridge **asks**. Every `RYPH_RADICLE_PULL_SECONDS` (60) it runs `rad sync --fetch` over
every seeded repository, one at a time, each bounded by `RYPH_RADICLE_PULL_TIMEOUT_MS` (45s), and
then reconciles. Failures are logged and non-fatal — nobody serving it, a seed that refused, a
node still fetching — and the next pass asks again. A pass that outlives its interval is not
started twice. The pull's budget is deliberately generous: a *nothing-new* fetch from a big seed
was measured at 32s from GKE.

## ⏱️ The fetch timeout chain

Seeding a repository is the slow call in this system, and every layer above it has its own
deadline. They are ordered, innermost first, each with margin:

| Bound | Default | Where |
| --- | --- | --- |
| `rad sync --timeout` | **20s** | `RYPH_RADICLE_FETCH_TIMEOUT_MS`, this bridge |
| the subprocess itself | 25s | the budget + 5s of grace (`core/sync_fetch.ts`) |
| forge → bridge | 30s | `DEFAULT_TIMEOUT_MS`, `@ryph/forge`'s `adapters/forge_api/radicle.ts` |
| orchestrator → forge | 45s | `DEFAULT_SEED_TIMEOUT_MS`, `@ryph/orchestrator`'s `adapters/forge/http.ts` |
| app → orchestrator | none | the SvelteKit proxy forwards without one |

Inverting that order is not a slow request, it is a WRONG ANSWER: the orchestrator used to give
every forge call 10s, so a connect that the bridge was still answering came back to the user as
"ryph's Radicle node did not answer" (502) while the fetch went on and succeeded. The CLI's own
grace goes the same way — `rad` can give up on the control socket before the node gives up on the
fetch (`timed out reading from control socket`), and that is reported as *still running* rather
than as a refusal, because the refs usually arrive and the next pull finds them.

The **pull** is not on this chain: nobody is waiting on an HTTP request for it, which is why it
may be generous where the seed route may not.

### The git fetch path

A git fetch through this bridge (`info/refs`) first asks the network for the repository, so a
clone gets what the network has. That fetch is **best-effort**: when it fails or runs out of
budget, the advertisement comes from storage, which the 60s pull keeps current. Its budget is
3s (`RYPH_RADICLE_GIT_FETCH_TIMEOUT_MS`), not the seed route's 20s, because the callers on this
path are short. And the budget is the whole bound: the other routes give `rad sync` 5s of grace
past its `--timeout` to print per-seed reasons, and this one gives none, because the CLI does
not keep its own timeout when the node has queued the fetch behind another from the same seed
(3s + 5s plus the forge's own work missed the 10s below, measured on a GKE deployment):

| Caller | Deadline |
| --- | --- |
| orchestrator → forge `services-file` (read before every run starts) | 10s |
| orchestrator → forge, replying in the thread | 10s |

The fetch also holds the repository's lock, and comment writes take the same lock, so the reply
explaining a refusal waits behind it too. With a 30s budget, one slow `rad sync` (21s, measured
on a GKE deployment) timed out the services-file read, so the run was refused, AND the reply saying so.
A slow network should cost freshness, not the run.

It is also **skipped when somebody already asked**: a fetch that landed within
`RYPH_RADICLE_GIT_FETCH_FRESH_MS` (one pull interval by default) — the pull's, a seed's or an
earlier clone's — means storage is as fresh as asking again would make it. Without that, a
workspace of N repositories paid N of these fetches on every task start, one after another (the
runner clones sequentially): ~0.5s each when nothing had changed, the full 3s each when a seed
was slow, for refs the pull had brought down under a minute earlier. Only a fetch that landed
counts — a refusal a moment ago is a reason to ask, not to skip.

## 👤 User mode

`RYPH_RADICLE_MODE=user` — or `RYPH_RADICLE_URL=embedded` on the `ryph` binary, which runs the
bridge in its own process this way — points the bridge at **a person's own** Radicle profile and
the `radicle-node` they already run, instead of a node of its own. ryph then acts *as* them on
Radicle: patches, comments, reviews and issues are signed with their key, the way GitHub's user
mode acts as the person whose token it holds.

A person's node is not ryph's, so four things change:

- **Only connected repositories are touched.** Their storage holds everything they have ever
  cloned, initialised or seeded, private repositories included. The seed route writes the
  repository into a tracked set (`radicle_tracked_repos`, beside the cursors, so it survives a
  restart), and that set is the whole of what the pull fetches, the reconcile walks, the
  consumer acts on, and every route and the git door serve: anything else is a `404`, as if the
  node did not hold it. That is why user mode will not start without `RYPH_RADICLE_DB`.
- **The node's seeding policies stay theirs.** Connecting a repository the node already seeds
  changes nothing about it — a `followed` scope is not widened to `all`, though a stranger's
  comment then never arrives. One they **blocked** (`rad block`) is refused with a
  `409 repo_blocked` naming `rad unblock <rid>`, and the block is never touched. One with no
  policy gets the policy a deployment's would, the tracked row remembers that ryph wrote it, and
  disconnecting removes that policy and no other — and only while it is still an `allow`: a
  block they have put there since is theirs, and `rad unseed` would delete it. Policies are read from the `rad seed` listing:
  the control socket has no command that reads one, and `rad inspect --policy` says "not being
  seeded" for a block and for no policy alike.
- **Disconnecting is immediate.** The repository leaves scope at once, and its cursors and its
  git mirror go with it, so connecting it again is a first sight rather than a replay of
  everything said in between. The consumer works on each repository under its own lock and asks
  again whether it is still in scope, so a pass already on its way cannot write the cursors
  back. If the node is down then, the route answers `503`, the row stays
  behind marked `unseed_pending` (out of scope, remembering the policy), and the removal is
  retried at boot and on every pull until it lands.
- **Their own merges arrive promptly.** Merging on their own node (`git push rad`, `rad patch
  merge`) is never a fetch, so it never arrives as `refsFetched`. The node's
  `localRefsAnnounced` for a tracked repository reconciles it at once, which mints
  `change_request.merged` and `branch.updated`. It is only as prompt as the announcement:
  `git-remote-rad` skips it when the node knows no seed for the repository, and then the
  reconcile timer delivers it, as it always would have. A deployment ignores the event as it
  always did — its only local writer is the bridge.
- **Nothing is written inside `RAD_HOME`** but what `rad` and `git-remote-rad` write themselves
  as part of an operation (COBs, a patch push into storage). The bridge's scratch repositories
  and the git door's mirrors live in `RYPH_RADICLE_DATA`, which user mode requires and refuses
  inside `RAD_HOME`; the binary puts it at `~/.ryph/radicle`.

And two things do not, on purpose:

- **No `/ryph` comment commands.** Their own comments are signed by "our" key, and our own ops
  are never news. Comments from other people still arrive.
- **No checks.** No `change_request.pushed` is minted at all — not for their own revisions,
  not for a stranger's, not for a reopen — and no job COB is ever written: a person's key is not
  a CI's, and `rad-job` need not be installed.

Signing: a person's key is usually encrypted and unlocked in their ssh-agent by `rad auth`. User
mode passes `SSH_AUTH_SOCK` to `rad` (a deployment never does), and `rad` 1.10.3 signs through
the agent whenever `RAD_PASSPHRASE` is unset *or empty*. Beside that agent, the bridge's `git`
may speak only `file` and `rad` (`GIT_ALLOW_PROTOCOL`): everything it runs reads a local path or
pushes to `rad://`, and no child can carry the agent anywhere over ssh. At boot the bridge fails, with the fix,
when `rad` cannot be run, when `rad self` finds no identity, or when the key is encrypted and
there is neither an agent nor a passphrase; it warns when the agent does not hold the key, when
`git-remote-rad` is not beside `rad` or on `PATH`, and when the node is not running — storage
still answers then, and the consumer reconnects on its own.

`rad` is looked up on `PATH`, then in `$RAD_HOME/bin`, where Radicle's installer puts it, unless
`RYPH_RADICLE_BIN_DIR` names its directory.

Who may connect: everything on a repository connected through a user-mode bridge is signed as
its owner, and the seed alone makes their node fetch and announce the RID. So the forge reports
the bridge's mode, and the control plane lets only `repos:manage-all` (an owner or operator)
connect a Radicle repository then, asked before anything reaches the node. The forge learns the
mode from its own configuration (`RYPH_RADICLE_MODE`), so the bridge checks it: it says its mode
on `GET /v1/identity`, every forge call names the mode the forge was told
(`x-ryph-radicle-mode`), and a user-mode bridge refuses to seed — `409 bridge_mode_mismatch` —
for a forge that was not told `user`. A deployment's bridge ignores the header.

The binary also squares the tracked set with its connected repositories at every boot: a
repository tracked with nothing connected behind it — a disconnect the bridge never heard — is
disconnected through the same path.

In the binary the bridge listens on loopback only, on an ephemeral port, behind a bearer minted
per boot and handed to the in-process forge in memory — never written to the environment or a
file. Loopback is not the boundary on its own: an agent container under Docker Desktop or
OrbStack can reach the host's `127.0.0.1`. The bearer is, and no run is ever given it.

## ⚙️ Environment

| Env | Default | What |
| --- | --- | --- |
| `RYPH_RADICLE_MODE` | `deployment` | `user` acts as a person's own identity over their own node — see [User mode](#-user-mode) |
| `RYPH_RADICLE_PORT` | `7470` | Listen port |
| `RYPH_RADICLE_TOKEN` | — | The shared bearer the forge presents. Unset: every route answers 503 |
| `RAD_HOME` | `/var/lib/radicle`; `~/.radicle` in user mode | The volume shared with the node. **One writer** — in a deployment |
| `RAD_PASSPHRASE` | `""` | Unlocks the key. Empty is valid; *unset* would make `rad` prompt |
| `RAD_SOCKET` | `$RAD_HOME/node/control.sock` | The node's control socket |
| `SSH_AUTH_SOCK` | — | User mode only: the ssh-agent `rad` signs through when the key is encrypted |
| `RYPH_RADICLE_BIN_DIR` | — | Where `rad` and `git-remote-rad` live. Unset: plain `PATH` lookup, then `$RAD_HOME/bin` in user mode |
| `RYPH_RADICLE_DATA` | `$RAD_HOME/ryph`; required in user mode | Scratch repos and the git door's mirrors. Never inside `RAD_HOME` in user mode |
| `RYPH_RADICLE_DB` | — | A ryph database URL for the cursor table and the tracked set. Unset: cursors live in memory, and user mode refuses to start |
| `RYPH_RADICLE_EVENTS_URL` | — | Where events are POSTed. Unset: a comment reaches no mailroom |
| `RYPH_RADICLE_EXPLORER_URL` | — | Template the `url` of a patch or an issue is rendered from. Placeholders below; a value naming **none** of them is logged once and treated as unset |
| `RYPH_RADICLE_EVENTS_TIMEOUT_MS` | `5000` | Bound on one event POST. Short on purpose — see "One unreachable mailroom" |
| `RYPH_RADICLE_RECONCILE_SECONDS` | `300` | The slow reconcile timer |
| `RYPH_RADICLE_PULL_SECONDS` | `60` | How often every seeded repo is fetched from the network |
| `RYPH_RADICLE_PULL_TIMEOUT_MS` | `45000` | Bound on one repository's pull |
| `RYPH_RADICLE_FETCH_TIMEOUT_MS` | `20000` | Bound on the `rad sync --fetch` a seed triggers. **See the chain above** |
| `RYPH_RADICLE_FETCH_ON_CLONE` | on | `off` serves the advertisement from storage without asking the node |
| `RYPH_RADICLE_GIT_FETCH_TIMEOUT_MS` | `3000` | Bound on the fetch before an advertisement — see "The git fetch path" |
| `RYPH_RADICLE_GIT_FETCH_FRESH_MS` | one pull interval | A clone skips that fetch when one landed this recently. `0` asks every time |
| `RYPH_RADICLE_MAX_BUNDLE_BYTES` | `500 MiB` | Cap on a submitted bundle |
| `RYPH_RADICLE_MAX_UPLOAD_PACK_BYTES` | `10 MiB` | Cap on an `upload-pack` request body |
| `RYPH_RADICLE_EXEC_TIMEOUT_MS` | `60000` | Default bound on one `rad`/`git` subprocess |

### The explorer template

`RYPH_RADICLE_EXPLORER_URL` is a literal string with three possible placeholders. Every
occurrence of each is substituted:

| Placeholder | Becomes |
| --- | --- |
| `{rid}` | the canonical repository id, `rad:` prefix included — `rad:z4V14vdenmiCJQPkp9347PXnNUahZ` |
| `{kind}` | `patches` for a change request, `issues` for an issue |
| `{id}` | the object's full 40-hex COB id |

```
RYPH_RADICLE_EXPLORER_URL=https://app.radicle.xyz/nodes/seed.example.com/{rid}/{kind}/{id}
```

There is no other syntax — `${id}`, `:id` and `{patch}` are ordinary text and are left exactly
where they are. A template naming **none** of the three is refused: a bare
`https://app.radicle.xyz` would give every patch and every issue in every repository the same
address, which a caller cannot tell apart from a real link. The bridge logs that once at startup
and behaves as if the variable were unset, so every `url` is `null`. **Unset is a real answer**:
a private Radicle network has no explorer, and then a thread's id *is* its address.

## 🧪 Tests

`bun run test` runs against the **real `rad` binaries** in throwaway `RAD_HOME`s, fully
offline: two identities, real signed COBs, real storage, and `git fetch` between the two storage
repositories standing in for a node fetch. Without `rad` on `PATH` or `RYPH_RADICLE_BIN_DIR` the
integration tests **skip** with a message rather than failing — the pure tests (identifiers,
materialization, the control-socket protocol and its wire format, the cursor stores, the
migrations) always run.

`tests/sync_fetch_test.ts` drives the real `rad sync --fetch` against the package's **fake
node** over a unix socket we own — offline, nothing dials the network — so the goldens its parser
is pinned to were produced by the CLI rather than copied out of a document, including the refusal
that exits zero.

`tests/node_wire_test.ts` is worth knowing about separately: it compares the exact JSON this
package puts on the control socket against heartwood's `Command`
(`crates/radicle/src/node/command.rs`), because a command the node cannot deserialize is not an
exception here — the node answers `{"error":"invalid type: …"}` and a seed quietly fetches
nothing. The forge's own `radicle_bridge_e2e_test.ts` covers the other direction: the real forge
adapter against this bridge, over HTTP, with no fake on the seam.

`tests/jobs_test.ts` pins the `rad-job list` parser to captured output, drives the service
over a fake `rad-job` that keeps the real one's hazards (first job wins, silent no-op finishes,
overwritable verdicts), and runs end to end against the real `rad` and `rad-job` when both are
installed — `rad-job` beside `rad` or on `PATH`; otherwise that one test skips.

`tests/user_mode_test.ts` is user mode against the same real binaries: nothing in scope until it
is connected, a policy the node already had left alone, one ryph wrote removed again, and a merge
the person made on their own node arriving from its `localRefsAnnounced` alone — with their own
comments still kept out. `tests/preflight_test.ts` tells an encrypted key from a clear one, both
written by a real `rad auth`, and asks a fake ssh-agent which keys it holds.

They never touch a developer's `~/.radicle`: every command carries `RAD_HOME` explicitly and
`RAD_SOCKET` is `/dev/null` unless a test deliberately points it at the fake node.

## 🧱 Layout

```
src/ports/      rad.ts (the rad, rad-job + git executor) · node.ts (the control socket) ·
                jobs.ts (the job COB) · cursor_store.ts · tracked_repos.ts (user mode) ·
                event_sink.ts · diagnostics.ts
src/core/       service.ts (every operation) · materialize.ts (COB JSON → our shapes) ·
                events.ts (the consumer, the pull and reconcile) ·
                sync_fetch.ts (`rad sync --fetch`, and reading it) · types.ts
src/adapters/   rad/cli.ts · jobs/{rad_job,fake}.ts · node/{socket,fake}.ts ·
                cursor_store/{memory,drizzle}.ts · tracked_repos/{memory,drizzle}.ts ·
                event_sink/{http,recording}.ts · diagnostics/logger.ts
src/http/       routes.ts · git.ts
src/main.ts     the composition root, and `startRadicle` for a host that mounts the bridge
```

`bun run guard` fences it: the core reaches only the core, the ports and the helpers.

## 🩹 Things measured about `rad` 1.10.2

Each of these cost a debugging session; none of them is in the documentation.

- **`rad cob create` does not work** for issues or patches. It writes an operation with no
  identity header and the object then fails to materialize ("identity document missing"), as a
  delegate and as a stranger alike. `rad issue open` is the supported path.
- **`rad cob show` reads the COB *cache*, not git.** The node fills it when *it* fetches; refs
  that arrive any other way are stale or invisible until `rad {issue,patch} cache` is run. Every
  read here re-caches the object first, and the event consumer re-caches every COB whose
  reference moved.
- **A push option may not contain a newline** — git refuses the whole push. A multi-paragraph
  description is therefore unrepresentable in `-o patch.message`; the bridge pushes the title
  and then sets the description with a `revision.edit` action, which also keeps its whitespace
  exactly.
- **`git-remote-rad` reads the working repository's HEAD** when it sets up the patch upstream.
  An unborn HEAD fails the push with `UnbornBranch` *after* the COB has been created — a
  half-success leaving a stray change request behind. The scratch repo points HEAD at the
  change branch before pushing.
- **`GIT_COMMITTER_DATE` in ISO-8601 panics `rad`** the moment it writes a COB
  (`radicle-cob/src/backend/git/change.rs:321`).
- **A patch COB has no `comment.edit` action.** Editing a comment on a change request is
  `revision.comment.edit` or `review.comment.edit`, and which one depends on where the comment
  lives — so it is located first.
- **One review per author per revision.** A second `submit_review` edits the existing review and
  appends its remarks.
- **`fetch` takes a `Duration` STRUCT and a real `NodeId`.** `timeout` is `{secs, nanos}` — a
  number is `invalid type: integer …, expected struct Duration` — and `nid` is never null:
  `invalid type: null, expected a string`. There is no "fetch from anyone" command at all.
- **The control socket cannot fetch from a peer the node has not dialled.** `fetch` at a peer
  with no established session is refused outright (`peer … is not connected; cannot initiate
  fetch`), and nothing on the socket will make the node dial one. So a bridge that walked its
  own `sessions` asked whoever happened to be connected — measured once, one flaky seed out of
  five holders — while `rad clone` of the same RID in the same container succeeded in a second,
  because the CLI reads the ROUTING table (`seedsFor`), dials the holders that are not connected
  (`connect`, `persistent: false`) and only then fetches. Fetching from the network is therefore
  `rad sync --fetch`, heartwood's own walk, and not a command of ours (`core/sync_fetch.ts`).
- **`rad sync --fetch` EXITS ZERO when it fetched nothing.** `sync.rs` hands a
  `FetcherResult::TargetError` to `display_fetch_result`, which prints it and returns `()`;
  non-zero is reserved for no node, an unseeded repository and "no candidate seeds were found".
  The only positive evidence is a `🌱 Fetched from <nid>` line. Everything it prints — the
  per-seed `✗ Error: <nid>: <reason>` lines included — goes to **stdout**; stderr carries only
  the spinner, and only when stderr is a terminal.
- **`sessions` answers ONE line holding the whole array**, not a line per session. Counting the
  lines makes every node look like it has exactly one peer.
- **A FAILED fetch is an ordinary reply, not an error.** `{"status":"failed","reason":"…"}` —
  heartwood's tagged `FetchResult` — arrives on a healthy socket, so a client that watches only
  for a thrown error reads every refusal as a success. And the reason a peer that simply does
  not HOLD the repository gives is, character for character, the one a private repository's
  refusal gives: `an I/O error occurred during the fetch handshake (connection reset)`. One
  connected stranger was therefore enough to make every public repository unconnectable. What
  separates the two readings is whether a peer that CLAIMS to hold it was actually asked, which
  is what `triedSeeds` counts — a candidate the fetcher could not even dial does not count.
- **A push option that is not plain ASCII never reaches the helper.** git C-quotes an option
  value that needs quoting (`quote_c_style`, transport-helper.c) and `git-remote-rad` takes what
  it is handed literally, so `-o patch.message=Don’t` arrives as `"patch.message=Don\342\200\231t"`
  and the push dies with `unknown push option`. An agent writes these titles, and a typographic
  apostrophe is what a model reaches for — so such a title is left off the push and set with an
  `edit` action afterwards, beside the description.
- **A percent-encoded RID is not a RID.** Every address a caller builds escapes the colon in
  `rad:z…`, and `URLPattern` hands path groups through raw — so the router
  (`@ryph/shared/http`) decodes them. Without that the bridge answers `400 … is not a repository id` to its own addresses.
- **A diff STAT cannot carry a review.** `rad` gives no hunks, and a review remark anchors to a
  line of the diff rather than of the file — so the forge side refuses every remark when it has
  no hunk text. Hence `GET …/changes/:id/diff`, which is `git diff base..head` against storage,
  split per file (`helpers/diff.ts`). A binary file and a pure rename name no `+++` line, so
  their path comes from the `diff --git` header and their patch is null. The forge reads it
  beside the stat on every change request read too, so `get_change_request` names the
  anchorable lines per file the way it does on GitHub.

## 🩹 Things measured about the job COB (rad 1.10.2, radicle-job 0.6.0 @ 77cf8fb4)

- **`rad cob` cannot read or write `xyz.radworks.job`.** A type `rad` does not know is an
  *external* COB, evaluated through a `rad-cob-<suffix>` helper nobody ships: `rad cob show` and
  `rad cob update` both fail with `failed to spawn program 'rad-cob-job'`. And a helper would
  not save it — an external action serializes as `{"parents":[],…}`, which radicle-job's
  externally tagged `Action` cannot read back. `rad cob log` and `rad cob list` do work.
- **`rad-job run` cannot be given a uuid**, and `run`/`succeeded`/`failed` act on the first job
  for the commit (see Jobs above).
- **Finishing a finished run overwrites it** — last op wins — and finishing an unknown uuid
  exits `0` and changes nothing. The bridge refuses the first (`409`) and read-back catches the
  second.
- **`rad-job list` sorts runs by uuid**, not by when they happened; `timestamp` is milliseconds
  at second precision, and it moves when a run finishes.
- **The same node's `Request` twice in one second is the same job** — identical op, identical
  commit, identical COB id. Two jobs for one commit need two nodes, or two seconds.
- **Still to measure:** that Desktop and the explorer render these runs, and that a job with
  runs from `rad-job` gossips to a seed like any other COB.
