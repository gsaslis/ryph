import rehypeParse from "rehype-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

// The sanitizer, pinned. This renders model-authored markup into `{@html}` in a session holding the
// operator's cookies, so it is the one place in the app where a regression is a vulnerability rather
// than a bug.
//
// Run by vitest rather than `bun test`, deliberately: these assertions are only worth as much as
// the pipeline they run through. The module ships through Vite (SSR and browser), and Vite's SSR
// transform is precisely what rules sanitizers in or out here — it is why sanitize-html could not be
// used. A runner outside that pipeline would prove the sanitizer works somewhere it never runs.
//
// The assertions PARSE the output rather than grepping it, on purpose. Escaped text contains the
// same bytes as live markup — `&#x3C;img/src=x onerror=alert(1)>` is inert, and a substring check
// for "onerror=" calls it a leak; a check for "<img" calls the same string safe. Only the parse
// knows which nodes are elements. Grepping this output is how you get a green suite over a hole.

interface Node {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

function elements(html: string): Node[] {
  const tree = unified().use(rehypeParse, { fragment: true }).parse(html) as Node;
  const found: Node[] = [];
  const walk = (node: Node) => {
    if (node.type === "element") found.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return found;
}

/** Every way a rendered node could execute, dial out, or navigate somewhere it shouldn't. */
function threats(html: string): string[] {
  const found: string[] = [];
  for (const el of elements(html)) {
    const tag = el.tagName ?? "?";
    if (
      ["script", "iframe", "object", "embed", "svg", "img", "form", "input", "style"].includes(tag)
    ) {
      found.push(`<${tag}>`);
    }
    for (const [name, value] of Object.entries(el.properties ?? {})) {
      if (/^on/i.test(name)) found.push(`<${tag} ${name}>`);
      if (name === "srcDoc") found.push(`<${tag} srcdoc>`);
      if ((name === "href" || name === "src") && typeof value === "string") {
        if (/^\s*(javascript|data|vbscript|irc|ircs|xmpp):/i.test(value)) {
          found.push(`<${tag} ${name}=${value.split(":")[0]}:>`);
        }
      }
    }
  }
  return found;
}

const tagsOf = (markdown: string) => elements(renderMarkdown(markdown)).map((e) => e.tagName);

describe("nothing model-authored can execute", () => {
  // The bypass this suite exists for. marked's LEXER flips `inRawBlock` when it tokenizes `<pre`,
  // `<code`, `<kbd` or `<script`, and stops escaping inline text until the tag closes. A renderer
  // override cannot unset that flag, so before the sanitizer an unclosed opener disabled escaping
  // for the rest of the message and `<img/src=x onerror=…>` — which evades marked's inline tag
  // regex via the `/`, but is valid HTML5 — reached `{@html}` raw and fired on render.
  it.each(["<kbd>", "<pre>", "<code>", "<script>"])(
    "an unclosed %s cannot smuggle live markup past the escaper",
    (opener) => {
      expect(threats(renderMarkdown(`Hello ${opener} <img/src=x onerror=alert(1)>`))).toEqual([]);
      expect(threats(renderMarkdown(`Hello ${opener} <svg/onload=alert(1)>`))).toEqual([]);
      expect(
        threats(renderMarkdown(`Hello ${opener} <iframe/srcdoc='<script>alert(1)</script>'>`)),
      ).toEqual([]);
    },
  );

  it.each([
    ["a later paragraph", "Hello <kbd>\n\nnext para <img/src=x onerror=alert(1)>"],
    ["a heading", "Hello <kbd>\n\n# <img/src=x onerror=alert(1)>"],
    ["a list item", "Hello <kbd>\n\n- <img/src=x onerror=alert(1)>"],
  ])("the leak does not resume in %s", (_, input) => {
    expect(threats(renderMarkdown(input))).toEqual([]);
  });

  it("form controls cannot be conjured into the page", () => {
    expect(threats(renderMarkdown("Hello <kbd> <form action=//evil.test><input name=p>"))).toEqual(
      [],
    );
  });
});

// An <img> is the one tag that dials out on render rather than on a click, which makes it a read
// receipt for whoever opened the page. The `image` renderer covers markdown syntax; the schema is
// what covers an <img> arriving as raw HTML, which that renderer never sees.
describe("nothing dials out on render", () => {
  it("a raw img riding the leak is dropped", () => {
    // This exact payload is load-bearing, so it is worth saying why. A well-formed `<img src=…>` is
    // caught by marked's inline tag regex and escaped by the `html` renderer — it never reaches the
    // sanitizer and proves nothing about the schema. The `/` evades that regex so the tag rides the
    // raw-block leak and is parsed as a real element; the protocol-relative `//` survives marked's
    // mangling of a quoted URL. Together that makes it the one form that genuinely fetches a remote
    // host if `img` is ever added back to the allowlist. Verified: it does.
    expect(threats(renderMarkdown("Hello <kbd> <img/src=//evil.test/t.gif>"))).toEqual([]);
  });

  it("a well-formed raw img is escaped by the renderer", () => {
    expect(threats(renderMarkdown("Hello <kbd> <img src='https://evil.test/t.gif'>"))).toEqual([]);
  });

  it("a markdown image renders as text, not an element", () => {
    expect(tagsOf("![alt](https://evil.test/t.gif)")).toEqual(["p"]);
  });
});

describe("links", () => {
  // These are stopped by `safeHref` in the renderer, before the sanitizer ever sees them.
  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "irc://evil.test/x",
    "vbscript:alert(1)",
  ])("a markdown link to %s renders as bare text, with no anchor", (href) => {
    expect(threats(renderMarkdown(`[click](${href})`))).toEqual([]);
    expect(tagsOf(`[click](${href})`)).toEqual(["p"]);
  });

  // A raw <a> riding the raw-block leak never passes through `safeHref` — the renderer only sees
  // markdown link syntax. So the schema's protocol list is the ONLY thing standing here, which is
  // why it is narrowed from rehype's default (that default also permits irc/ircs/xmpp, each of
  // which hands a URL to whatever local client claims the scheme). Verified reachable: widening the
  // list back to the default lets `<a/href=irc://…>` through as a live anchor.
  it.each(["irc://evil.test/x", "xmpp:evil@evil.test", "javascript:alert(1)"])(
    "a raw anchor cannot carry %s",
    (href) => {
      expect(threats(renderMarkdown(`Hello <kbd> <a/href=${href}>click</a>`))).toEqual([]);
    },
  );

  it("a safe link keeps the handle it is denied back on the window", () => {
    const a = elements(renderMarkdown("[x](https://ok.test)")).find((e) => e.tagName === "a");
    expect(a?.properties?.href).toBe("https://ok.test");
    expect(a?.properties?.target).toBe("_blank");
    // rel arrives parsed as a list of tokens.
    expect([a?.properties?.rel].flat()).toEqual(["noreferrer", "noopener"]);
  });
});

