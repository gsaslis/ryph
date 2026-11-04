# @ryph/memory

What agents **remember** across runs: a canon of one-claim memories about the org and its
repositories, the inbox agents propose into, the signal log that ranks them, and the two ways a run
reads them — a token-budgeted **brief** the orchestrator freezes into the run's snapshot, and MCP
**tools** the run reaches through the gateway's `platform` server.

## ⚙️ How it works

A **memory** is one atomic claim with a **subject** (the org, or a repo in canonical form), an
**audience** (every agent, or one), a **kind** (fact, procedure, gotcha, decision, preference,
pointer), a **trust** tier (pinned, human, ingested, agent), provenance, and counters derived from
the signal log. Its **score** — `trust × votes × decay × relevance` — is what ranks it for the
brief and for search, and every term is a column the UI shows.

Agents never write canon. A run's `memory__propose` lands in the **inbox**, saying what the claim
rests on: **observed** — found already true — or **introduced** — made true by the run's own
change. An introduced claim waits there until the orchestrator reports that the change
**landed** (a merge contained it); a change that was closed, rejected, superseded, or never
delivered, or missed by its merge, rejects it unless a patch that carries its work lands, so a
run cannot canonise the retry it just wrote and a reviewer then dropped. The change is kept **per patch**: the orchestrator reports every patch a run opens (a
run may open several — one per repo, and more as it keeps working), and a claim binds to the
first patch opened after it was made, or to the run's last patch when the claim came after that.
It holds once that patch, or a patch that **carries** its work, lands. The runner names on every
patch the run's earlier patches whose own commits it holds in full, by content — the same commit,
or its change already in the patch — never by who wrote a commit or what it says; the
orchestrator keeps the list on the patch and repeats it with the patch's fate, and memory unions
what it hears. A claim follows those edges forward, transitively — a superseded patch, or one a
merge passed over whose commits ride the next generation, only moves the question to the patch
that carries them — and never a patch's place in the run: a later patch that dropped the claim's
commits does not carry it, and its landing credits nothing. It is dropped once the run has
concluded and none of them did. A run that opened no patch rejects its claims at
once. The **consolidator**
screens what remains (a credential is refused, an instruction-shaped claim waits for a person),
folds an
exact duplicate into a confirmation of the memory it duplicates, and then — with the platform's
model — **judges** it against what the canon says on its subject: a duplicate in other words
confirms, a contradiction supersedes (the old memory is retired and linked), a refinement is
promoted and linked, noise is rejected with a reason, and what survives is rewritten as one tight
claim, classified, and moved to the org if that is what it is about — and screened again, so a
model steered into writing an instruction holds the claim for a person rather than promoting it.
Without a model the trivial path promotes as proposed and the stats say so. Every resolution is a
compare-and-swap off `pending`, so the consolidator and a person accepting from the inbox cannot
both promote one proposal; what a pass holds or leaves waiting it pages past, so a held head never
wedges the inbox. A run's `memory__refute` carries a replacement, which becomes a proposal that
supersedes the refuted memory when promoted; refutations from two different runs without a
reconfirmation between them retire it — one run's word counts once, however often it repeats it.
Once an hour the **sweep** retires what decayed three horizons past its kind's and was not briefed
within one.

The model is reached the way every off-run model call the platform makes is: a **platform
credential** minted from the model proxy's admin-set platform policy (the app's Model keys page),
spent on the proxy's data plane, metered under `platform:memory`. This service holds no provider
key.

**Staleness is mechanical.** A repo claim carries the commit and paths it is evidence for; the
brief carries them to the runner, which runs `git diff --name-only <sha>..HEAD -- <paths>` in its
clone before the agent starts, names the changed ones under "may be outdated" in the prompt, and
reports them upstream. The orchestrator relays the report here: those memories need verification
and move out of current canon into a clearly labelled secondary verification section. Only
task-relevant observations fit there, after canon and its index, using at most 25% of the total
token budget and only the remaining budget (including the warning). Stale pins have no priority
or budget override. IDs and evidence remain available so a run can inspect relevant claims and
confirm or refute them. Changed evidence demotes pinned claims too. Implicit successful-run credit
requires canon both when exposed (recorded in brief feedback) and at outcome; another run's
confirmation cannot turn stale exposure into implicit credit. Legacy brief feedback without this
marker predates stale exposure and is treated as canon; missing exposure feedback earns no credit.

