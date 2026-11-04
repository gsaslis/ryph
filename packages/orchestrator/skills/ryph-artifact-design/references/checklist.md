# Before you publish

Go through this list every time, a follow-up version included. Each item is something the reader
would otherwise find for you.

## Shared with everyone

- [ ] No secret, token, key, password or credentialed URL anywhere, including in comments, data
      literals and screenshots.
- [ ] No private customer data, personal data, or content from a private conversation the requester
      would not repost to the whole instance.
- [ ] Screenshots show nothing a member should not see (other tabs, notifications, sidebars).

## Works under the policy

- [ ] One file. Every `<script src>` and stylesheet `<link href>` is under
      `https://cdn.jsdelivr.net/npm/`, `https://cdnjs.cloudflare.com/ajax/libs/` or
      `fonts.googleapis.com`, with an exact version in the URL (`chart.js@4.4.1`).
- [ ] Nothing relies on `<link rel=preconnect>`, `prefetch` or `preload`, `<noscript>`, `<base>` or
      `<meta http-equiv>`: the platform takes them out.
- [ ] No `fetch`, XHR, WebSocket, worker, `<form>`, `<iframe>`, `alert`/`confirm`/`prompt`, and
      nothing that relies on storage surviving a reload.
- [ ] Every image is an `img-…` ref a tool showed you after an image it returned (or one the version
      you update already shows), a `data:` URI, or inline SVG. No `https://` image or CSS
      background.
- [ ] Links are full `https://` URLs; none points at a local or internal address the reader cannot
      open.
- [ ] The file is under 2 MiB (`wc -c`).
- [ ] The page renders with no console errors, and is still readable with scripts off, as previews
      show it: the lead and the key numbers are static HTML or inline SVG near the top, and every
      chart has a static fallback.

## Reads well

- [ ] The answer is in the first screen: the title, a one-line subtitle, then the TL;DR or lead.
- [ ] One `<h1>`; headings in order; sections a reader can scan by their h2s alone.
- [ ] Prose at most 65ch wide, left-aligned, at 1rem or more.
- [ ] Every claim that came from somewhere has a source in the list at the end; dates are absolute
      ("3 June 2026", not "last week").
- [ ] No emoji bullets, no gradient banners, no lists longer than seven items.

## Looks right everywhere

- [ ] Checked at 375px wide: no horizontal page scroll, tables scroll in their own box, charts
      legible.
- [ ] Checked in light and dark: every colour is a token, text contrast holds in both, charts follow
      the theme.
- [ ] Every `<img>` and chart has alt text or an `aria-label` that says what it shows.

## Published

- [ ] Title is a short name, 1–200 characters.
- [ ] A follow-up passes `artifact` with the existing id, so the link stays the same; in a later
      run, `ryph__fetch_artifact` first.
- [ ] The link is posted where the request came from, with the gist in two or three sentences.
