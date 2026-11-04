// Splitting `git diff`'s output into one unified patch per file — the shape every forge API
// hands a reviewer, and the shape a review remark anchors against.
//
// It exists because a review is anchored to a LINE OF THE DIFF, not to a line of the file: the
// forge side checks each remark against the hunks before it posts anything, and with no hunk
// text there is nothing to check, so every remark is refused. A file-by-file stat cannot answer
// that question; only the hunks can.
//
// Pure, and deliberately small: the header lines (`diff --git`, `index`, `---`, `+++`, mode
// changes) are stripped, so `patch` starts at the first `@@` exactly as GitHub's does. A file
// with no hunks at all — a binary, a pure rename — has no patch, and says so with null rather
// than with an empty string that would read as "an empty diff".

export interface FilePatch {
  path: string;
  /** The file's hunks, from the first `@@`. Null where the diff carries none. */
  patch: string | null;
}

/** `diff --git a/<old> b/<new>` — the fallback for a section with no `---`/`+++` at all. */
const HEADER = /^diff --git a\/(.+) b\/(.+)$/;

/** The path a file section is ABOUT: its new name, or its old one when it was deleted.
 *
 * The `+++`/`---` pair is the authority where there is one. A binary file and a pure rename
 * have neither — git prints "Binary files … differ" or nothing at all — and then the section
 * header is all there is, which is also why a path with a space in it can only be a guess
 * there. Guessing beats dropping the file: a reader that never heard of it would read "the
 * change request does not touch that file", which is a lie. */
function pathOf(lines: string[]): string | null {
  let fromA: string | null = null;
  for (const line of lines) {
    if (line.startsWith("+++ b/")) return line.slice("+++ b/".length);
    if (line.startsWith("+++ /dev/null")) return fromA;
    if (line.startsWith("--- a/")) fromA = line.slice("--- a/".length);
    if (line.startsWith("@@")) break;
  }
  if (fromA !== null) return fromA;
  const header = HEADER.exec(lines[0] ?? "");
  return header === null ? null : header[2];
}

/** Every file section of one `git diff`, in the order git printed them. */
export function splitUnifiedDiff(text: string): FilePatch[] {
  const out: FilePatch[] = [];
  if (text.trim() === "") return out;
  // Split on the section header rather than scanning for it: a `diff --git` line can appear
  // inside a hunk (a patch file being reviewed), but never at the start of one — every hunk
  // line carries a leading space, `+` or `-`.
  const sections = text.split(/\n(?=diff --git )/);
  for (const section of sections) {
    if (!section.startsWith("diff --git ")) continue;
    const lines = section.split("\n");
    const path = pathOf(lines);
    if (path === null) continue;
    const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
    out.push({
      path,
      patch: firstHunk === -1 ? null : lines.slice(firstHunk).join("\n").replace(/\n+$/, ""),
    });
  }
  return out;
}
