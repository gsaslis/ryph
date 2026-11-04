// Merge request suggestions: a code block whose language is `suggestion` (`suggestion:-1+2` to
// take lines above and below too) in a diff note on a new line, wherever in the note it sits —
// GitLab finds them in the rendered note (`Gitlab::Diff::SuggestionsParser`). Raw HTML makes one
// too: GitLab keeps a `<pre>`'s `data-canonical-lang` and `data-lang-params`
// (`BaseSanitizationFilter`) and reads the first as the block's language, so
// `<pre data-canonical-lang="suggestion">` is a suggestion of the `<pre>`'s text — its attributes
// spread over lines as HTML allows. Read after GitLab's pre-processing (`preProcessed`): a leading
// byte-order mark dropped, and front matter made a fence — `---suggestion` … `---` at the note's
// start is a suggestion too. Found anywhere in the note, a code block's text included: a
// fake that finds more suggestions than GitLab, never fewer. "Apply suggestion"
// (`PUT /suggestions/:id/apply`) commits the block's text in place of those lines onto the source
// branch, as the person applying it; only while the note's diff is the merge request's latest.

import { ApiError } from "./errors.ts";
import { git } from "./git/repo.ts";
import { type Ctx, json, type Router, str } from "./http.ts";
import type { Instance } from "./instance.ts";
import { blocksOf, preProcessed } from "./markdown.ts";
import { ACCESS, type MergeRequest, type Note } from "./model.ts";
import { signedIn } from "./routes/common.ts";

export interface Suggestion {
  id: number;
  fromLine: number;
  toLine: number;
  fromContent: string;
  toContent: string;
  applied: boolean;
}

/** `Gitlab::Diff::SuggestionsParser`'s `data-lang-params`, read from their start: a fence's
 * language is what comes before its info string's first `:`, its params the rest, so
 * `suggestion:-2+0:frontmatter` is a suggestion of two lines above. */
