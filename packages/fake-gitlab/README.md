# @ryph/fake-gitlab

A stateful, in-memory GitLab for end-to-end tests and the playground. It serves the REST API v4
surface ryph's GitLab adapter uses, the OAuth application flow, git over smart HTTP backed by real
bare repositories, and webhooks to a configured URL. Adapter unit tests keep their own per-suite
stubs; this is for whole flows.

```ts
import { startFakeGitlab } from "@ryph/fake-gitlab";

const gitlab = await startFakeGitlab({ basePath: "/gitlab" });
gitlab.addUser({ username: "ryph-bot", bot: true });
gitlab.addGroup("acme");
await gitlab.addProject("acme/widgets", { files: { "README.md": "# hi\n" } });
gitlab.addMember("acme/widgets", "ryph-bot", "developer");
const token = gitlab.token("ryph-bot"); // RYPH_GITLAB_TOKEN; gitlab.url is RYPH_GITLAB_URL
gitlab.addRyphHook("acme/widgets", { url: "http://forge/v1/hooks/gitlab", master: secret });
```

`bun run start` runs it alone on :8929 with a seeded project and prints the tokens.

## ⚙️ What it covers

- **Accounts:** `/version`, `/user`, `/user/emails`, `/users?username=`, `/users/:id`,
  `/personal_access_tokens/self`, `/groups/:id/members/all/:user_id`. Tokens go in `PRIVATE-TOKEN`
  or `Authorization: Bearer`; scopes (`api`, `read_api`, `read_user`), expiry and revocation are
  enforced.
- **Projects:** nested group paths (any case, or the numeric id), `visibility`, `permissions`,
  `/projects?membership=true&min_access_level=30`, `members/all` with levels inherited from groups,
  labels with ancestor groups, project hooks, commits, branches. A project the caller may not see is
  `404 Project Not Found`. Each feature's `<feature>_access_level` (`setFeatureAccess`; a
  members-only repository is closed to non-members of a public project); memberships `awaiting`
  approval and blocked users (`addMember(…, { awaiting: true })`, `blockUser`), listed with their
  level and granting none; `renameProject`, whose old path redirects until a project takes it.
- **Issues and merge requests:** separate `iid` spaces, `state_event`, `add_labels`, list filters,
  fork merge requests (`target_project_id`, `allow_collaboration`), the 409 on a duplicate source
  branch, `refs/merge-requests/<iid>/head`, live `diff_refs`, `/diffs` (hunks; additions and
  deletions are not given), `/versions` and `/versions/:id` (one per head; a file's diff up to 200
  KB, where `/diffs` withholds one past 20 KB), `/commits`, approvals, `PUT …/merge`. Confidential
  issues (`confidential`, `?confidential=`) are for Reporters and the author.
- **Conversation:** notes, discussions (40-hex ids, replies, resolution), diff notes whose
  `position` is checked against the diff (an added line takes `new_line`, a removed one `old_line`,
  an unchanged one both), draft notes with `bulk_publish`, internal notes (`internal`, for Reporters
  and the author, sent as `Confidential Note Hook`s), award emoji, and the `/close`, `/reopen`,
  `/label` and `/unlabel` quick actions where GitLab (17.0 to 19.5) runs them: from column 0 of a
  top-level paragraph whose rendered text has a line starting with `/`, `\r` deleted first, in a
  note, a note's edit, a reply, a published draft and a description (labels only on create); any
  other `/` line, `/ryph` among them, stays. Suggestions: a `suggestion` / `suggestion:-a+b` code
  block (its info string read as CommonMark reads it, so `sugg&#101;stion` is one) in a diff note on
  a new line (anywhere in the note, as GitLab finds them in the rendered note) — or raw HTML's
  `<pre data-canonical-lang="suggestion">` (`data-lang-params` its lines, attributes over any lines,
  their character references decoded as HTML5 does, found anywhere in the note, code included) —
  read after GitLab's pre-processing (a leading byte-order mark dropped, front matter made a fence,
  so `---suggestion` … `---` at the note's start is one, `suggestion:-2+0:frontmatter` its lines) —
  is listed on the note (`suggestions`), and `PUT /suggestions/:id/apply` commits its text over
  those lines onto the source branch, while the note's diff is the latest.
- **Commit statuses:** GitLab's state machine per (sha, name, ref),
  `Cannot transition status
  via :x from :y`, latest per name on read.
- **Uploads:** `POST /projects/:id/uploads` and the credentialed
  `GET
  /projects/:id/uploads/:secret/:filename`, which needs version 17.4 (set `version` lower to
  see it 404).
- **OAuth:** `/oauth/authorize` signs in the user `signInAs()` named and approves at once;
  `/oauth/token` checks the client, the redirect URI and the PKCE verifier, and burns the code.
- **Git:** clone, fetch and push through `git http-backend` with `Basic` credentials
  (`oauth2:<token>`). Developers push branches; the default branch is protected (Maintainer pushes,
  nobody force-pushes or deletes it), refused through a pre-receive hook so the client prints
  GitLab's `remote: GitLab: …` lines. A fork's source branch takes pushes from whoever may merge
  into the target branch when the merge request allows collaboration. `merge_request.create` push
  options open a merge request.
- **Webhooks:** Push, Note, Merge Request and Issue hooks with `X-Gitlab-Event`, `X-Gitlab-Token`,
  `X-Gitlab-Event-UUID`, `X-Gitlab-Webhook-UUID`, `X-Gitlab-Instance` and, from 17.4,
  `Idempotency-Key` (kept on `redeliver()`). `addRyphHook` sets up what ryph's connect page asks
  for: `?project=<id>&generation=<n>` (`generation` defaults to 1), the token derived as
  `HMAC(master, "gitlab-hook:" + id + ":" + generation)`, default branch pushes, comments and merge
  request events. `flush()` waits for deliveries in flight.
- **Scripting:** `commit`, `openIssue`, `openMergeRequest`, `comment`,
  `merge(project, iid,
  {method: "merge" | "squash" | "ff"})`, `approve`, `requestChanges`, `fork`,
  `deleteProject`, `intercept()` for scripted failures (a 429 with `Retry-After`), and `requests`
  for asserting what was called.

## 🔍 Where it may differ from GitLab

What it assumes was checked against GitLab CE 17.11.7 (and 17.0.8 where the version matters) and is
marked `verified on GitLab …` in the code: system note bodies, the duplicate award's 404, statuses'
transition 400, default `ref` and 404s, the duplicate merge request's 409, draft positions checked
only at publish, git's refusal texts and token scopes, `allow_collaboration` on private forks, hook
headers and payload fields. Still assumed: `/diffs`' collapse limit is taken as a tenth of
`diff_max_patch_bytes` and positions are anchored against a collapsed file's whole diff; quick
actions' and suggestions' block structure is a CommonMark container model (`src/markdown.ts`: no
setext headings or tables) that fails open — from a block it does not model (a description list's
`:` details, an alert, `>>>`, front matter, a footnote or link reference definition, `$$` math)
every line is taken as a top-level paragraph, so the fake may run a command GitLab would not and
never the reverse (cross-checked against comrak with GitLab's options), while a suggestion inside
such a block may be read differently from GitLab; and quick actions' summaries cover only `/close`,
`/reopen` and labels; and GitLab's hook delivery order (it is not ordered: an MR's `update` can
arrive before its `open`) is not reproduced.
