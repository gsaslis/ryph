# @ryph/forge 🌉

The entire boundary between ryph and a code-hosting forge, in both directions — because a
forge credential must **never** enter an agent container. A GitHub App installation token cannot
be scoped to a ref pattern, so a token in the container is an hour of force-push-`main`
capability; instead the agent talks to this package, and this package talks to the forge.

**Phases 1 and 2 (built): the git gateway, and the GitHub App behind it.**

1. A run's container clones each repo of its checkout **through the gateway**
   (`/v1/git/:runId/:connectedRepoId/repo.git`), authenticated by one run-scoped **read-only
   virtual key** minted by the orchestrator and resolved back against it per request. The key
   resolves to the run's **set** of connected repos; the URL names the member, and a member
   outside the set is a 401 like any other bad credential. The gateway serves clones from a **per-connected-repo
   cache** (disposable — losing it is a re-fetch), fetching base refs from the upstream itself.
   Private repos become cloneable for the first time: the fetch credential lives on the gateway,
   never in the container. For a **connected** repo that credential is a live installation token
   minted for the tenant that granted us the repo, scoped to that repo's own origin — so cloning
   a private repo needs no deployment-wide credential at all.
2. The runner's work leaves as a **`git bundle`** POSTed to `/v1/patches/:connectedRepoId` —
   one per repo it changed, there is **no git receive path at all**. The bundle's own header is
   validated (exactly one ref, the run's output branch in that repo, prerequisites satisfied by
   the cache) and stored durably behind `ports/patch_store.ts`. The agent cannot push anywhere: not forbidden — **there is nothing
   to push to**.

   A **check pod** clones through the same door with a key of its own: a grant member carrying
   `candidate: {headSha, bundleKey}` reads the one commit a run shipped but nobody submitted. It
   is served from a scratch repo staged out of that stored bundle (`http/candidate.ts`, the same
   `stageBundle` a submission publishes through, so the head is re-verified), never from the
   cache entry every run of the upstream shares. Such a key reads and never ships: intake and
   the change-request warm refuse it with a 401.

3. Door ③ — when a GitHub App is configured — is how approved work reaches GitHub: the
   orchestrator dials the **service surface** (`/v1/service/*`, shared `RYPH_FORGE_TOKEN`)
   to submit patches (fetch the stored bundle → push the branch with a short-lived
   installation token → open/adopt the PR, or fast-forward the branch of the pull request a
   command came from), check permissions live, read a thread whole (the
   opening post plus every comment, review and inline remark — what makes `/ryph ada fix
   this` answerable), describe installations, and exchange OAuth codes. For
   environments it answers four questions out of the
   repo cache and nothing else: a commit's `.ryph/` **tree id** and its Dockerfile's blob id
   (`/v1/service/ryph-tree` — one fixed path, object ids, never content; the tree id leaves out
   `checks.yml`, `services.yml` and `environment.md`, which no build reads), the `.ryph/` tree at a
   head's **merge base** with the default branch and the paths under `.ryph/` it changed since
   (`/v1/service/ryph-base` — whether a branch changed its machine or only fell behind), the
   **default branch's head** as the upstream
   names it (`/v1/service/default-branch-head`), and whether a ref is the default, one of the
   repo's own branches, or a fork's (`/v1/service/branch-kind`). For
   checks it reads `.ryph/checks.yml` — with its blob id, the
   `.ryph/` tree id, whether `.ryph/Dockerfile` exists and `.ryph/services.yml`, all at ONE pinned
   commit, and with **no stale-cache fallback** (`/v1/service/checks-file`) — and posts a suite's
   verdict back as check runs (`/v1/service/checks/report`). A person's own commit, asked about
   from their machine before it is on the forge, arrives as a bundle the orchestrator streams to
   `/v1/service/check-bundle`: verified like a run's patch (one ref, `refs/heads/<branch>` exactly,
   prerequisites the base cache satisfies after at most one refresh of the base, and at most one
   refresh a minute per base), filed under
   `users/<userId>/<branchKey>/<baseKey>/<connectedRepoId>/<headSha>.bundle`, and served to the check pod
   as a candidate like any other bundle. User bundles are not garbage-collected yet
   ([the gateway](docs/git-gateway.md)). A commit asked about as already pushed is proven to be
   its branch's head first (`/v1/service/branch-head`: `ls-remote` through the credentialed
   path, writing nothing to the cache; 404 when there is no such branch; on Radicle only the
   canonical branches the bridge's git door serves). Before it checks a pushed change
   request it reads the head back (`/v1/service/change-request-head`: state, merged, the newest
   head and the author's own, the base, whether this deployment opened it, and for a merge what
   merged — the pull request's head at the merge, or the Radicle revision the delegates merged,
   which need not be the latest — one `GET /pulls/{n}` on GitHub, where the full thread read is
   many; 404 when it is gone). When a change request merges, the control plane asks which of
   the heads it pushed onto it the merge **contained** (`/v1/service/merge-containment`): a head
   that is an ancestor of, or equal to, a merged head, or whose change is EXACTLY a merged
   head's, both ways: the head's change past its base replayed where the merged head left the
   branch it merged into is the merged head, and the merged head's change replayed on the head's
   base is the head — so a later push that only drops part of what merged is never read as
   merged; never by author, date or message. A merged head the branch fast-forwarded to (a
   revision rebased onto a moved branch) left it at one of its own commits: each of the up to
   200 under it, back to where it meets the head, is tried. Only where git names no such point
   (no branch named, or one these ref rules refuse, which is never a refusal of the question)
   is the same tree enough. A head under one contained that way is contained with it. The
   answer is `{ contained, missed }`, and the control plane lands a run past a contained head
   whichever rule held it. The bases are the runner's word, so a forged one reaches only that
   run's own patches and memory claims; a bad entry is dropped, never the question. Git answers
   out of the repo cache with the entry held, the merged-into branch's tip read off the
   upstream, the merged heads and then every head, base and that tip fetched by id, all within
   90 s.
   A merged head the upstream lacks, or an id that names no commit, is a terminal 404 when
   nothing can be judged; anything else that cannot be answered (git older than 2.40 included)
   is a retryable 502, never a guess. For
   skills it reads the org skills repo's `.agents/skills/` — one
   fixed prefix, every path one the tree listing returned, bounded before any content is read,
   strictly refreshed like the checks read (`/v1/service/skills-tree`). A patch's reviewer reads
   its diff through `/v1/service/patch-diff`: the stored bundle staged and verified as a
   submission verifies it, then diffed against the tip it lands on (or, once settled, from its
   own base), capped at 4 MiB and cut at a file, and filed beside the bundle under what it was
   measured against — pinned to that repo's own bundle. The App's private key,
   installation tokens, and OAuth client secret live in this package and nowhere else.