const PARAMS = /^(?:-(\d+))?(?:\+(\d+))?/;
/** A `<pre>` element: its attributes (quoted values may hold `>` and line breaks) and inside. */
const PRE = /<pre(?=[\s>/])((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/pre\s*>/gi;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
/** HTML's character references (GitLab parses a note's HTML as HTML5 does): a numeric one needs
 * no `;` and may have any number of digits. */
const ENTITY = /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|(amp|lt|gt|quot|apos);)/g;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const codePoint = (n: number) => n === 0 || n > 0x10ffff ? "\uFFFD" : String.fromCodePoint(n);
const decodeHtml = (s: string) =>
  s.replace(
    ENTITY,
    (_, hex, dec, named) =>
      hex !== undefined
        ? codePoint(parseInt(hex, 16))
        : dec !== undefined
        ? codePoint(Number(dec))
        : NAMED[named]!,
  );

/** The suggestions raw HTML makes: each `<pre>` whose `data-canonical-lang` is `suggestion`,
 * its lines above and below, and its text (tags dropped, the line break after `<pre>` too). */
function htmlSuggestions(body: string): Array<{ above: number; below: number; text: string }> {
  const out: Array<{ above: number; below: number; text: string }> = [];
  for (const pre of body.matchAll(PRE)) {
    const attrs = new Map<string, string>();
    for (const a of pre[1]!.matchAll(ATTR)) {
      const name = a[1]!.toLowerCase();
      if (!attrs.has(name)) attrs.set(name, decodeHtml(a[2] ?? a[3] ?? a[4] ?? ""));
    }
    if (attrs.get("data-canonical-lang")?.toLowerCase() !== "suggestion") continue;
    const params = PARAMS.exec(attrs.get("data-lang-params") ?? "");
    out.push({
      above: Number(params?.[1] ?? 0),
      below: Number(params?.[2] ?? 0),
      text: decodeHtml(pre[2]!.replace(/<[^>]*>/g, "")).replace(/^\n/, ""),
    });
  }
  return out;
}

/** A file's text at `sha`, or null when it has no such file. */
async function fileAt(gitDir: string, sha: string, path: string): Promise<string | null> {
  const r = await git(gitDir, ["cat-file", "blob", `${sha}:${path}`], { ok: [128] });
  return r.code === 0 ? r.stdout : null;
}

/** The suggestions GitLab finds in a diff note's `body`, in order: each with its lines above and
 * below and its text. */
export function suggestionsIn(
  body: string,
): Array<{ above: number; below: number; text: string }> {
  const text = preProcessed(body.replaceAll("\r", ""));
  return [
    ...blocksOf(text).fences.flatMap((f) => {
      const [lang, ...params] = (f.info.split(/\s/)[0] ?? "").split(":");
      if (lang !== "suggestion") return [];
      const m = PARAMS.exec(params.join(":"))!;
      return [{
        above: Number(m[1] ?? 0),
        below: Number(m[2] ?? 0),
        text: f.content.map((l) => `${l}\n`).join(""),
      }];
    }),
    ...htmlSuggestions(text),
  ];
}

/** A file's lines, each with its line break. */
const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** The suggestions `note` carries, read again from its body (as GitLab does on every edit). */
export async function suggestionsOf(
  gl: Instance,
  mr: MergeRequest,
  note: Note,
): Promise<Suggestion[] | undefined> {
  const pos = note.position;
  if (note.type !== "DiffNote" || pos === null || pos.new_line === null) return undefined;
  const found = suggestionsIn(note.body);
  if (found.length === 0) return [];
  const source = gl.world.projects.get(mr.sourceProjectId) ??
    gl.world.projects.get(mr.projectId)!;
  const file = linesOf(
    (await fileAt(source.gitDir, pos.head_sha, pos.new_path)) ??
      (await fileAt(gl.world.projects.get(mr.projectId)!.gitDir, pos.head_sha, pos.new_path)) ??
      "",
  );
  return found.map((s) => {
    const fromLine = Math.max(1, pos.new_line! - s.above);
    const toLine = pos.new_line! + s.below;
    return {
      id: gl.world.nextId("suggestion"),
      fromLine,
      toLine,
      fromContent: file.slice(fromLine - 1, toLine).join(""),
      toContent: s.text,
      applied: false,
    };
  });
}

export function presentSuggestion(s: Suggestion, appliable: boolean) {
  return {
    id: s.id,
    from_line: s.fromLine,
    to_line: s.toLine,
    appliable: appliable && !s.applied,
    applied: s.applied,
    from_content: s.fromContent,
    to_content: s.toContent,
  };
}

function find(ctx: Ctx): { mr: MergeRequest; note: Note; suggestion: Suggestion } {
  const id = Number(ctx.params.suggestion_id);
  for (const mr of ctx.gl.world.mergeRequests) {
    for (const d of mr.discussions) {
      for (const note of d.notes) {
        const suggestion = note.suggestions?.find((s) => s.id === id);
        if (suggestion && ctx.gl.canSeeNoteable(ctx.user, mr)) return { mr, note, suggestion };
      }
    }
  }
  throw new ApiError(404, { message: "404 Suggestion Not Found" });
}

export function suggestionRoutes(r: Router) {
  r.add("PUT", "/suggestions/:suggestion_id/apply", async (ctx) => {
    const user = signedIn(ctx);
    const { mr, note, suggestion } = find(ctx);
    const source = ctx.gl.world.projects.get(mr.sourceProjectId)!;
    if (!ctx.gl.world.can(user, source, ACCESS.developer)) {
      return json({ message: "403 Forbidden" }, 403);
    }
    if (
      suggestion.applied || mr.state !== "opened" || note.position?.head_sha !== mr.headSha
    ) {
      return json({ message: "A suggestion is not applicable." }, 400);
    }
    const path = note.position.new_path;
    const lines = linesOf((await fileAt(source.gitDir, mr.headSha, path)) ?? "");
    const after = lines.slice(0, suggestion.fromLine - 1).join("") + suggestion.toContent +
      lines.slice(suggestion.toLine).join("");
    await ctx.gl.commit(user, source, {
      branch: mr.sourceBranch,
      files: { [path]: after },
      message: str(ctx.input.commit_message) ?? "Apply 1 suggestion(s) to 1 file(s)",
    });
    suggestion.applied = true;
    return json(presentSuggestion(suggestion, false));
  });
}