**Documents** come in through ingest (paste, upload, a public URL, a public GitHub file): the
source is fetched and screened on the request, kept whole, and answered at once as `ingesting`;
behind that answer it is split into sections and the extractor — one model call per section, up
to a bound of sections the stats name as skipped — turns it into a review batch of proposals a
person accepts or rejects in bulk. The source says `ready` with the extraction's stats when the
batch is in, or `failed` with why (a restart cuts an extraction short, and the next boot marks it
so); a failed record is not the document, and ingesting the same text again replaces it. A `pointer` proposal says
the document exists; an agent reads it with `memory__doc`. Ingesting an updated version supersedes
the old source: what the new extraction no longer says is retired, what both say is confirmed.
A document ingested about the wrong subject is **moved**: its waiting batch, its live memories and
its own default all take the subject it is really about. A document ingested by mistake is
**withdrawn**: its waiting batch is rejected, what it put in
the canon is retired (pinned memories stay — a person vouched for those), and the record goes,
so the same text can come back under the right title.

**Search is hybrid where embeddings run**: the memory image bakes bge-small-en-v1.5 in
(`RYPH_MEMORY_EMBEDDINGS=local`) and the single binary carries it (on by default there), every
claim is embedded on the way in, the backfill covers the rest (memories written while embeddings
were off included), and a query ranks by the better of its full-text rank and its cosine similarity. Vectors
are a jsonb column compared in-process over a bounded candidate set — every full-text match, then
the newest of the rest, a thousand at most — so no deployment has to provide pgvector. The model runs on a worker thread
(`src/adapters/embed/worker_embedder.ts`); in the binary it loads on the first write or search,
and one that cannot load is said once and leaves search on full-text
(`src/adapters/embed/degrading.ts`). `RYPH_MEMORY_EMBEDDINGS=off` is full-text alone. The brief fetches
pinned memories apart from the ranked page, so one that shares no word with the task still rides.

Two things are decided by the platform and never by the agent. The **scope** a run's tools work in
comes from the run id the gateway forwards, resolved through the row `composeBrief` wrote — the
run's agent and repo — and a tool's arguments can only narrow within it. And the **brief** is
composed at task start by the orchestrator, over `MemoryAccess`, and frozen with the run's other
snapshots, so `GET /v1/runs/:id/spec` serves what the run was told and the task page can show it.

### Agent-only memory

In agent setup, **Tools & Memory → Memory → Advanced → Scope memories to this agent only**
sets `memoryPolicy.agentOnly: true`. Existing policies default to shared access. The orchestrator
passes the setting at task start, and memory persists it with the run scope, including for a
zero-token brief. Changing an agent's policy affects new runs, not an already-running agent.

An agent-only run is briefed with and can search, read, confirm or refute only memories whose
**audience** is that agent. Shared org/repo memories (even pinned ones) and other agents' private
memories are excluded. Proposals default to that agent's audience; explicitly requesting `all`
is refused. Consolidation compares and deduplicates within an audience, so private claims cannot
be folded into shared ones. Source documents have no private audience and are not readable,
even through a private pointer.

Subject and audience remain independent: a private memory can be about the org or one of the
run's repositories, but is never shared with the org or another agent. This setting does not
reclassify earlier memories or hide records from people with memory access.

## 🔌 Surfaces