// Everything below is the readable-output contract the renderers exist for. It is here because the
// sanitizer is an allowlist: a schema that forgets an attribute does not fail loudly, it silently
// drops it — and `data-code-block` going missing would quietly disable syntax highlighting.
describe("readable output survives the sanitizer", () => {
  it("a fenced block survives as the shell the highlighter mounts onto", () => {
    const pre = elements(renderMarkdown("```js\nconst a = 1 < 2;\n```"))
      .find((e) => e.tagName === "pre");
    expect(pre, "the fence must render as <pre>").toBeDefined();
    // markdown.svelte finds the shell by this marker.
    expect(pre?.properties).toHaveProperty("dataCodeBlock");
    expect(pre?.properties?.dataLang).toBe("js");
    // not-prose keeps the typography plugin from repainting the block.
    expect(String(pre?.properties?.className ?? "")).toContain("not-prose");
  });

  it("fenced code round-trips exactly once, so textContent reads back the source", () => {
    // markdown.svelte hands `shell.textContent` to the highlighter. Escaped on the way in and read
    // back through the DOM, this must be the source the model wrote — not a double-escaped copy.
    const pre = elements(renderMarkdown("```js\nconst a = 1 < 2 && b > 3;\n```"))
      .find((e) => e.tagName === "pre");
    const text = (pre?.children ?? []).map((c) => (c as { value?: string }).value ?? "").join("");
    expect(text).toBe("const a = 1 < 2 && b > 3;");
  });

  it("raw HTML is shown rather than dropped", () => {
    // An agent that writes <memory>… or talks about a tag should have that survive on screen.
    const html = renderMarkdown("an agent wrote <memory>hi</memory>");
    expect(elements(html).map((e) => e.tagName)).toEqual(["p"]);
    expect(html).toContain("memory");
  });

  it("ordinary markdown still renders", () => {
    const tags = new Set(
      tagsOf("# Hi\n\n**b** and `c`\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |"),
    );
    for (const tag of ["h1", "strong", "code", "ul", "li", "table", "td"]) {
      expect(tags, `${tag} must survive the sanitizer`).toContain(tag);
    }
  });

  it("keeps a newline a break for a message, and joins a hard-wrapped document's lines", () => {
    expect(tagsOf("one\ntwo")).toContain("br");
    expect(elements(renderMarkdown("one\ntwo", { breaks: false })).map((e) => e.tagName))
      .not.toContain("br");
  });
});

