---
name: ryph-artifact-design
description: >-
  How to design and publish an artifact: a single-file HTML page the instance hosts, published with
  ryph__publish_artifact and shared as a link. Read before writing a report, research write-up,
  overview, comparison or visual explanation to publish, before calling ryph__publish_artifact,
  or when an artifact renders blank, unstyled or broken.
---

# Ryph artifacts

An artifact is one HTML file you write in your workspace and publish with `ryph__publish_artifact`.
The instance hosts it at a link every signed-in member can open, keeps every version, and shows it
inside a sandboxed frame under a Ryph header. You post the link where the request came from.

Design guidance is in [references/design.md](references/design.md), the pre-publish checklist in
[references/checklist.md](references/checklist.md), and a working starter page in
[assets/template.html](assets/template.html). Start from the template: copy it, then replace the
content.

## When to publish one

Publish when the answer is something people will read, scan or come back to:

- research write-ups and overviews ("look into X and give us an overview")
- reports and summaries of findings, audits, incidents
- comparisons of options, libraries, vendors, approaches
- static dashboards of numbers you gathered, with charts or tables
- visual explanations: a flow, an architecture, a timeline

Reply in the thread instead when the answer fits in a few short paragraphs, when it is a yes or no,
or when it is a change to code (that is a patch). An artifact never replaces the short reply: post
two or three sentences with the gist, then the link.

## Who can see it

**Everyone on this instance can open every artifact**, including people who cannot see the run, the
agent or the repositories it read. Before you publish, remove:

- secrets, tokens, keys, passwords, internal URLs with credentials in them
- private customer data, personal data, anything from a private channel the requester would not
  repost to the whole organisation
- content the requester would not want shared beyond themselves

When in doubt, leave it out and say in the thread what you left out and why.

## Procedure

1. **Write one file.** A self-contained `.html` file in your workspace, for example
   `artifacts/report.html`. All CSS in a `<style>` block, all JS in `<script>` blocks, data inline.
   Start from [assets/template.html](assets/template.html).
2. **Look at it**, if the run has a browser (`browser__*` tools). The browser is a separate
   container sharing your `localhost`, so serve the file's directory:
   `python3 -m http.server 8123
   --bind 127.0.0.1 --directory artifacts` in the background, then
   `browser__navigate` to `http://127.0.0.1:8123/report.html` and `browser__screenshot`. To see
   phone width, serve a scratch page in `artifacts/` holding
   `<iframe src="report.html" width="375" height="800"></iframe>` and screenshot that. Check
   `browser__console_messages` for errors. The local preview does not enforce the platform's
   security policy, so also go through [references/checklist.md](references/checklist.md).
3. **Publish.** `ryph__publish_artifact({ path: "artifacts/report.html", title: "…" })`. The title
   is what the list and the header show: a short name, 1–200 characters, no "Report:" prefix. The
   result gives the artifact's id and link.
