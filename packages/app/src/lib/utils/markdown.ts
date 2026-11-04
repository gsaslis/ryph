import { Marked } from "marked";
import rehypeParse from "rehype-parse";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";

// Markdown for model output, on its way into `{@html}`.
//
// An agent writes whatever it decides to write, and what it decides is shaped by repos, issue text
// and tool output it was pointed at — so its markup is untrusted by construction, not by suspicion,
// and it renders in a session holding the operator's cookies.
//
// So the markup is sanitized after it is generated, by rehype-sanitize, against an allowlist of the
// tags and attributes the renderers below actually emit. Anything else — whatever produced it — is
// not in the allowlist and does not survive.
//
// The load-bearing word is AFTER. Making marked emit only safe markup does not work, and the way it
// fails is worth keeping in mind: marked's LEXER flips an `inRawBlock` flag when it tokenizes
// `<pre`, `<code`, `<kbd` or `<script`, and its inline text handler stops escaping while that flag
// is set. A renderer override cannot unset it — it runs after tokenizing, on the tag it was handed,
// not on the flag. So an unclosed `<kbd>` turned escaping off for the rest of the message, and
// `Hello <kbd> <img/src=x onerror=alert(1)>` reached `{@html}` raw. Any fix that lives in a renderer
// is patching one hole in a lexer that decides, on its own, when to escape.
//
// rehype rather than the two more obvious sanitizers, for one reason each. sanitize-html is a
// CommonJS Node library: Vite's SSR loads it only while it stays external, and the moment it is
// inlined (`ssr.noExternal`, or a bundling adapter) it fails with "require is not defined" — a
// build setting away from breaking the page. DOMPurify wants a DOM, which SSR does not have, so it
// arrives towing jsdom and the same CJS problem — or it sanitizes only in the browser, leaving the
// server rendering unsanitized markup and hydration reconciling two different answers.
//
// The rehype chain is pure ESM and needs no DOM, so the identical code runs on both sides of the
// wire. That is the property that matters here: one sanitizer, one result, nothing to disagree about.
//
// The renderers below are kept for what they do to READABLE output, not for safety: they are the
// reason raw HTML shows as text instead of vanishing, and the reason a fence arrives as a shell the
// highlighter can mount onto. The sanitizer is what makes any of it safe to hand to `{@html}`.

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The href back, or null if it is not a scheme that can only ever navigate. */
function safeHref(href: string): string | null {
  try {
    // The base is only ever used to give a relative href a protocol to read; it is never emitted.
    const { protocol } = new URL(href, "https://ryph.invalid");
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:" ? href : null;
  } catch {
    return null; // not a URL at all
  }
}

/**
 * An image the agent took with a tool, as it names it in what it writes: `![alt](img-3f9a1c0b2d4e)`.
 * The ref is the first 12 hex characters of the SHA-256 of the image's bytes.
 */
export const IMAGE_REF = /^img-[0-9a-f]{12}$/;

/**
 * The refs the text being rendered may show, for the length of one synchronous `renderMarkdown`.
 * Null when the caller has none to offer, which leaves every image as its markdown source.
 * `run` allows well-formed refs to resolve through the authorized run's attachment endpoint,
 * without requiring the tool event that produced the image to be loaded in the transcript.
 */
let imageRefs: ReadonlySet<string> | "run" | null = null;

const markdown = new Marked({ gfm: true, breaks: true, async: false });