| Surface                                                                            | Auth                                   | What                                                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /v1/memories`, `/:id`, `GET /v1/memory/subjects`, `GET /v1/memory-proposals`  | user gate                              | Browse, search (the same full-text search the tools use), the topic index, the inbox        |
| `POST /v1/memory-proposals`                                                        | user gate                              | A person proposing, into the same inbox                                                      |
| `POST /v1/memories`, `PATCH /:id`, `/:id/pin`, `/:id/unpin`, `/:id/retire`         | admin                                  | Writing canon by hand, editing, pinning, retiring                                            |
| `POST /v1/memory-proposals/:id/accept`, `/reject`, `/resolve`, `POST /v1/memory/consolidate` | admin                          | Working the inbox, one by one or in bulk; one consolidation pass on demand                   |
| `GET /v1/memory/health`, `POST /v1/memory/brief-preview`                           | user gate                              | Counts per subject and the inbox's state; the brief a run WOULD get, recorded nowhere       |
| `GET /v1/memory/sources`, `/:id`; `POST /v1/memory/sources`, `/:id/withdraw`, `/:id/move` | user gate; admin to ingest, withdraw or move | Documents people handed over (ingest answers 202 with the source, the extraction runs on) and the review batch each produced; withdrawing one rejects its batch, retires its memories and removes the record; moving one puts its batch and memories under another subject |
| `POST /v1/memory/embeddings/backfill`                                              | admin                                  | One backfill batch on demand (the timer does the rest)                                       |
| `POST /internal/v1/runs/:id/brief`, `/outcome`, `/patches`, `/change`, `/stale`    | `RYPH_MEMORY_TOKEN` (service)          | The orchestrator's five calls: compose a run's brief, report how it ended, report each patch it opens (again once it is a pull request), report what one patch came to, relay staleness |
| `POST /v1/memory-mcp`                                                              | `RYPH_MEMORY_GATEWAY_TOKEN` + run id | The MCP route: `search`, `get`, `doc`, `propose`, `confirm`, `refute` — reached only via the gateway |

## 🏛️ Where it runs

The historian's shape. Under the single process (`@ryph/host`, the `ryph` binary) the routes
mount into the control plane's router, the orchestrator holds the service directly, and the
gateway's platform entry dials the MCP route in-process with a token minted at boot. Standalone
(`src/main.ts`, `images/memory/Dockerfile`) it owns `ryph_memory`, the orchestrator composes
briefs over HTTP with `RYPH_MEMORY_TOKEN`, and the gateway dials `RYPH_MEMORY_URL` with
`RYPH_MEMORY_GATEWAY_TOKEN`. Standalone it also dials the model proxy for the platform's model
(`RYPH_MODEL_PROXY_URL` for the data plane, `RYPH_MODEL_PROXY_CONTROL_URL` and
`RYPH_PLATFORM_TOKEN` for the platform credential route) — in-process the host hands it the
proxy's issuer directly. Storage is its own schema owner: `drizzle.config.ts`, one committed
migration set, joined into the root `db:generate` chain.

| Variable                              | Effect                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RYPH_MEMORY_DB`                      | A database URL; standalone this is `ryph_memory`                                                                                                     |
| `RYPH_MEMORY_TOKEN`                   | The orchestrator's credential on `/internal/v1/…`. Unset, dark                                                                                       |
| `RYPH_MEMORY_GATEWAY_TOKEN`           | The gateway's credential on the MCP route. Unset, every call refused                                                                                 |
| `RYPH_MODEL_PROXY_URL`, `RYPH_MODEL_PROXY_CONTROL_URL`, `RYPH_PLATFORM_TOKEN` | The platform's model. Any unset: the trivial consolidator, and ingest extracts nothing — both say so                              |
| `RYPH_MEMORY_EMBEDDINGS`              | `off` (default) or `local`: in-process bge-small-en-v1.5 from `RYPH_MEMORY_MODEL_DIR` (the image bakes it at `/app/models`); a missing model fails the boot. Inside @ryph/host the binary defaults to `local` from its own copy and never fails the boot on it |
| `RYPH_MEMORY_CONSOLIDATE_INTERVAL_MS`, `RYPH_MEMORY_BACKFILL_INTERVAL_MS` | The consolidator's and the backfill's cadence (60s, 30s)                                                                         |

## ⚡ Commands

```sh
bun run ci             # type-check, architecture guard, tests (fmt and lint run from the root)
bun run db:generate    # regenerate the migration set after a schema change
bun run dev            # the standalone service on :7440 (needs a .env)
```

## 🔭 Not yet

External connectors (Notion, Confluence, Google Docs, Slack) as fetchers: the seam is
`ports/fetcher.ts`, keyed by source kind, and a connector is one more fetcher in front of the same
pipeline once someone holds its credentials. Private repositories' files reach memory by paste,
upload, or as an agent's proposals from inside a run — the service has no clone and no forge
credential, on purpose.
