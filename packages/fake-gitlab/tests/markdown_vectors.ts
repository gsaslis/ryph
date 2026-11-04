// Tricky markdown shared by the fake (markdown.ts, quick_actions.ts, suggestions.ts) and the
// GitLab adapter's quick-action rule (`inertToQuickActions` in @ryph/forge): each vector's text,
// what the adapter sends for it as a diff note (where GitLab finds suggestions) or "refused",
// and the suggestions GitLab finds in what is sent. A diff note is never escaped: it is posted as
// written — but for a dropped leading byte-order mark and the clean suggestions ryph posts again
// first — or refused when a line outside those starts with `/` and a command name. Both sides hold the pair to the
// same properties: nothing the fake would run as a command survives, no zero-width space is
// added, and every suggestion is the agent's, byte for byte. Elsewhere (a description, a note)
// every vector's text goes out escaped, and that runs nothing either. The round-4 to round-9
// review bodies (description lists, alerts, `>>>`, HTML in details, entity-spelled info strings,
// raw `<pre>`, front matter, a byte-order mark) are among them; each was also checked against
// comrak with GitLab's options and a port of GitLab's quick-action extractor.

/** The zero-width space the adapter puts before a `/` where it escapes. */
export const Z = "\u200B";

export interface MarkdownVector {
  name: string;
  text: string;
  /** What the adapter sends as a diff note, or "refused" for one it will not post. */
  inert: string | "refused";
  /** The text of each suggestion GitLab finds in what is sent, in order. */
  suggestions?: string[];
}