markdown.use({
  renderer: {
    /**
     * Raw HTML is shown, not run. Escaping beats dropping here: an agent that writes `<memory>…`
     * or talks about a tag should have that survive on screen rather than silently vanish.
     */
    html({ text }) {
      return escapeHtml(text);
    },

    /**
     * Images render as their markdown source. Nothing in a transcript should fetch a remote URL
     * just because somebody opened the page — an `<img>` is the one tag that dials out on render
     * rather than on a click, which makes it a read receipt for the operator.
     */
    image({ href, text }) {
      // An image the agent took itself and the caller can show: a placeholder the Markdown
      // component mounts the thumbnail into, holding the alt text until then. A ref the caller
      // does not know reads as its alt text. Neither ever becomes an <img>.
      if (imageRefs !== null && IMAGE_REF.test(href)) {
        const alt = escapeHtml(text.trim() || "Image");
        return imageRefs === "run" || imageRefs.has(href)
          ? `<span data-image-ref="${href}">${alt}</span>`
          : alt;
      }
      return escapeHtml(`![${text}](${href})`);
    },

    /**
     * A fenced block, as the shell a real highlighter is mounted onto (see markdown.svelte) and as
     * what stands in until then — server-rendered, or if the highlighter never loads.
     *
     * Emitted rather than left to marked's default `<pre><code>` because of what prose does to that
     * pair: it paints every `<pre>` with the typography plugin's own slate fill, which is dark in
     * light mode too, and the chip these styles put on inline `code` lands on the block's `code` as
     * well — where, being inline, its background breaks into one chip per line. Hence `not-prose`
     * and no inner `code` at all. The margin is here because `not-prose` also drops the spacing
     * prose would have given the block.
     */
    code({ text, lang }) {
      // An info string is `lang` plus whatever else the author wrote after it (`js title="x"`).
      const name = lang?.trim().split(/\s+/)[0];
      const langAttr = name ? ` data-lang="${escapeHtml(name)}"` : "";
      return `<pre data-code-block${langAttr} class="not-prose bg-muted my-4 overflow-x-auto rounded-xl p-3 font-mono text-xs whitespace-pre">${
        escapeHtml(text)
      }</pre>`;
    },

    /** Links keep their text but lose any href that could execute (`javascript:`, `data:`). */
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      if (safe === null) return text;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      // Opened away from the app, and denied any handle back on the window that opened it.
      return `<a href="${
        escapeHtml(safe)
      }"${titleAttr} target="_blank" rel="noreferrer noopener">${text}</a>`;
    },
  },
});

// The allowlist: rehype's default schema (the GitHub-comment set — headings, lists, tables, code,
// emphasis) narrowed and then widened to exactly what the renderers above emit.
//
// Attribute names here are hast property names, not HTML ones: `class` is `className`,
// `data-code-block` is `dataCodeBlock`. Getting that wrong fails silently — the attribute is simply
// dropped — which is why the round-trip is pinned by a test.
const schema = {
  ...defaultSchema,
  // `img` is dropped rather than allowed, because an <img> is the one tag that dials out on render
  // rather than on a click, which makes it a read receipt for whoever is looking at the page. The
  // `image` renderer above already turns markdown image syntax into text; this is what covers an
  // <img> arriving as raw HTML, which the renderer never sees.
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => tag !== "img"),
  protocols: {
    ...defaultSchema.protocols,
    // The default also permits irc/ircs/xmpp, which hand a URL to whatever local client claims the
    // scheme. Narrowed to the three that can only ever navigate — matching `safeHref` above.
    href: ["http", "https", "mailto"],
  },
  attributes: {
    ...defaultSchema.attributes,
    // The default allows `href` but neither `target` nor `rel` — so without these the link renderer's
    // `rel="noreferrer noopener"` would be stripped back off and `target="_blank"` with it.
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
    // The marker the image renderer puts where an agent's own image goes.
    span: [...(defaultSchema.attributes?.span ?? []), "dataImageRef"],
    // The default allows nothing on `pre`, which would strip the marker `markdown.svelte` finds the
    // shell by, the language it infers from, and the classes that keep prose from repainting it.
    pre: [
      ...(defaultSchema.attributes?.pre ?? []),
      "dataCodeBlock",
      "dataLang",
      "className",
    ],
  },
};

const sanitizer = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeSanitize, schema)
  .use(rehypeStringify);

/**
 * Model-authored markdown as HTML that is safe to hand to `{@html}`.
 *
 * `breaks` keeps every newline a line break, which is how a chat message reads. A document written
 * in an editor (a skill's `SKILL.md`) is hard-wrapped instead, and wants `breaks: false`, or every
 * paragraph comes out as a column of short lines.
 */
export function renderMarkdown(
  content: string,
  opts: { breaks?: boolean; imageRefs?: ReadonlySet<string> | "run" } = {},
): string {
  const breaks = opts.breaks ?? true;
  imageRefs = opts.imageRefs ?? null;
  try {
    return String(sanitizer.processSync(markdown.parse(content, { async: false, breaks })));
  } finally {
    imageRefs = null;
  }
}