4. **Post the link** where the request came from (the chat thread, the issue, the run's result),
   with the gist in a couple of sentences.
5. **Follow-ups update the same artifact.** When asked to change, extend or correct it, edit the
   file and publish again with `artifact` set to the id or link you got:
   `ryph__publish_artifact({ path, title, artifact: "art-…" })`. That makes a new version at the
   same link. In a later run the file is gone: get it back first with
   `ryph__fetch_artifact({ artifact: "art-…" })`, which writes the current version, as published, to
   `artifact-<id>.html` in the checkout (or the `path` you give). Its `img-…` refs keep working in
   the next version. Create a new artifact only for a different document. An artifact takes new
   versions, and can be fetched, only by the agent that created it, and only:
   - in the same task;
   - from a later mention in the same Zulip topic or Slack thread it was asked for in (on Telegram,
     only the same task);
   - outside chat and automations, for the person who first asked for it.

   Publishing the same title and file again changes nothing and says so: with `artifact`, for that
   artifact; without it, only for a page this same run created. A run publishes one page at a time,
   and may hand Ryph 30 pages an hour, refused ones included.

## Previews run without scripts

Lists and previews show the page with scripts off; only the opened page runs them. Put what matters
in static HTML or inline SVG at the top: the title, the lead, the key numbers. Draw a chart as
inline SVG, or put a static fallback (a table, or the numbers in the text) where the script will
draw it. There is no load deadline: a slow page is not cut off, it just shows late.

## What works and what fails

The page is served under a strict Content Security Policy in a sandbox with no origin. What the
policy blocks fails **silently**: no error reaches you, the reader just sees a broken page. The
platform reads the page the way a browser does and takes out every `<base>`, every
`<meta http-equiv>` and `<meta name="referrer">`, every `<link>` other than a stylesheet, an icon or
an alternate (so `preconnect`, `dns-prefetch`, `prefetch`, `prerender`, `preload`, `modulepreload`),
`<script type="speculationrules">`, and every `<noscript>`. Text that only looks like one of those,
in a script string, a JSON block, a comment or a code sample, stays as you wrote it.

| Loads                                                                                                        |
| ------------------------------------------------------------------------------------------------------------ |
| Inline `<style>` and `<script>`, `style=""` attributes and inline event handlers                             |
| Scripts, styles and fonts from `https://cdn.jsdelivr.net/npm/` and `https://cdnjs.cloudflare.com/ajax/libs/` |
| Google Fonts: the stylesheet from `fonts.googleapis.com`, files from `fonts.gstatic.com`                     |
| Fonts from the two CDNs, and `data:` fonts                                                                   |
| Images and media as `data:` or `blob:` URLs, and `img-…` refs (below)                                        |

| Fails silently                                                                      | Do instead                                         |
| ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| `fetch`, XHR, WebSockets, EventSource                                               | Put the data in the page as a JS literal or table  |
| `<img src="https://…">`, CSS `url(https://…)` backgrounds                           | A screenshot ref, a `data:` URI, or inline SVG     |
| `<iframe>`, `<embed>`, video from another site                                      | A screenshot and a link                            |
| Web workers                                                                         | Run the work on the main thread                    |
| `eval`, `new Function`, string timers, and libraries that compile code at runtime   | Plain functions and libraries that need neither    |
| `<form>` submission                                                                 | Nothing to submit to; show, do not collect         |
| `alert`, `confirm`, `prompt`, print dialogs                                         | Show the message in the page                       |
| `localStorage`, `sessionStorage`, cookies, IndexedDB across views                   | Treat every view as fresh; state lives in the page |
| Navigating the frame or the top window                                              | Plain links; they open in a new tab                |
| Scripts or styles from any other CDN (unpkg, esm.sh, skypack), or jsdelivr's `/gh/` | The same package from `cdn.jsdelivr.net/npm/`      |
| `<link rel=preconnect>`, `prefetch`, `preload`, `<noscript>`, `<base>`              | Nothing: the platform takes them out               |

**Libraries.** Pin the exact version in the URL:
`https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js`, never `chart.js` or
`chart.js@4`. An unpinned page changes under its readers.

**Images.** When a tool returned an image (a `browser__screenshot`, an image file a tool read), you
see a line `Image ref: img-<12 hex>` right after it. Only those refs work: an image you were sent in
a message, or one you made up a ref for, has none. Use the ref as the source:
`<img src="img-3f2a9c01b7de" alt="…">`, or in `srcset`, or CSS `url(img-…)` inside a `<style>` block
or a `style` attribute. The platform inlines it when the page is served. Refs from this run work,
and so do the ones the version you are updating already shows; an unknown ref fails the publish and
names it. Images may weigh 10 MiB in all, and 16 MiB once every use is counted. Anything else (a
logo, an icon, a diagram) is inline SVG or a small `data:` URI.

**Links** open in a new tab: the server adds `<base target="_blank">`. Use full `https://` URLs. An
in-page anchor would open a tab too, so give it `target="_self"`:
`<a href="#src-1" target="_self">1</a>`.

**Size.** At most 2 MiB of UTF-8 for the file, after you write it. Screenshots as `img-…` refs do
not count against it; `data:` images do, so keep those small.

**Light and dark.** The reader's theme comes through `prefers-color-scheme`. Define colours once as
custom properties and redefine them for dark, as the template does. Never hard-code a colour in a
rule.

**Phone first.** People open these from chat on a phone. Design at 375 px wide, then let it grow. No
horizontal page scroll, ever: wide tables scroll inside their own container.