describe("an agent's own images", () => {
  const ref = "img-3f9a1c0b2d4e";
  const refs = new Set([ref]);

  it("resolves transcript refs without a loaded tool event, but never external images", () => {
    const html = renderMarkdown(
      `![screen](${ref}) ![remote](https://evil.test/a.png) ![bad](img-invalid)`,
      { imageRefs: "run" },
    );
    expect(html).toContain(`<span data-image-ref="${ref}">screen</span>`);
    expect(html).toContain("![remote](https://evil.test/a.png)");
    expect(html).toContain("![bad](img-invalid)");
    expect(html).not.toContain("<img");
    expect(renderMarkdown(`![screen](${ref})`)).not.toContain("data-image-ref");
  });

  it("a known ref becomes the placeholder the thumbnail mounts into, holding its alt", () => {
    const html = renderMarkdown(`Fixed.\n\n![login page after the fix](${ref})`, {
      imageRefs: refs,
    });
    const span = elements(html).find((e) => e.tagName === "span");
    expect(span?.properties?.dataImageRef).toBe(ref);
    expect(html).toContain("login page after the fix");
    expect(threats(html)).toEqual([]);
  });

  it("an unknown ref reads as its alt text, an empty alt as Image", () => {
    const other = "img-000000000000";
    expect(renderMarkdown(`![the form](${other})`, { imageRefs: refs })).toBe("<p>the form</p>\n");
    expect(renderMarkdown(`![](${other})`, { imageRefs: refs })).toBe("<p>Image</p>\n");
  });

  it("every other image still renders as its source, and no img survives", () => {
    const html = renderMarkdown(`![x](https://evil.test/p.png) ![y](${ref}x)`, {
      imageRefs: refs,
    });
    expect(elements(html).map((e) => e.tagName)).not.toContain("img");
    expect(html).toContain("https://evil.test/p.png");
    expect(elements(html).some((e) => e.properties?.dataImageRef !== undefined)).toBe(false);
  });

  it("without refs to offer, a ref is left as the agent wrote it", () => {
    expect(renderMarkdown(`![shot](${ref})`)).toContain(`![shot](${ref})`);
  });

  it("an alt cannot smuggle markup into the placeholder", () => {
    const html = renderMarkdown(`![<img src=x onerror=alert(1)>](${ref})`, { imageRefs: refs });
    expect(threats(html)).toEqual([]);
    expect(elements(html).map((e) => e.tagName)).not.toContain("img");
  });

  it("raw HTML cannot forge a placeholder", () => {
    const html = renderMarkdown(`<span data-image-ref="${ref}">x</span>`, { imageRefs: refs });
    expect(elements(html).some((e) => e.properties?.dataImageRef !== undefined)).toBe(false);
  });
});
