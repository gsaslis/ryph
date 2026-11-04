# 📄 Artifacts

An artifact is an HTML page an agent publishes to the instance, for every signed-in member to open.
This page is the reference for what exists. The rules live in
[`core/artifacts.ts`](../src/core/artifacts.ts).

## 🗄️ Data

Migration `0047_artifacts`:

- `artifacts`: one row per artifact, carrying what the list shows (the latest title and version),
  the agent that created it, the run that first published it, the user that run acted for (the
  artifact's first asker), and how that run's task was asked for (`request_origin`, the task's
  `origin`) and in which chat conversation (`origin_chatroom_id`, the run's `originChatroomId`, and
  `origin_conversation`, the task's `chatConversation`): the versioning rule decides by them. A
  delete sets `deleted_at`, blanks the title and purges every version and image mapping; the row
  stays as a tombstone so its id is never handed out again, and every read treats it as absent.
- `artifact_versions`: `(artifact_id, version)` with the title, the document as published (`html`,
  what `fetch_artifact` answers), the document as served (`served_html`, made at publish: below),
  its size, the run that published it, that run's task and the user it acted for. Written once,
  never changed (until a delete purges them).
- `artifact_version_images`: per version, the attachment each image ref of its document resolved to
  at publish. Images are reached through the artifact, never through the run, so a viewer who cannot
  see the run still sees them.
- `artifact_publish_attempts`: one row per document a run handed the sanitizer, `(run_id, at)`,
  refused ones included; the run's hourly rate counts them. Apart from the versions, so a delete
  does not give the run its hour back; a run's rows older than the hour are pruned when it records
  its next one.
- `tasks.chat_conversation`: a chat task's conversation, one key every mention in it shares
  (`chatConversationKey` in `core/thread_context.ts`): on Zulip `topic:<stream id>:<topic>`, the
  topic upper-cased one character at a time as Zulip's own topic match folds it (the mention's
  thread key there is the mention's own id, so it cannot serve). Zulip topics have no id, so the key
  is the topic's name: a renamed or moved topic no longer matches its earlier mentions. The fold is
  JS `toUpperCase`, which may differ from Zulip's database collation on some characters; that can
  only fail to match or match another topic of the same channel, which gains nothing. On Slack
  `thread:<channel>:<thread ts>`, the top-level message's ts when not in a thread. Null on Telegram,
  whose one key is the whole group, and for every other origin.
- `agents.can_publish_artifacts`, default false, frozen onto the work item as `canPublishArtifacts`.
  Switching it on, at create or on an edit, takes `agents:policy` (as the browser switch does);
  switching it off is anyone's who may edit the agent. Like `can_open_patches` it moves only through
  a conditional write (`setAgentCanPublishArtifacts`, from what the edit read to what it asks): the
  full-row save never writes it, so an edit read before an admin switched it off cannot switch it
  back on, and a move lost to another one answers 409 with the rest of the edit saved.

## 🚪 Doors

**Runner** (run bearer):

`POST /v1/runs/:id/artifacts` `{ title, html, artifactId? }` → `201 { id, version, url }` for a new
artifact, `200` for a new version, `200 { id, version, url, unchanged: true }` when nothing was
written and no event appended: the title and document equal the current version's of the artifact
named, or, with no `artifactId`, of an artifact this same run created (so a publish repeated after a
lost answer does not make a second page). That is answered before the sanitizer and is not counted
against the run's hour.

In order, a publish is refused while the run is terminal (409); when the agent's switch reads off
LIVE or the agent is archived (403); for a NUL anywhere in the title or the document (400); a title
outside 1–200 characters, or with nothing visible in it, once C0/C1 controls and the line and
paragraph separators became spaces and every format character (`\p{Cf}`: zero-width characters,
LRM/RLM/ALM, bidi embeddings, overrides and isolates) was dropped (400; "visible" leaves out
whitespace, default-ignorable characters such as U+3164, lone combining marks and U+2800); a
document over 2 MiB (413); an `artifactId` the run may not version (404, below). Then the sanitizer:
the run's previous document still being made (429, "still being finished"), or as many as the
process makes at once (429, "try again in a moment"), neither counted; a run that made 30 attempts
in the hour before (429, saying when it can publish again: when the oldest of those 30 is an hour
old). Every document that gets this far is an attempt, recorded before it is sanitized, refused or
not. Then what the sanitizer says: not finished within its 3 s budget, an element with more than 256
attributes, a parse building more than 250,000 nodes, a served document certain to pass 4 MiB as it
is written, nested too deep to write back, or not settling (400, saying which: below). Then a served
document over 4 MiB in UTF-8 before its images are inlined (400; the parse can grow a document, as
misnested formatting elements are rebuilt in every block they span: 13.7 KB served as 2.9 MB; the
sanitizer counts UTF-16 code units as it writes, this is the exact byte check). Then more than 20
image refs (400); a ref that is neither one of this run's tool images nor one the version being
updated already shows (400, naming them); distinct images over 10 MiB, or over 16 MiB once inlined
with every use counted (400, naming the cap); an artifact at 100 versions (409). Nothing is refused
for text that merely looks like a tag: the parser decides what is a tag.

An `artifactId` the run may not version is a 404 whatever the reason. `mayVersion`: a live artifact
of the same agent, and one of

- the run's task already made one of its versions;
- the same chat conversation: both tasks were asked for in the same command room's same Zulip topic
  or Slack thread (`originChatroomId` and `chatConversation`), so a later mention there may update
  the page an earlier one asked for, whoever wrote it (a chat task acts for the room's owner, never
  for the writer). On Telegram only the same task may, since its one conversation is the whole
  group;
- the same person: neither the artifact's first task nor this run's task came from a chat or an
  automation (each acts for an owner who did not ask for this page), and this run acts for the
  artifact's first asker.

A publish appends the run event `artifact-published` with `detail` in prose,
`Published "Title" (version 2)`. The ids are on the task's `artifacts` (below), whose versions each
name the run that published them. Those events, and the titles in transcripts, stay after the
artifact is deleted: a delete purges the artifact, not the run's trail (accepted). `url` is
`${RYPH_APP_URL}/artifacts/<id>`, null without an app URL.

`GET /v1/runs/:id/artifacts/:artifactId` → `{ id, title, version, html }`: the current version as
published, refs as written, for `fetch_artifact`. The same rule as a publish: the agent's switch on
(403 off), and an artifact `mayVersion` allows (404 for anything else).

**User** (`artifacts:read`, which every role holds; visibility is instance-wide by design):

| Route                                       | Answers                                                                                                                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/artifacts?limit&before`            | `{ artifacts, next }`, most recently updated first; `next` is the opaque `before` of the next page, null at the end                                                                                                           |
| `GET /v1/artifacts/:id`                     | the list's shape plus `requestedBy`, `canDelete` (for the caller) and `versions: [{ version, title, runId, taskId, requestedBy, bytes, createdAt }]`, oldest first; each `requestedBy` is `{ id, name } \| null`              |
| `GET /v1/artifacts/:id/versions/:n/content` | the document as served (below), with a strong `ETag`; an `If-None-Match` naming exactly it answers 304 (not `*`, not a weak tag). 404 for an unknown or deleted artifact or version and for a caller without `artifacts:read` |
| `DELETE /v1/artifacts/:id`                  | `artifacts:manage` (operators), or the artifact's first asker: tombstone and purge, 204                                                                                                                                       |

A list entry is
`{ id, title, currentVersion, agent: { id, name }, originRunId, originTaskId, url,
createdAt, updatedAt }`.
The task page's `GET /v1/tasks/:id` carries `artifacts`: each live artifact any of the task's runs
created or versioned,
`{ id, title, currentVersion, updatedAt, versions: [{ version, runId, createdAt }] }`, with only the
versions those runs made, oldest artifact first.

## 🖼️ Listing thumbnails

The artifact index and run's artifact cards use lazy raster images, never embedded documents.
`GET /v1/artifacts/:id/versions/:n/thumbnail` takes the same `artifacts:read` capability as the
content route. It serves a 1200 × 750 PNG with private revalidation caching, `nosniff` and a
content-derived ETag. Liveness is checked before returning a cached image or a 304; unknown or
deleted versions are 404. The app proxies this at `/artifacts/:id/v/:n/thumbnail` without rotating
refresh tokens; a visible card refreshes the session first, through the app's deduplicated refresh.

Screenshots are **lazy and best effort**, not part of publication. On first view, the orchestrator
fills the prepared document's image tokens using `artifactContent`, asks an isolated renderer for a
PNG, validates its signature, dimensions and size (4 MiB maximum), and saves it beside attachments
in the object store under `artifact-thumbnails/<id>/<version>/offline-v1.png`. Existing artifacts
need no migration or backfill. Versioned keys prevent an old render replacing a new version's
preview. Replicas share cached blobs; they may duplicate a render, but cannot publish partial files.

Each orchestrator admits at most eight cache operations and one render at once, deduplicates views
of the same version, and backs off failed renders for 30 seconds in a bounded cache. Storage and
render requests share a 25-second abort signal; image streams are capped and get at most 5 seconds
each. Cleanup has a separate 10-second abort budget. Busy or missing renderers return 503 with
`Retry-After`, never an iframe. Cards show a neutral placeholder and retry at most four times, at
staggered intervals while visible, then stop. Publication and the full interactive viewer remain
available even if no preview can be made.

The renderer is a separate entrypoint in the browser image (`packages/browser/src/thumbnail.ts`),
not a run's browser and not the sanitizer. It receives only bounded HTML, not URLs, cookies or
credentials. Every request starts a fresh Chromium process; a 15-second deadline kills the process
group. Scripts, downloads, service workers, WebSockets and all external resource requests are
disabled. The synthetic document's CSP permits only inline styles and data images/fonts. Thus inline
layouts and uploaded images render, but external fonts/styles and script-only charts may look
different from the full viewer. The renderer's container must have network egress denied, no
secrets, bounded CPU/memory and either Chromium's sandbox or an explicitly isolated runtime.

Configure exactly one of `RYPH_ARTIFACT_THUMBNAIL_URL` (Kubernetes, separate pod with deny-egress
policy) or `RYPH_ARTIFACT_THUMBNAIL_SOCKET` (Compose, a shared socket with `network_mode: none`).
Without either, the control-plane service can still read cached previews; uncached ones show the
placeholder. The local binary under Docker instead automatically starts disposable, networkless
renderer containers using the published browser image. It streams HTML/PNG over Docker stdin/stdout,
so Docker Desktop needs no cross-VM Unix socket. `RYPH_ARTIFACT_THUMBNAIL_IMAGE` overrides the image
(or `off` disables automatic generation); an explicit renderer URL/socket still takes precedence.
The binary never launches Chromium in its credential-bearing process. See `packages/ryph/README.md`
for image preparation, sandbox requirements and lifecycle details.

Deletion first tombstones the artifact, then removes every possible version's thumbnail, including
older renderer revisions retained in the cleanup list. A render rechecks liveness before and after
upload, removing a late upload itself. Blob deletion is best effort: failures are logged as
`artifact.thumbnail_cleanup_failed`; a crash between upload and recheck or a failed object-store
delete can leave an inaccessible orphan. This cache has no durable cleanup queue or guaranteed retry
across restarts. Storage operators should include `artifact-thumbnails/` in orphan retention
reviews. `artifact.thumbnail_failed` records a failed generation without logging document content.

## 🧱 Serving untrusted HTML

The document is attacker-influenced: an agent reading the web or a hostile thread can be
prompt-injected. Served in the app's frame under the CSP `sandbox`, it runs in an opaque origin: it
cannot read the viewer's session, cookies or the app. It can still reach the internet from the
viewer's browser, through popups (`allow-popups`), WebRTC and STUN, or link hints its script adds at
runtime, so it is treated as able to beacon: the sanitizer below takes out the tags that beacon
without script, which matters for previews, but nothing stops a full view's script from reaching
out. Navigating its frame to another site is blocked by the app's own `frame-src 'self'`. Within the
frame it can also draw anything, a sign-in form included: in-frame credential phishing is in scope
and is NOT prevented. The defences are the app's "made by an agent" marker beside every frame,
`frame-src 'self'` on app pages, and the navigation guard.

**At publish**, the served document is made once and stored (`served_html`), by
[`helpers/artifact_html.ts`](../src/helpers/artifact_html.ts):

- the document is parsed with **parse5**, the WHATWG tree builder, with scripting on, as a browser
  parses it (a leading BOM dropped, as the browser's decoder drops it). What is a tag, what is text
  in a script, a comment or an attribute, and how SVG, MathML, tables and misnested markup come out
  are the parser's answer, so text that looks like a tag is never refused or changed
- taken out of the tree, with everything in them, by tag name in any namespace: every `<base>`;
  every `<meta>` with `http-equiv` or naming the referrer policy; every `<link>` whose `rel` holds
  anything but `stylesheet`, `icon`, `shortcut`, `apple-touch-icon` or `alternate` (so preconnect,
  dns-prefetch, prefetch, prerender, preload and modulepreload); `<script type=speculationrules>`;
  and every `<noscript>`, because previews run without script and its markup would come alive there.
  Template contents are walked too. A `<plaintext>` becomes the `<pre>` it renders as, since it
  cannot be written back and read the same
- every image ref in `src`, `srcset`, `poster`, SVG `<image href>`, and CSS `url()` in a `<style>`
  element's text or a `style` attribute becomes the token `ryph-img:<ref>`; a ref anywhere else
  (prose, a script) stays text and is never resolved
- the tree is serialized by the spec's algorithm, then re-parsed and sanitized again until the
  string stops changing (at most 4 rounds; a document that does not settle is refused). A string
  that re-parses to itself under parse5 holds nothing the sanitizer takes out, which closes the
  serializer's mutation-XSS cases (text written raw that ends an element early on the re-read).
  parse5 and Chrome do not build the same tree in every case (they differ in rare `<template>`
  inside table cases), so what a browser builds is not guaranteed to be parse5's: what is relied on
  is the fixpoint and the serializer's escaping of text and attributes, and above all the CSP
- the **preamble** goes first in `<head>`, so nothing of the author's runs before it:
  `ARTIFACT_HANDSHAKE`, a script that reads the nonce the app put in the frame's `name`, clears
  `window.name`, and posts `{ type: "ryph-artifact-loaded", nonce }` to the parent on the document's
  trusted `load`; then `<base target="_blank">`, so links without a target open a new tab. A final
  re-parse checks the two are the first children of `<head>` and the rest is the settled document.
  The app accepts a document only on that handshake, so a page the frame navigates to (which never
  learns the nonce) is caught. The script also posts `ryph-artifact-leaving` on `pagehide`, but
  nothing relies on it: a page that replaces itself with `document.open()` erases its listeners
  first

The work runs in a **child process**, one per publish, so the control plane never parses untrusted
markup and no document can make the work cost more than a fixed time and memory, whatever path
through the parser it takes. A Web Worker could not give that: `Worker.terminate()` does not stop a
thread busy in a synchronous loop (Deno 2.9.3 and 2.9.5: the caller is released, the thread runs
on), and four review rounds in a row found another path that ran past the parse's own clock. A
process can be killed ([`adapters/artifact_html/`](../src/adapters/artifact_html/)):

- **Time: killed at the deadline.** The process gets the budget, 3 s, plus 2 s to start, then
  SIGKILL. The parse also reads the clock itself (every 64 tokens, every 64 attributes on a tag,
  every element and attribute the sanitizer walks) and answers `too_complex` at 3 s, which is how
  the quadratic shapes end; the kill is for whatever path that misses. With the pre-fix quadratic
  trim put back as a stand-in for a missed path, a 2 MiB `<link rel="a   …   x">` that would run for
  about 39 minutes was killed at 5.0 s.
- **Memory: a heap cap.** 192 MiB of V8 heap. A confined process (below) parses on its one thread
  under `--max-old-space-size`; past it V8 aborts the process ("JavaScript heap out of memory" on
  stderr) and the publish is refused as too complex. An unconfined one parses in a
  `node:worker_threads` worker with `resourceLimits.maxOldGenerationSizeMb` (Node honours it, Bun
  1.4.2 ignores it), while its own thread watches the process's RSS and answers `out_of_memory` once
  it has grown by more than the cap since the worker loaded. The control plane only holds the HTML
  going in and the JSON coming back.
- **Permissions: Node's permission model, where there is a Node to run it.** The process is
  `node --permission --allow-fs-read=<its modules> --max-old-space-size=192 sanitizer.ts … --confined`
  on Node 25 or later, the first whose permission model covers the network. It may read its own
  three modules and the npm packages they import (parse5 and entities, each by the
  `node_modules/<name>` path node resolves it through and by its real path) and nothing else: no
  write, no network (sockets and `fetch`), no child process, no worker, no addon, no WASI, no
  inspector. Before it reads a byte of the document it proves that
  ([`sanitizer_permissions.ts`](../src/adapters/artifact_html/sanitizer_permissions.ts)):
  `process.permission` is on, none of those scopes is held, reading is not granted wholesale, it was
  started with no flag but those three kinds and no `NODE_OPTIONS` (`has("fs.write")` alone says
  false for a process granted `--allow-fs-write=/`, measured on 25.9), every `--allow-fs-read` names
  one of its own modules or a `node_modules/<parse5|entities>` directory, and `/etc/passwd`, the
  home directory and the orchestrator's `main.ts` are not readable. A process that fails any of it
  answers an error, which is a platform fault, never a document. Which node:
  `RYPH_ARTIFACT_SANITIZER_NODE` when set, and then nothing less will do (a node there that is
  missing, older than 25 or without the model, or an empty value, refuses every publish as
  `unavailable`); otherwise the first `node` on `PATH`. Either is checked once, at boot, by running
  it under `--permission` with nothing granted and reading back its version and what it still holds.
  The compiled `ryph` does the same: its archive carries the three modules and parse5 and entities,
  unpacked under `~/.ryph/runtime`, and node is granted those copies.
- **Unconfined where there is none.** A machine may have no Node 25: then the process is this
  runtime again (`<binary> __artifact-sanitizer …`, or `bun sanitizer.ts …`) and holds every right
  of its uid. That is logged once at boot, as a warning naming the fix, unless
  `RYPH_ARTIFACT_SANITIZER_CONFINED=required`, which refuses every publish as `unavailable` instead.
  The time and heap budgets hold either way, and in both shapes the process starts with an **empty
  environment** (no credential this process holds, no `NODE_OPTIONS`) in an **empty directory** of
  its own, removed after it exits.
- **Who starts it.** Two shapes, chosen by `RYPH_ARTIFACT_SANITIZER_SOCKET`:
  - **Set (the control-plane image).** The control plane asks the **sanitizer supervisor** over that
    unix socket ([`sanitizer_supervisor.ts`](../src/adapters/artifact_html/sanitizer_supervisor.ts),
    [`socket_preparer.ts`](../src/adapters/artifact_html/socket_preparer.ts)). The image's
    entrypoint starts the supervisor beside it with an emptied environment (no `RYPH_*` secret, no
    database URL, no token), listening on a socket in a directory made 0700 (the socket 0600). It
    decides the sanitizer's shape once at start, logs it, and exits if
    `RYPH_ARTIFACT_SANITIZER_NODE` names a node that cannot confine it. It starts one sanitizer
    process at a time with the same confinement, deadline, kill and heap cap, and a client that
    hangs up kills its process. The wire is one length-prefixed frame each way, both sides refusing
    an oversized frame before reading it, and the control plane puts its own deadline (budget +
    grace + 2 s) on the exchange: a supervisor that is dead, hung or busy costs that publish a `503`
    refusal (`unavailable`), never a hang or a held slot. The entrypoint is PID 1 over both: if
    either exits it stops the other and the container exits, so Kubernetes restarts both; SIGTERM
    goes to the control plane, which drains as before, and the supervisor is stopped after it; a
    signal during start-up stops both at once. The supervisor runs as the same uid as the control
    plane, so the kernel does not keep the two apart: what it adds is that the process starting
    sanitizers holds no secret, and that its input is tiny (two frames and a child's stdout).
  - **Unset (the compiled `ryph`, `bun run dev` and the host).** The process starts the sanitizer
    itself, decided and logged the same way at boot.

  The socket shape connects once at boot and logs if nothing answers.
- **What comes back is checked.** The parent (or, over the socket, the control plane) parses the
  process's JSON itself: a known refusal, or `ok` with `served` a string whose first child of
  `<head>` is exactly the preamble and `refs` a string array. Anything else is a platform fault
  (500), never stored. A process SIGKILLed by anyone but the deadline (the kernel's OOM killer, exit
  137) is refused `too_complex`, as the heap cap is.
- **A slot is held until the process has exited.** One process at a time per control plane (so one
  per run too); past that a publish is refused at once (429), never queued. The answer comes only
  after the process has exited, which a SIGKILL guarantees within moments, so no sanitizer outlives
  its deadline and a run looping hostile documents holds one process for at most 5 s each.
  Publishing stays up: a fault in the sanitizer fails that publish, never the control plane.
- The composition roots (`main.ts`, `@ryph/host`) own the preparer and kill whatever is running on
  shutdown. A kill at the deadline is logged as `artifact.sanitizer_killed`.

The parse's own bounds keep real pages well inside those limits and answer crafted ones in an
orderly way: at most 256 attributes on a tag or an element (one tag of 400k distinct attributes ran
for minutes in parse5's tokenizer, stray `<html>` tags each adding theirs for 15 s); at most 250,000
nodes per parse, counting attributes and re-opened formatting elements (14.6 KB of 1,000 `<div>`s
and 300 distinct `<b a=…>` built 300,000 elements and 600+ MB; real pages stay under it: the skill's
template is 428 nodes, a 1.8 MiB Chart.js/D3 page 164,028, 2 MiB of table rows 225,782); every
serialization stops once it is certain to pass the 4 MiB served cap; the strings parse5 builds a
character at a time (text, attributes, every comment state) are flattened as they grow; HTML's
whitespace is trimmed by index, not by a regex that is quadratic on interior spaces; and an
attribute list the parser shares among re-opened copies of one element is rewritten once.

Measured under Deno 2.9.5 (macOS arm64 under `deno run`, and the control-plane image on Docker
Desktop linux/arm64 with the entrypoint's exact permissions) on the reviews' adversarial corpus,
documents built to sit at the node cap, 2 MiB single strings of every kind and the legitimate pages,
146 in all, identical outcomes in both; the start-up row is remeasured for the current shapes (macOS
arm64, Node 25.9 and Bun 1.4.2, median of 10), the rest not yet:

| what                                                   | measured                                      |
| ------------------------------------------------------ | --------------------------------------------- |
| starting the process, tiny page                        | 76 ms confined (node), 47 ms unconfined (bun) |
| heap every document of the corpus fits in              | 128 MiB (two legit 2 MiB pages fail at 96)    |
| sanitizer process, peak RSS, any document              | 251 MB macOS, 272 MB image                    |
| node cap and served cap removed (a missed memory path) | stopped by the heap cap at 300–306 MB RSS     |
| slowest answer                                         | 3.06 s (the quadratic shapes stop at 3 s)     |
| sanitizer processes alive after an answer              | 0                                             |
| control plane CPU in the 500 ms after an answer        | ≤ 4 ms                                        |
| compiled `ryph`, 2 runs × 3 clients looping for 20 s   | at most 1 sanitizer alive; 0.03 cores 3 s on  |

A process's RSS is about its heap plus 110 MB (the runtime, the worker, and the copies of the
document and answer), so the cap bounds a process at roughly 300 MB. That lands in the control
plane's pod beside the control plane and the supervisor (measured at 65 MB RSS idle in the image;
120 MB is budgeted), so the pod's memory request is 1 GiB (the control plane's and its sanitizer
sidecar's 512 MiB each, `controlPlane.resources` and `controlPlane.sanitizerResources` in
deploy/helm/ryph/values.yaml), up from 512 MiB, and the perf overlay caps the control plane at 1 GB
too (perf/compose.perf.yaml). The entrypoint sets the supervisor's and its sanitizer processes'
`oom_score_adj` to 1000, so when the node (or the docker host) runs short the kernel kills them
first and pressure costs a publish (`too_complex`). At the container's own limit on Kubernetes it
does not: with cgroup v2 the kubelet sets `memory.oom.group`, so that OOM kills the whole container,
control plane included. The serializer recurses once per level of nesting, so a tree deeper than it
can walk (about 2,000 levels; browsers stop nesting at 512) is refused as too deep.

**At serve**, the content route only fills the tokens: one linear pass replacing each
`ryph-img:<ref>` whose image the version holds with its `data:` URI, read from the attachment store
and sniffed again, up to 10 MiB of images read and 16 MiB inlined; past that, or one that cannot be
read, the token stays and the image shows broken. A data URI holds only `[A-Za-z0-9+/=:;,]`, so
filling a token cannot change how the document parses. The response carries
`ARTIFACT_CONTENT_HEADERS`: the CSP with the `sandbox` directive (an opaque origin even when the
route is opened directly, so session cookies never ride its requests) and scripts, styles and fonts
only from `https://cdn.jsdelivr.net/npm/` and `https://cdnjs.cloudflare.com/ajax/libs/` (plus Google
Fonts), `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer` and
`Cache-Control: private, no-cache`. The app's `ARTIFACT_CSP` is the same string, held to the same
literal by a test on each side. All of the tree work is hygiene: the CSP sandbox is the boundary.

A served version is built at most four at a time and kept in a bounded in-memory cache (64
documents, 128 MiB, least recently used out first, one build shared by concurrent requests), dropped
on delete. Every request reads the artifact row first, so a delete takes effect at once on every
replica.

A compiled binary does not follow `new Worker(...)`, so `packages/ryph/scripts/compile.ts` names the
sanitizer's worker module, and compiles `src/entry.ts`, which hands `ryph __artifact-sanitizer` to
the sanitizer before the CLI's module graph loads; it also defines `RYPH_STANDALONE`, which is how
the preparer knows to start the binary itself when no node can confine it. It packs the sanitizer's
three modules as source, with parse5 and entities under `node_modules/`, for a node that can.

## 🧩 The skill

A run whose agent may publish artifacts is pinned to `ryph-artifact-design`, over the agent's own
skill switch and never over an admin's; a run whose agent may not is never given it
([skills](skills.md)). pi's artifact paragraph names the skill only when the run holds it.