export const MARKDOWN_VECTORS: MarkdownVector[] = [
  {
    name: "code comments and paths are not commands, and go out as written",
    text: "Try:\n```ts\n// comment\n/* block */\n/usr/bin/env\n```\n// prose\n/ x\n/.hidden",
    inert: "Try:\n```ts\n// comment\n/* block */\n/usr/bin/env\n```\n// prose\n/ x\n/.hidden",
  },
  {
    name: "a suggestion of a comment line",
    text: `\`\`\`suggestion:-0+0\n// Package foo does bar.\n\`\`\``,
    inert: `\`\`\`suggestion:-0+0\n// Package foo does bar.\n\`\`\``,
    suggestions: [`// Package foo does bar.`],
  },
  {
    name: "a suggestion with commands in it: posted first, its lines as written",
    text: `Use this:\n\`\`\`suggestion:-1+1\n/close\n// x\n\`\`\``,
    inert: `\`\`\`suggestion:-1+1\n/close\n// x\n\`\`\`\n\nUse this:`,
    suggestions: [`/close\n// x`],
  },
  {
    name: "a command after a suggestion is refused",
    text: `Use this:\n\`\`\`suggestion:-1+1\n/close\n// x\n\`\`\`\n/close`,
    inert: "refused",
  },
  {
    name: "a tilde suggestion, posted in a backtick fence",
    text: `~~~suggestion\n#!/bin/sh\n/usr/bin/env true\n~~~`,
    inert: `\`\`\`suggestion:-0+0\n#!/bin/sh\n/usr/bin/env true\n\`\`\``,
    suggestions: [`#!/bin/sh\n/usr/bin/env true`],
  },
  {
    name: "an entity-spelled suggestion is a suggestion",
    text: `\`\`\`sugg&#101;stion:-0+0\n/approve\n\`\`\`\nThanks.`,
    inert: `\`\`\`suggestion:-0+0\n/approve\n\`\`\`\n\nThanks.`,
    suggestions: [`/approve`],
  },
  {
    name: "a backslash-escaped info string",
    text: `\`\`\`suggestion\\:-1+0\n/x\n\`\`\``,
    inert: `\`\`\`suggestion:-1+0\n/x\n\`\`\``,
    suggestions: [`/x`],
  },
  {
    name: "several suggestions keep their order",
    text: `Two:\n\`\`\`suggestion:-0+0\none\n\`\`\`\nand\n~~~suggestion:-1+2\n/two\n\`\`\`\`\n~~~`,
    inert:
      `\`\`\`suggestion:-0+0\none\n\`\`\`\n\n\`\`\`\`\`suggestion:-1+2\n/two\n\`\`\`\`\n\`\`\`\`\`\n\nTwo:\nand`,
    suggestions: [`one`, `/two\n\`\`\`\``],
  },
  {
    name: "a suggestion holding a backtick run gets a longer fence",
    text: `\`\`\`suggestion\na \`\`\`\` b\n\`\`\``,
    inert: `\`\`\`\`\`suggestion:-0+0\na \`\`\`\` b\n\`\`\`\`\``,
    suggestions: [`a \`\`\`\` b`],
  },
  {
    name: "a suggestion after a list's fence",
    text:
      `1. one\n2. two:\n   \`\`\`sh\n   ls -la\n   \`\`\`\n\n\`\`\`suggestion:-0+0\n// x\n\`\`\``,
    inert:
      `\`\`\`suggestion:-0+0\n// x\n\`\`\`\n\n1. one\n2. two:\n   \`\`\`sh\n   ls -la\n   \`\`\`\n`,
    suggestions: [`// x`],
  },
  {
    name: "a suggestion after a lone tag",
    text: `<span>\n\`\`\`suggestion:-0+0\n// x\n\`\`\``,
    inert: `\`\`\`suggestion:-0+0\n// x\n\`\`\`\n\n<span>`,
    suggestions: [`// x`],
  },
  {
    name: "a suggestion after a description list",
    text: `Term\n: def\n\`\`\`suggestion:-0+0\n/approve\n\`\`\``,
    inert: `\`\`\`suggestion:-0+0\n/approve\n\`\`\`\n\nTerm\n: def`,
    suggestions: [`/approve`],
  },
  {
    name: "a suggestion behind a byte-order mark: the mark dropped, the fence taken",
    text: `\uFEFF\`\`\`suggestion\n/usr/bin/x\n\`\`\``,
    inert: `\`\`\`suggestion:-0+0\n/usr/bin/x\n\`\`\``,
    suggestions: [`/usr/bin/x`],
  },
  {
    name: "front matter GitLab reads as a suggestion: posted as written",
    text: `---suggestion\nconst x = 1;\n---\nPlease apply.`,
    inert: `---suggestion\nconst x = 1;\n---\nPlease apply.`,
    suggestions: [`const x = 1;`],
  },
  {
    name: "front matter behind a byte-order mark, an encoding line and blank lines",
    text: `\uFEFF# -*- coding: utf-8 -*-\n\n;;;suggestion:-2+0\n  x = 1\n;;;`,
    inert: `# -*- coding: utf-8 -*-\n\n;;;suggestion:-2+0\n  x = 1\n;;;`,
    suggestions: [`  x = 1`],
  },
  {
    name: "front matter suggestions with a `/` line are refused",
    text: `---suggestion\n/close\nconst x = 1;\n---\nPlease apply.`,
    inert: "refused",
  },
  {
    name: "`+++` front matter after blank lines, with a command",
    text: `\n\n+++ suggestion\n/close\n...\n`,
    inert: "refused",
  },
  {
    name: "front matter with an encoding line, its `/` line indented",
    text: `# -*- coding: utf-8 -*-\n;;;suggestion:-2+0\n  /x\n;;;`,
    inert: "refused",
  },
  {
    name: "nested fences: a command in code is refused too",
    text: `\`\`\`\`md\n\`\`\`\n/close\n\`\`\`\n\`\`\`\``,
    inert: "refused",
  },
  {
    name: "an unclosed fence",
    text: `text\n\`\`\`\n/close\n/merge`,
    inert: "refused",
  },
  {
    name: "indented code and indented lines",
    text: `Run:\n\n    /usr/bin/env\n\n\t/bin/ls\n /close`,
    inert: "refused",
  },
  {
    name: "a command behind zero-width and Unicode blanks",
    text: `ok\n\u200B\u200D\u2060\u00A0\u3000/close`,
    inert: "refused",
  },
  {
    name: "a fence in a list item, and a command after it",
    text: `- step:\n  \`\`\`sh\n  /usr/bin/env\n  \`\`\`\n/close`,
    inert: "refused",
  },
  {
    name: "lazy continuation lines",
    text: `> quote\n/close\n- item\n/label ~x\n\n/reopen`,
    inert: "refused",
  },
  {
    name: "CRLF and a lone CR",
    text: `a\r\n\`\`\`\r\nx\r\n\`\`\`\r\nb\r/label ~y`,
    inert: "refused",
  },
  {
    name: "CRLF, no command",
    text: `a\r\n\`\`\`\r\nx\r\n\`\`\`\rb`,
    inert: `a\n\`\`\`\nx\n\`\`\`\nb`,
  },
  {
    name: "an HTML block",
    text: `<div>\n\`\`\`\n/close\n</div>\n\n/close`,
    inert: "refused",
  },
  {
    name: "GitLab's multi-line block quote",
    text: `>>>\n\`\`\`\n>>>\n/close\n\`\`\``,
    inert: "refused",
  },
  {
    name: "a `>>>` opener with text after it",
    text: `>>> x\n\n/close`,
    inert: "refused",
  },
  {
    name: "an alert takes no lazy line",
    text: `> [!note]\n/close`,
    inert: "refused",
  },
  {
    name: "front matter",
    text: `---\ntitle: x\n---\n/close`,
    inert: "refused",
  },
  {
    name: "a fence in a footnote",
    text: `[^1]: note\n\n   \`\`\`\n/close\n   \`\`\``,
    inert: "refused",
  },
  {
    name: "a fence in a description list's details",
    text: `Here is the fix\n: see below\n  \`\`\`\n/approve\n/merge\n\`\`\``,
    inert: "refused",
  },
  {
    name: "a comment in a description list's details",
    text: `Term\n: def\n  <!--\n/close\n-->`,
    inert: "refused",
  },
  {
    name: "a math block",
    text: `$$\n/close\n$$\n/close`,
    inert: "refused",
  },
  {
    name: "a suggestion in a list item: posted as written",
    text: `- \`\`\`suggestion:-0+0\n  x = 1\n  \`\`\``,
    inert: `- \`\`\`suggestion:-0+0\n  x = 1\n  \`\`\``,
    suggestions: [`x = 1`],
  },
  {
    name: "a suggestion in a list item with a `/` line",
    text: `- \`\`\`suggestion:-0+0\n  /approve\n  \`\`\``,
    inert: "refused",
  },
  {
    name: "a suggestion in a block quote with a `/` line",
    text: `> \`\`\`suggestion:-0+0\n/close\n> \`\`\``,
    inert: "refused",
  },
  {
    name: "a suggestion inside another code block is an example, posted as written",
    text: `\`\`\`\`md\n\`\`\`suggestion\nx\n\`\`\`\n\`\`\`\``,
    inert: `\`\`\`\`md\n\`\`\`suggestion\nx\n\`\`\`\n\`\`\`\``,
  },
  {
    name: "a suggestion never closed",
    text: `\`\`\`suggestion\n/x`,
    inert: "refused",
  },
  {
    name: "a suggestion with more in its info string: posted as written",
    text: `\`\`\`suggestion:-0+0 extra\nx\n\`\`\``,
    inert: `\`\`\`suggestion:-0+0 extra\nx\n\`\`\``,
    suggestions: [`x`],
  },
  {
    name: "a suggestion behind a named reference: posted as written",
    text: `\`\`\`sugg&shy;estion\nx\n\`\`\``,
    inert: `\`\`\`sugg&shy;estion\nx\n\`\`\``,
  },
  {
    name: "a `<pre>` naming a suggestion, with a `/` line",
    text: `<pre lang="suggestion">\n/x\n</pre>`,
    inert: "refused",
  },
  {
    name: "a suggestion in raw HTML, its language on a line of its own: posted as written",
    text: `Fix:\n\n<pre data-canonical-lang=\n"suggestion" data-lang-params="-0+0"><code>/x\n` +
      `</code></pre>`,
    inert: `Fix:\n\n<pre data-canonical-lang=\n"suggestion" data-lang-params="-0+0"><code>/x\n` +
      `</code></pre>`,
    suggestions: [`/x`],
  },
  {
    name: "a suggestion in raw HTML, decoded as HTML5 does: posted as written",
    text: `<pre data-canonical-lang="&#115uggestion"><code>keep\n</code></pre>`,
    inert: `<pre data-canonical-lang="&#115uggestion"><code>keep\n</code></pre>`,
    suggestions: [`keep`],
  },
  {
    name: "prose that mentions suggestions, a class and a lang opens no code block",
    text: `Replaced the \`<ul class="suggestions">\` list\n\`\`\`html\n<li class="suggestion">\n` +
      `\`\`\`\nx \`\`\`suggestion is text`,
    inert: `Replaced the \`<ul class="suggestions">\` list\n\`\`\`html\n<li class="suggestion">\n` +
      `\`\`\`\nx \`\`\`suggestion is text`,
  },
];