Phase 4 adds door ④: webhook ingest and inbound triggers.

4. Door ⑤ — when the App is configured and `RYPH_FORGE_GATEWAY_TOKEN` is set — is the agents'
   **tool surface** (`/v1/forge-mcp`), reached only through the mcp-gateway as its `forge`
   platform server: `get_issue`, `list_issues`, `get_change_request`, `list_change_requests`,
   `create_issue`, `add_comment`, `add_labels`, `submit_review`, `close_issue`. Each call is checked
   against the **tool grant** the orchestrator resolves the calling run to (the agent's forge
   policy, frozen onto the run), every write is reserved against the run's cap in the
   orchestrator's ledger first, and every call acts with an installation token **narrowed to one
   repo and the one permission it spends**. Writes lead with a footer the agent cannot hide.
   No tool touches contents. A comment or review that lands on the thread the run was
   **started from** — the one the platform keeps the run's status comment in, matched from the
   grant alone, Radicle prefix refs included — is answered with one extra line telling the agent
   to report its result with the comment set to "minimal", so the status comment points at the run instead of
   repeating what it just posted ([the self-reported outcome](../runner/docs/harnesses.md#-the-self-reported-outcome)).
   Nothing else is: not a write elsewhere, not a read, not a write that was refused or failed, and
   not a run with no origin thread.

   Under an `origin` comment policy, runs may also comment on change requests they checked out
   at start or through `checkout_change_request`, including replying to review comments and
   resolving those threads. The orchestrator records these separately from the origin and from
   threads the run opened, retaining access if the run retargets again. This does not grant
   review or close permissions, override a disabled comment capability, add writable repos, or
   bypass the private-source visibility rule. The grant cache can take up to ten seconds to see
   a newly checked-out change request.

   **`get_change_request` is the whole picture, because a reviewer needs one.** It answers what a
   human has on screen before they read a line of the diff: the description and branch, **CI on the
   head read live**, the **commits** (the newest 50, oldest first, with a count of what came
   before), the changed files with the lines a remark may anchor to, and a **timeline** of every
   comment, review and inline remark interleaved in the order they were said, each remark naming
   the id a reply takes and whether its thread is resolved (GitHub; Radicle's remarks carry no
   resolution). Every section is bounded and every cut says so — checks are ordered **worst first
   before anything is cut**, so what a cut hides is never worse than what it shows, which is the
   only thing that makes "1 failing, 44 passed" over a shortened list an honest sentence. A check
   the forge never LISTED is counted apart and never as a pass: it arrived in no order, it may be
   the failing build, and its presence forbids "all passed" outright. The CI and history sections
   also have a ceiling of their own inside the read's budget, so a change request with sixty
   checks cannot push the review thread — the part the agent was sent to address — off the end.
   GitHub lists only a pull request's first 250 commits, so on a longer one the history says
   which commits the window actually holds and that the head is beyond them, rather than calling
   fifty commits out of the middle "the newest". CI is the section that can come back incomplete,
   and each way says which: with neither of the App's `Checks: read` and `Commit statuses: read`
   it says so and names them; with only one of them, or with one channel unanswered, it reads the
   half it can and names the half it is missing rather than reporting the half as the whole. On
   Radicle it reads the commit's job COBs, one check per node. A Radicle patch has
   no commit list the bridge can answer cheaply, so there the history is
   the patch's **revisions** (one line per revision and its head), said as revisions rather than
   dressed up as commits. `list_change_requests` carries no CI column: nothing in a pull-request
   listing names a check, and a column costing one extra request per row is not a column. The
   read costs **two of the run's forge lookups** rather than one: a thread, a diff, a history and
   CI is a dozen upstream requests, and the budget that bounds one confused loop has to price it
   as what it is.

### Comparing versions for re-review

`compare_change_request` is an on-demand read, currently for Radicle patches. Pass `repo`,
`thread`, and `from` (the full **revision ID**, not its head SHA); `to` defaults to the latest
revision. `get_change_request` includes each revision's full ID, base and head for this purpose.

- `mode: "diff"` (default) compares the two head trees; unrelated base changes are included.
- `mode: "range-diff"` compares the recorded `base..head` commit series, useful after a rebase
  or rewrite. It is not a tree diff and does not define inline-review anchors.

Both modes run against node storage, so the earlier head need not be reachable from the current
exported branch. Only revisions belonging to this patch are accepted. Missing objects are an
explicit failure, never an empty comparison; output is capped at 60,000 bytes and marked when
truncated. Use the current patch diff from `get_change_request` to anchor review remarks.
The tool is hidden from GitHub-only runs; GitHub has no first-class per-push revisions and is not
yet supported by this comparison capability.

## Two forges

Every path here resolves a `ForgeApi` from the connected repo's **provider** — there is one
registry and one implementation per forge, and a repo naming a provider this deployment does not
run gets a terminal refusal rather than a crash. GitLab, the third forge, follows GitHub's shape
with one token instead of an App; its differences are [its own section](#gitlab).

| | GitHub | Radicle |
| --- | --- | --- |
| Address (`repoRef`) | `owner/name` | a RID, `rad:z…` |
| Credential | a GitHub App installation token, minted per call, narrowed to one repo | none per repo: the deployment's own key, held by the bridge (`@ryph/radicle`) beside its node. `tenantId` is null for every Radicle repo |
| Where a clone fetches from | the repo's own clone URL | `RYPH_RADICLE_URL/v1/repos/<rid>/git`, derived by the adapter (`ForgeApi.upstreamUrl`) — a RID is not a git address |
| "May this person write here?" | the live collaborator permission | two different questions, both read live from the identity document: `admin` is **delegacy**; `write` is **visibility** — a public repo answers yes to anybody, because contributing needs nobody's permission, and a private one answers on its `allow` set. Who may COMMAND an agent is neither: the orchestrator asks for `admin` on Radicle, plus its per-repo allowlist |
| A change request | a pull request; the transport pushes the branch and opens it | a **patch**; the transport uploads the same verified bundle to the bridge, which runs `git push rad` |
| Events | GitHub's webhooks, HMAC-verified | none exist. The bridge subscribes to its node's control socket, reconciles against storage, and POSTs each event to the `radicle` mailbox (`/v1/hooks/radicle`), verified by the shared bearer. A merge always names what merged, by commit (`merged`, empty when the patch recorded no full commit id); the bridge, the forge and the orchestrator deploy together |
| A comment's handle | a repo-wide numeric id | `<kind>:<thread>:<oid>` — a Radicle comment is only reachable through the object it hangs on, so the thread rides inside the handle |
| CI | **read:** the head commit's check runs and commit statuses, read live for `get_change_request` under the App's `Checks: read` and `Commit statuses: read`. **write:** ryph's own checks — one check run per check, named `ryph / <name>`, posted as the App under a token narrowed to one repo and `Checks: write` (`POST /v1/service/checks/report`), idempotent on its `external_id` (`<suite>:<generation>:<check>`); a ruleset can require `ryph / <name>` with the App as its source. "Re-run" on one of those runs arrives as `check_run.rerequested`, "Re-run all checks" as `check_suite.rerequested` | **read:** the commit's **job COBs** (`xyz.radworks.job`), read through the bridge — a run per node, unioned across jobs, and ryph's own as one run per suite named `ryph`. **write:** one job run per suite generation, signed by the deployment's node key, `Succeeded` only when every check passed and `Failed` for a failed suite or one that ended in error; a cancelled suite's run is left unfinished, and an older generation's run still going is finished as `Failed` when a newer one reports; its log URL is the suite's page. The signature on the COB operation is the attestation — there is no branch protection to gate on, so it is evidence a delegate checks, not a gate |
| A change request's history | the pull request's commits | a patch's **revisions** — the bridge holds no per-patch commit list, and walking git in storage is not what a read should cost |
| Connecting a repo | an installation grants it | `seedRepo` seeds with scope `all` and fetches once; **a fetch that produced nothing is an outcome, not a throw** — see below |

**Three gotchas worth knowing before you promise anyone anything.**

*Visibility is opt-in on the READER's side.* `rad seed` and `rad clone` default to scope
`followed`: a maintainer who never ran `rad follow <ryph's did>` will not see ryph's patches on
their laptop, however correctly they were pushed. The connect flow answers with ryph's DID and
the two lines to paste (`rad remote add <did> --sync` inside a working copy, `rad follow <did>
--alias ryph` anywhere). Symmetrically, ryph's node seeds every connected repo with scope
`all`, or a stranger's `/ryph` comment never arrives at all.

*ryph is normally not a delegate.* Radicle reserves labelling, assignment and the lifecycle of
somebody else's object for a repository's delegates, and making ryph one would also let it push
the default branch — which is not a trade this design recommends. So `add_labels`, and closing
an issue ryph did not open, come back as a **typed, terminal, agent-readable** refusal that says
what would change the answer, rather than as a 500 the model retries until its cap is gone.

*A private repository cannot be connected, and nobody can tell you that it is private.* A
private repository refuses the whole fetch at the *responding* node and the initiator sees only
a dead handshake; it is also never gossiped, so the routing table is empty as well. From here it
is indistinguishable from an id nobody is offering. So `seedRepo` answers
`{kind:"unavailable", did, command, seeds, reason}` rather than throwing, `command` is
`rad id update --allow <ryph's did>`, and the control plane shows both readings. `seeds` is the
node's routing answer: above zero a peer *is* offering the repository and refused us, which is
the sharper reading; zero proves nothing either way. Private repositories end to end are not
supported yet: they need an inbound listener.

## GitHub as one person (user mode)

A deployment's GitHub is an App **or** one person's token, never both — set either
`RYPH_GITHUB_TOKEN` or `RYPH_GITHUB_TOKEN_COMMAND` (e.g. `gh auth token`) instead of the App's four
credentials, and any mix fails the boot. It is how the single binary reaches GitHub without
registering an App.

`RYPH_GITHUB_TOKEN_COMMAND` is for the binary. It runs through `sh`, so a networked forge takes
`RYPH_GITHUB_TOKEN` (and normally an App anyway): its image sets `RYPH_FORGE_NO_TOKEN_COMMAND=1`,
which makes a token command a boot error.

- **Who acts.** At boot the forge reads `GET /user`: the login is who every write appears as, and
  a token GitHub refuses fails the boot, as does a GitHub that cannot be reached (the error names
  the `RYPH_GITHUB_API` URL it dialled). A classic or `gh` token's `X-OAuth-Scopes` is checked for
  `repo` (`github_user.missing_scopes`); a fine-grained token sends none and is bounded by its own
  permissions — contents, pull requests and issues read/write, metadata read.
- **Workflow files.** `workflow` (a fine-grained token's **Workflows** permission) is not needed,
  and is better left off: without it GitHub refuses a push that adds or changes a file under
  `.github/workflows`, as it does for an App without the Workflows permission. `gh auth login`
  over HTTPS commonly grants it, and then agents could add or change workflow files, which GitHub
  runs with the repo's secrets once pushed — the boot warns (`github_user.workflow_scope`) and
  suggests a token without it (a `gh auth login` using SSH, or a fine-grained token without
  Workflows).
- **What still runs with secrets, in both modes.** An agent's edit to code an existing
  `push` or `pull_request` workflow runs — test scripts, `package.json` scripts,
  `.ryph/check.sh` — runs with the repo's secrets once the branch is pushed, whatever the token
  or the App may do to workflow files. GitHub's mitigation is environment secrets behind required
  reviewers or deployment branch rules.
- **Repos.** `tenantId` is null for every user-mode GitHub repo; one naming an installation is a
  terminal wiring fault, as a null one is in App mode. Connecting goes through
  `GET /v1/service/github/repos` (`/user/repos`, every affiliation, every page; each entry's
  `admin` is GitHub's `permissions.admin` for the person, false when GitHub says nothing) and
  `POST /v1/service/github/describe` (`/repos/{owner}/{name}`, a 404 terminal). The installation,
  org-membership and OAuth routes answer 501, as they do with no App.
- **No narrowing.** A person's token cannot be scoped down, so door ⑤ acts with all of it: the
  grant checks are the only fence on a tool call.
- **Where the token goes.** Only to GitHub's own origins — `RYPH_GITHUB_API` and
  `RYPH_GITHUB_OAUTH` — as an API bearer, a fetch credential or a push credential, and to git
  only for the repo it was asked about: the clone URL's path must be exactly `/owner/name` or
  `/owner/name.git` (any case). Any other URL — another host, or another repo the person can
  also reach — is fetched as nobody and refused as a push target; a redirect off those origins
  is not followed. It is never logged, and no error carries it.
- **A 401** — from the API, or from git on a gateway fetch or a push — runs the command again:
  once, shared by every request that hit it, at most every 30 seconds, and the request is retried
  once with what it printed. A static token's 401 is final. A command that outlives its 10 s
  deadline is killed with its whole process group.
- **What is missing.** No webhooks (`RYPH_GITHUB_WEBHOOK_SECRET` with a token fails the boot), so
  no `/ryph` comments and no forge-triggered automations. Merges are polled instead: the
  orchestrator reads each open pull request a patch reached (at most once a minute by default,
  `RYPH_MERGE_POLL_INTERVAL_MS`; `RYPH_MERGE_POLL_PER_TICK=0` switches the poll off), and every
  ten minutes for a week each one that closed (a reopen and merge revises the close), through `/v1/service/change-request-head` (one
  `GET /pulls/{n}`, the token renewed on a 401 as above),
  and a push refused because its pull request merged or closed says which (`ended`), so that one
  is read at once. A pull request counts as "opened by us"
  when its author is the token's login — which includes one the person opened by hand. No check
  runs: GitHub lets only an App write them, whatever the token, so a check report answers
  `unsupported` without asking — check results show in ryph and are not posted to GitHub.

## GitLab

A fourth provider, `gitlab`: ONE instance per deployment (`RYPH_GITLAB_URL`, gitlab.com by
default; a self-managed instance under a path prefix is fine), REST API v4, version **17.0 or
later**. GitLab has no App and no installation token, so ryph acts as **one GitLab account**.

| | `bot` (`RYPH_GITLAB_MODE`, the default) | `user` (the binary) |
| --- | --- | --- |
| Token | the bot user's personal access token (a service account on Premium/Ultimate, an ordinary user elsewhere): `RYPH_GITLAB_TOKEN` | one person's: `RYPH_GITLAB_TOKEN`, or `RYPH_GITLAB_TOKEN_COMMAND`, e.g. glab's credential helper, which renews glab's 2-hour OAuth token: `printf 'protocol=https\nhost=gitlab.com\n\n' \| glab auth git-credential get \| sed -n 's/^password=//p'` (`ryph setup` writes it for your host) |
| Reach | the projects and groups a Maintainer added the bot to, at **Developer** — never Maintainer | everything the person reaches |
| Webhooks | `RYPH_GITLAB_WEBHOOK_SECRET` + `RYPH_FORGE_DB` | none; merges are polled, as in GitHub user mode |
| Sign-in | a GitLab OAuth application (`RYPH_GITLAB_CLIENT_ID`/`_SECRET`), `read_user` only, gated on `RYPH_GITLAB_GROUP` when set. The identity is `<user id>@<RYPH_GITLAB_URL>`; GitLab's confirmed addresses are not taken as proof, so they never reach an existing ryph account | none; the token's person is everyone's GitLab identity |

Either way the token needs `api`, `read_repository` and `write_repository`. At boot the adapter
reads the instance's version, the token's scopes (missing ones fail a bot boot and warn in user
mode; expiry within 14 days warns) and its own account; a token GitLab refuses, an instance too old
or one that cannot be reached fails the boot, naming the mode and the instance and never the
token. A user-mode variable set on a bot (or the reverse), a partial OAuth pair, a token named
both ways, or a webhook secret without `RYPH_FORGE_DB` fails it before GitLab is dialed.

- **Addresses.** A project is ADDRESSED by its id on the instance, `forgeId` =
  `<project id>@<RYPH_GITLAB_URL>`, and a person by theirs, `<user id>@<RYPH_GITLAB_URL>`
  (`src/gitlab_account.ts`) — never by path or username, which a rename frees for anybody to take.
  Every GitLab call without the id, or with one on another instance, is refused terminally: the
  service and grant schemas require it on every GitLab repo, the transport takes it by type, and
  nothing falls back to the path. `repoRef` is `path_with_namespace` — nested,
  `group/sub/…/project` — and only a label. Issues and merge requests have separate number spaces,
  so a thread ref carries its kind: `issue-12`, `mr-7` (people see `#12` and `!7`, and an agent may
  write either). A note's handle is `<thread>:<noteId>`, a diff note's
  `<thread>:<discussionId>:<noteId>`.
- **Credential.** `Basic oauth2:<token>` for git, the token for the API, offered to
  `RYPH_GITLAB_URL`'s origin only. **Nothing is narrowed per call** — no GitLab token can be — so
  the grant checks are door ⑤'s only fence, as in GitHub user mode. The Developer role is what
  makes up for it: a protected default branch refuses the bot's push and merge.
- **Quick actions.** GitLab carries out a `/close`, `/merge`, `/label`, `/approve` … line of a
  note, a note's edit, a published draft note and an issue's or merge request's description as
  the account that wrote it — ryph's. So every body the adapter writes goes through
  `inertToQuickActions`, which asks GitLab's markdown nothing and drops a leading byte-order mark
  first. A line is command-shaped when a command name could follow its `/` (a word or non-ASCII
  character, up to a blank or the line's end, as GitLab's extractor reads one); `//`, `/*`, `/ `
  and `/usr/bin` never are, and go out untouched. Everywhere but a diff note, EVERY command-shaped
  line whose first non-blank character is `/` gets a zero-width space before it, code included, which renders as nothing and leaves neither the
  source line nor its rendering starting with `/` — GitLab's two detections — so no agent text
  acts past its grant, whatever block GitLab's parser puts it in; nothing is refused. A diff note
  (a review's remark, a reply in its discussion, an edit of one) — the only place GitLab applies
  suggestions, whose lines "Apply suggestion" commits — is never escaped: its clean suggestions
  (a column-0 fence with a readable `suggestion` info string and its own close) are posted first
  in a backtick fence ryph builds (`suggestion:-A+B`, the lines verbatim; top-level code at a
  note's start), the rest as written, and the note is refused (terminally, naming the line,
  before the write is reserved) if any command-shaped line outside those fences starts with `/`
  behind any blank or zero-width character. No command line can exist in it, and any other suggestion GitLab finds
  (front matter, raw HTML, a container) is the agent's own bytes. A copied code block outside a
  diff note may carry the invisible
  character. It is verified up to GitLab 19.5; a newer instance boots with
  `gitlab.quick_action_escape_unverified`. A note GitLab still takes as commands only (its 202) is
  a terminal refusal: asking again would act again.
- **Confidential issues and internal notes** are never read to an agent: the private-to-public
  write rule reads the PROJECT's visibility, so text only Reporters see could otherwise be
  reposted in a public thread of the same project. A confidential issue is a terminal refusal on
  read and is left out of listings; an internal note is dropped from every thread read, images
  and all. An answer that does not say is taken as confidential.
- **A change request** is a merge request: the transport pushes `ryph/…` and opens one, or adopts
  the open one for that source branch (GitLab's 409). A command on a merge request pushes onto its
  branch under GitHub's rules; a fork's branch only where `allow_collaboration` is on and the bot
  may merge into the target branch — GitLab's own rule, which a protected default branch and a
  Developer bot fail.
- **Checks** are commit statuses named `ryph / <name>`. They join the commit's pipeline as an
  `external` stage, so "Pipelines must succeed" gates on them. GitLab has no re-run button for an
  external status: checks re-run from ryph's check page.
- **Webhooks**, bot mode only. Each project's hook is pasted by its Maintainer from the connect
  page: URL `<origin>/v1/hooks/gitlab?project=<project id>&generation=<n>`, secret token
  `hex(HMAC-SHA256(RYPH_GITLAB_WEBHOOK_SECRET, "gitlab-hook:" + projectId + ":" + generation))`
  (`POST /v1/service/gitlab/hook-token`), triggers **Push events** (the default branch),
  **Comments** and **Merge request events**, SSL verification on. The mailroom checks the token
  against the project and generation the URL names before the body is parsed, asks the control
  plane whether the project is connected at that generation before it stores anything (a
  Maintainer rotates it from the repo page; a rotated or archived project's token is answered
  403 and costs no row; answers are cached a minute, a refusal five), spends budgets of 60
  comments and 60 other events a minute per project, apart so merge request churn never drops a
  `/ryph` note (past one a delivery is answered 202 and dropped — a 429 would count toward GitLab
  disabling the hook — and the drops are counted on the repo page, comments apart), and
  queues each project's deliveries on their
  own; taken ones are kept a week, and a note rung again once one ring of it was taken (GitLab
  answered that the note is in the project — the body's id alone takes nothing) is dropped
  unread. A merge request's or a push's delivery is named by what GitLab answered (state,
  head and last change; the branch's commit), never by a header, so a ring for nothing new is
  not forwarded again and the control plane answers it from its record. The consumer's GitLab
  reads, and the control plane's calls for each event it forwards (`eventCost`), spend one budget
  over every project, 600 a minute: a delivery reserves the most it can spend before the mailroom
  claims it and gives back the rest (what is in flight counts against the cap), refused projects
  wait in one line, least-spent first, whatever the event, and a delivery the budget cannot cover
  yet waits without spending an attempt. The budget is per process, so only the forge replica
  holding the mailroom's lock delivers (every replica takes deliveries at the door; one that loses
  the lock starts no delivery 250 ms later, and a lock connection that dies or is partitioned
  away is replaced, its old backend ended, rather than wedging delivery; a database outage ends
  ticks at their deadlines, a tick stuck past a minute is abandoned, and only three in a row fail
  `/healthz`), and the
  GitLab mailbox drains apart from every other: a GitLab that hangs never delays a GitHub push. **A webhook is a doorbell**: the token is shown to the
  project's Maintainers, so nothing in a body is forwarded. The consumer asks the control plane
  again (a rotation may have come since), then reads the note, merge request or branch from
  GitLab with the bot's token under the verified project id, and builds the event from those
  answers — the project id and the actor's user id ride along, and are what the control plane
  matches repo and person on. A note written over an hour before its delivery was received, or
  before the project was connected, is no command: a token holder or GitLab's "Test" can ring for
  an old note no delivery carried here. A handle GitLab says is not there (404, 403, 410) is
  consumed terminally. Merges arrive only as merge request events, so the control plane polls a
  project's merges every 10 minutes while it has heard none of those for 30 minutes, whatever else it
  hears, and hourly once it has (one merge's event can still be lost). Rotating the master invalidates every hook at once. A networked deployment
  routes the exact path `/v1/hooks/gitlab` to the forge. The binary does this itself: its UI
  port forwards `/v1/hooks/github` and `/v1/hooks/gitlab` to the forge (origin-form targets only,
  to the forge's own origin, so no request target picks the host). Compose-networked needs a
  front door that routes them (see
  [its README](../../deploy/compose-networked/README.md)).
- **Connect routes** (door ③, service-authenticated): `GET /v1/service/gitlab/projects` — the
  bot's reach (`membership=true`, Developer and above), or the person's with `admin` marking
  Maintainer; `POST /v1/service/gitlab/describe` `{project}` (id, or the path a person is
  connecting, which binds it to its id) — GitLab's own listing, or a terminal 404;
  `POST /v1/service/gitlab/hook-token` `{projectId, generation}` — `{token}`, 501 in user mode or
  without a webhook secret; `POST /v1/service/gitlab/user` `{accountId}` — `{login}`, the account's
  username now, for display only. Who may see a token is the control plane's call (a Maintainer of
  that project). `POST /v1/service/oauth/exchange` and `POST /v1/service/org-membership` take
  `provider: "gitlab"`: the code is redeemed with its `redirectUri` and PKCE `codeVerifier`, and
  membership of `RYPH_GITLAB_GROUP` — pinned to the group's id at boot, asked about an
  `accountId`, never a `login` (a 400) — answers `member`, `not-member`, `unknown`, or
  `no-organization` where no group is set. Both answer 501 in user mode.
- **Permission and visibility** are asked of a project by its id (`forgeId`), and a permission
  about an account id: `POST /v1/service/permission` answers `denied`, unasked, for a subject that
  is a username, a bare id or an account on another instance — a username can be renamed away and
  registered by somebody else, who would inherit the answer. Only an active membership of an
  active account counts (not one `awaiting` a seat). Visibility is answered per role, as an
  audience — members < instance (`internal`: every account on the instance) < public. As a SOURCE
  a project is its own audience, or its members where its repository, merge requests, issues or CI
  are kept to them; as a TARGET it is its own audience, or the public where the feature written to
  (issues, or merge requests) is opened to the public. A write is refused only where a held
  source's audience is narrower than the target's: a run on an `internal` project writes on it and
  on other `internal` ones, never on a public one.
- **Images** in notes are read through `GET /projects/:id/uploads/:secret/:filename` with the
  token (17.4+; older instances omit them), rebuilt from the parsed secret and filename — the URL
  in the body is never followed. Images ryph writes are links, as on GitHub.
- **Pipelines run what is pushed.** A pushed merge request branch runs `.gitlab-ci.yml` — an
  agent's edit to it included — with the project's **unprotected** CI variables. Protected
  variables reach protected branches only, which the bot cannot push. Keep anything that matters
  in protected variables, exactly as on GitHub you would keep it in environment secrets behind
  required reviewers.

## Repositories on this machine (`local`)

A third provider that is not a forge: a git repository on the forge's own disk, connected by
path. Off unless `RYPH_LOCAL_REPO_ROOT` names the directory such repositories must live under
(the single binary passes it; a networked forge leaves it unset).

- **Connecting** — `POST /v1/service/local/describe` `{path}` answers the real path (the row's
  `repoRef` and `url`) and the branch HEAD points at, or a 422 `{error, reason}` — plus `root`,
  the allowed root's real path, when `reason` is `outside_root`. The path must be absolute,
  inside the root (textually first, so a path outside it is refused without the disk being
  asked, then again with symlinks resolved on both sides), a real path the wire can carry (no
  control characters, no edge whitespace), and a non-bare repository whose `.git` is a
  directory — linked worktrees and submodule checkouts are refused — that keeps its own store
  (no `commondir`/`gitdir`, no symlinked `objects`/`refs`/`HEAD`, no alternates), with a branch
  checked out that has commits. 501 when the provider is off.
- **Cloning** — the gateway's cache fetches from the path, which is re-checked every time it is
  resolved (`ForgeApi.upstreamUrl`): a connected path that now resolves anywhere else, a symlink
  swapped in included, or whose store has since been redirected, is refused rather than fetched.
  A forge with the provider off refuses a `local` grant outright (502); it never falls back to
  fetching the row's path.
- **Delivering** — the approved bundle is verified as on every forge and pushed into the
  repository as `refs/heads/<branch>`; `ref` is the branch, `url` is null. Only branches in
  ryph's own namespace (`ryph/<agent>/<run>`, and its `-<n>` generations), never the branch
  checked out in any worktree, never over a branch ryph did not deliver, only ever a
  fast-forward of the one it did (`existingRef`), never a force. A delivered branch the owner
  has since deleted is not re-created: the revision lands on the run's own branch as a new
  delivery, and `ref` says so. The receiving git runs with hooks disabled and every
  receive-side setting that could execute something pinned on its command line (`RECEIVE_PACK`
  in `adapters/change_transport/local.ts` lists them and why). A refusal or failure names no
  host path and carries none of git's output: it is handed on to the run.
- **Hook files** — a patch whose owner's next checkout, commit or status would run its code is
  not delivered until a person approves exactly the files it names (`409 needs_approval`;
  `POST /v1/service/local/patch-hooks` asks early). Covered: `.husky/`, `.githooks/`,
  `.config/husky/`, `.lefthook/` and `.lefthook-local/` (at the root, and the same folders at any
  depth) and every `core.hooksPath` from any config level git reads for the repository
  (worktree, local, global incl. `$GIT_CONFIG_GLOBAL`, system — wherever the installed git keeps
  it, `/etc/gitconfig` and `$GIT_CONFIG_SYSTEM` — and every file they include, conditional
  includes too), each resolved through symlinks on disk and in the patch's tree, the parent of
  one ending in `_` (husky v9's stub folder runs `<parent>/<hook>`), and any path that is an
  ancestor of one or of a folder a value steps up out of with `..`; what a symlink inside a hook
  folder points at; any config file git includes that lives in the working tree; hook managers'
  config files (husky, lefthook, lint-staged, simple-git-hooks, pre-commit, overcommit,
  commitlint, also under `.config/`) at any depth; any change to a root `package.yaml`/`.yml`;
  and the root `package.json` when a patch changes its hook keys or install scripts
  (`HOOK_PACKAGE_KEYS` in `core/hook_files.ts`), or is a symlink in any version (its target is
  then held whole). Names are compared folded (default-ignorable code points dropped, as HFS+
  drops them, then NFKC + full case fold) whatever `core.ignorecase` says. NOT covered, by
  design: arbitrary code an existing hook or tool goes on to run — an eslint or prettier config
  lint-staged runs, a script a pre-push hook calls, a nested workspace's `package.json` — and
  install-time tool config (`.yarnrc.yml`'s `yarnPath`, `.pnpmfile.cjs`, `.npmrc`'s
  `node-options`), which runs on the owner's next install rather than a checkout, commit or
  status. The repository's root is spelled `"."` in `hooksPaths`. Every patch-hooks failure
  carries `terminal`, an unexpected one as a `500` with `terminal: false`.
- **Nothing else** — threads, issues, labels, reviews and forge tools answer a terminal "not
  supported here"; check reports answer `unsupported`, so checks live in ryph only. Permissions
  answer allowed: there is no forge identity to ask, and who may act is the control plane's call.

## Docs

- [`docs/architecture.md`](docs/architecture.md) — the three doors, the ports, why it decides
  nothing.
- [`docs/git-gateway.md`](docs/git-gateway.md) — doors ① and ②: caps, gotchas paid for in
  blood, what used to be here.
- [`docs/threat-model.md`](docs/threat-model.md) — what a hostile agent can and cannot do.
- [`spikes/`](spikes/README.md) — the phase-0 evidence every measured number comes from.

## Running

```sh
RYPH_ORCHESTRATOR_URL=http://localhost:7411 \
RYPH_FORGE_TOKEN=<shared service secret> \
  bun run dev
```

| Env | Default | What |
| --- | --- | --- |
| `RYPH_FORGE_PORT` | `7412` | Listen port |
| `RYPH_ORCHESTRATOR_URL` | — (required) | Where run credentials resolve |
| `RYPH_FORGE_TOKEN` | — (required) | Service credential presented to the orchestrator (set the same value there) |
| `RYPH_FORGE_GATEWAY_TOKEN` | — | What the mcp-gateway presents on door ⑤ (set the same value there). Unset: no tool surface. Needs a forge to act through: GitHub, GitLab or Radicle |
| `RYPH_FORGE_DATA` | `forge-data` | Data root: `cache/` (disposable), `patches/` (durable, unless `RYPH_PATCH_STORE=s3`), `staging/` (swept on boot) |
| `RYPH_PATCH_STORE` | `local` | Where patch bundles live: `local` (this machine's disk) or `s3`. **This is the setting that decides whether the forge can be scaled** — on local disk a bundle submitted through one replica cannot be delivered by another |
| `RYPH_S3_*` | — | With `s3`: `ENDPOINT`, `BUCKET` and the two credentials are required; `REGION` (default `us-east-1`), `PREFIX`, `SESSION_TOKEN` and `FORCE_PATH_STYLE` (default path style) are optional |
| `RYPH_FORGE_MAX_UPLOAD_PACK_BYTES` | 10 MiB | Streaming cap on upload-pack request bodies |
| `RYPH_FORGE_MAX_BUNDLE_BYTES` | 100 MiB | Streaming cap on uploaded bundles |
| `RYPH_GITHUB_APP_ID` | — | The GitHub App (door ③); with its key, both or neither |
| `RYPH_GITHUB_PRIVATE_KEY` / `…_PATH` | — | The App's private key PEM (PKCS#8 or GitHub's PKCS#1 download, `\n`-escaped ok) |
| `RYPH_GITHUB_CLIENT_ID` / `…_CLIENT_SECRET` | — | The App's OAuth client pair, both or neither: sign-in and identity linking through GitHub. Without it the App still acts and GitHub is offered for neither |
| `RYPH_GITHUB_TOKEN` | — | GitHub **user mode**: act as the person whose token this is ([above](#github-as-one-person-user-mode)). Never together with the App's variables or the command below |
| `RYPH_GITHUB_TOKEN_COMMAND` | — | The same, as a command whose output is the token (`gh auth token`), run with `sh -c` at boot and again on a 401. Never logged, nor what it prints. For the binary; a networked forge takes `RYPH_GITHUB_TOKEN` |
| `RYPH_GITHUB_API` / `RYPH_GITHUB_OAUTH` | github.com | Overridable endpoints (tests, GHES), in either mode — and in user mode the only origins the token is presented to |
| `RYPH_FORGE_DB` | — | The webhook mailroom's own database (door ④). Unset: no ingestion route, no queue, no tick |
| `RYPH_GITHUB_WEBHOOK_SECRET` | — | The App's webhook secret. Needs the App **and** the database above; a partial set fails the boot, and so does a GitHub token (user mode has no webhooks) |
| `RYPH_GITLAB_URL` | `https://gitlab.com` | The one GitLab instance ([above](#gitlab)); a path prefix is kept. The only origin the GitLab token is presented to |
| `RYPH_GITLAB_MODE` | `bot` | `bot` (a bot user's token, webhooks and sign-in) or `user` (one person's token, none of those) |
| `RYPH_GITLAB_TOKEN` / `…_TOKEN_COMMAND` | — | The token ryph acts with, exactly one of them; scopes `api`, `read_repository`, `write_repository`. **Unset (and no other `RYPH_GITLAB_*`): no GitLab provider.** The command is for the binary, as GitHub's is |
| `RYPH_GITLAB_WEBHOOK_SECRET` | — | Bot mode: the master every project's webhook token is derived from. Needs `RYPH_FORGE_DB`. Unset: no GitLab webhooks, merges polled |
| `RYPH_GITLAB_CLIENT_ID` / `…_CLIENT_SECRET` | — | Bot mode: the GitLab OAuth application for sign-in and identity linking (`read_user`, redirect `<origin>/gitlab/callback`). Both or neither |
| `RYPH_GITLAB_GROUP` | — | Bot mode: the group whose members may sign up (`group`, `group/subgroup` or its numeric id), resolved to its id once at boot — a group the token cannot see fails the boot. Unset: no group gate |
| `RYPH_RADICLE_URL` | — | The Radicle bridge (`@ryph/radicle`), beside its node. **Unset: no Radicle provider at all** — connecting a `rad:` repo is refused, and everything GitHub keeps working. A host that runs the bridge itself (`RYPH_RADICLE_URL=embedded` in @ryph/host) hands `startForge` the address and a per-boot bearer directly, and neither variable is read |
| `RYPH_RADICLE_MODE` | `deployment` | How the bridge acts — set it to what the bridge has. `user` (one person's own identity) is reported in `GET /v1/service/providers`, and the control plane then lets only `repos:manage-all` connect a Radicle repository. Sent to the bridge on every call; a user-mode bridge refuses to seed for a forge not told `user`, and the forge warns at boot when the bridge's own `GET /v1/identity` disagrees |
| `RYPH_RADICLE_TOKEN` | — | The one bearer that whole bridge takes, in both directions: presented on every call out, and required on every event it POSTs to `/v1/hooks/radicle`. Required with the URL; a URL without it fails the boot |
| `RYPH_LOCAL_REPO_ROOT` | — | The directory `local` repositories must resolve inside — the line between what this forge may read and write on its own disk and the rest of it. **Unset: no local provider.** Must exist and must not be `/`, or the boot fails |
| `RYPH_RADICLE_EXPLORER_URL` | — | Template for a thread's web address — `{rid}`, `{kind}`, `{id}`, e.g. `https://app.radicle.xyz/nodes/<seed>/{rid}/{kind}/{id}`. The same value the bridge renders its own URLs from, so set it on **both** or neither. Unset is a real answer: a private Radicle network has no explorer, and then a thread's id **is** its address and no link is invented. A template naming none of the placeholders is ignored like an unset one — it would link the same page for everything |

On the orchestrator, set `RYPH_GIT_GATEWAY_URL` (the gateway address **as an agent container
dials it**) and the same `RYPH_FORGE_TOKEN`; every new run then clones through the gateway and
its work leaves as a bundle.

### One GitHub App per environment

Every environment needs its own GitHub App. A laptop gets one, staging gets one, production gets
one. Do not share an App between them.

The reason is the **Setup URL** — the page GitHub sends people to after they install the App on
their repos. An App has ten OAuth redirect URIs but only one Setup URL, and it names one host.
Share the App and one environment's installs always land on the other environment's address.

So making the App is a setup step for every environment, like picking its domain. Each gets its own
`RYPH_GITHUB_APP_ID`, private key, and OAuth client pair.

The App's **slug** and client id also reach the web app, as `PUBLIC_GITHUB_APP_NAME` and
`PUBLIC_GITHUB_CLIENT_ID`: the browser builds the install URL from the slug and the authorize URL
from the client id. An unset slug is how `https://github.com/apps//installations/new` happens — a
404, from an environment whose forge is otherwise wired correctly.

Forge's `listening on :…` line prints the App it loaded as `githubApp`. Check it there when an
environment looks wired to the wrong one.

### Registering the App

Three URLs, all on the origin a browser reaches the deployment at — never an internal address:

| Setting | Value |
| --- | --- |
| **Callback URL** | `<origin>/github/callback` — where sign-in and account-link round trips return |
| **Setup URL** | `<origin>/repos/connect/callback` — where GitHub sends people after they install |
| **Webhook URL** | `<origin>/v1/hooks/github`, content type JSON, with a secret (door ④) |

Leave **Request user authorization (OAuth) during installation** unticked. With it on, GitHub sends
a fresh install to the *Callback* URL carrying `code` and `installation_id` instead of to the Setup
URL, and the connect flow — which reads `installation_id` and nothing else — never runs. The two
round trips are separate on purpose: installing grants repositories, linking proves who you are,
and the app asks for them at different moments.

The webhook secret is yours to invent (`openssl rand -hex 32`), set in both places — GitHub's
**Secret** field and `RYPH_GITHUB_WEBHOOK_SECRET`. `/v1/hooks/github` is internet-facing and has
no other authentication: the `x-hub-signature-256` HMAC **is** its authentication, checked against
the raw body before anything parses it. Content type must be JSON, because form-encoding changes
the bytes the digest covers.

**Permissions** — exactly what the doors spend, and nothing spare:

| Repository permission | What spends it |
| --- | --- |
| **Contents**: read & write | Fetching base refs into the gateway's cache; pushing the run's branch on submit |
| **Pull requests**: read & write | Opening a PR, and adopting the already-open one on a re-submit; the `get_change_request` (its conversation, its diff and its commits), `list_change_requests` and `submit_review` tools, comments or labels on a PR, and `add_comment`'s replies in a review thread and resolving one (the resolution itself is GraphQL's `resolveReviewThread`, the one GraphQL write the forge makes) |
| **Issues**: read & write | The progress comment and its reactions — a PR's conversation is an issue's; the `get_issue`, `list_issues`, `create_issue`, `add_comment`, `add_labels` and `close_issue` tools |
| **Metadata**: read | Mandatory, and what the live collaborator-permission check reads |
| **Checks**: read · **Commit statuses**: read | The `checks` section of `get_change_request` — the head commit's check runs and its commit statuses, read live. **Optional**: without either, that one section says "not read" and names them, and every other part of the read is unaffected. Both are asked for because they are two different CI conventions and a half-reported change request would read as green with the red half invisible; **either alone still works** — a scoped mint refusing both is retried per permission, and the section reads the half that was granted and names the half that was not. Only GitHub's "never granted" answers (a scoped mint refused 422 for both halves, a 403 saying the resource is not accessible by integration) are remembered, per installation **and** repo, for ten minutes; a secondary rate limit or a suspended installation is temporary, carries when it lifts, and is asked again after |
| **Checks**: write | Posting ryph's own checks as check runs, `ryph / <name>` per check, when a patch with a suite is submitted — under a token minted for that one repo and `checks: write` alone, on the report path only. Supersedes **Checks: read** above (write includes read). **Optional**: an installation without it answers `unsupported` — the suite still runs and the agent and the app still see it, the report just says the App cannot post checks on this repo |

| Organization permission | What spends it |
| --- | --- |
| **Members**: read | The org-membership check behind "members of this org may sign up" |

| Account permission | What spends it |
| --- | --- |
| **Email addresses**: read | The verified addresses a sign-in through the forge is matched and created by |

**Event subscriptions**: `Issue comment`, `Pull request review comment`, `Pull request`,
`Push`, `Check run` and `Check suite`, and only those. The first two carry commands — the second is a `/ryph` written inline on
a line of a pull request's diff; the third tells the orchestrator when ANY pull request was
merged or closed — a merge carrying the pull request's head at the merge, never its merge commit
(for one ryph opened, the patch records the fate, and memory drops or releases
what the run claimed about its own change; for every pull request, the checks it asked for are
withdrawn), and when any pull request's head or base may have moved — `opened`, `reopened`,
`synchronize`, and an `edited` that retargeted the base become `change_request.pushed`, carrying
the head commit, the head it moved from (`before`, on `synchronize` only; null otherwise), the
base branch, `refs/pull/<n>/head`, the pull request's page and its author (`user.login`, where
the event's actor is the sender), so the orchestrator can run the repo's
checks on it (a fork's pull request and a bot's push are
forwarded too: whether the head may run is the orchestrator's permission check on BOTH the
pull request's author and the sender, not the door's — and whether it is still the head is
the orchestrator's to read back live, so a delivery arriving late checks nothing stale); every
other `pull_request` action is consumed; the fourth is how an environment
hears its default branch move — only a push to the connected repo's default branch becomes an
event (`branch.updated`), and tags, other branches and deletions are consumed at the door. An
App registered before `Push` was on this list needs it ticked by hand (it rides the **Contents**
permission the App already holds); until then the environment reconcile tick is the only thing
that notices the default branch moving. The forge checks all of this at boot against the App and every
installation (`core/app_subscriptions.ts`) and logs what is missing: `github_app.missing` (a
warning, for a required event or permission), `github_app.missing_optional` and
`github_app.extra_events` (info), or `github_app.subscriptions_ok`. The fifth is "Re-run" on one of ryph's own check runs —
GitHub sends `rerequested` only to the App that posted the run, and only a run whose
`external_id` has ryph's shape becomes an event (`check_run.rerequested`). Every other check run
delivery, which includes `created` and `completed` for every App's runs on the repo (other CI
too), is consumed as soon as its action or App says so, before the payload is parsed further.
"Re-run all checks" — the only button GitHub shows on a run that passed — is the sixth:
`check_suite.rerequested` for ryph's own App names a commit and no run, so it becomes an event
carrying only the head, and the control plane re-runs the suites it last reported there. Every
other check suite delivery (`requested` and `completed` on every push, other Apps' suites) is
consumed the same way, before its payload is parsed. An App registered before `Check suite` was on
this list needs it ticked by hand; until then the button does nothing. Door
④ consumes every other event name without parsing it; the delivery still lands in the mailroom's
table first, so subscribing to more fills it with rows nothing acts on.

The authorize URL carries a client id and a CSRF state and **no scopes**: the client pair is the
App's, so GitHub ignores `scope` and grants the user token exactly the account permissions above.
`GET /user` and `GET /user/emails` on that token are the whole of what it reads. An App registered
without the email permission still signs people in; it just sees no verified address, so nothing
can be matched or created by email until the permission is added and re-approved.

To check a registered App against this list without clicking through its settings, ask GitHub with
a JWT signed by the private key — `GET /app` returns the slug, `events` and `permissions`, and
`GET /app/hook/config` the webhook URL and content type. Neither exposes the Callback or Setup URL;
those stay a matter for the settings page.
