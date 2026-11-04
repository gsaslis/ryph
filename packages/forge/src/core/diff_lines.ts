// Which lines of a pull request's diff a review remark can anchor to. Pure — the forge's
// unified-diff `patch` per file arrives as text — so a remark GitHub would refuse is refused
// before the review is reserved, where the refusal costs the run no cap.
//
// Invariants:
// - RIGHT is the file's new version: added and context lines, by new numbering; LEFT is its old
//   version: deleted and context lines, by old numbering — the forge's own anchoring rule
// - a review is all or nothing on the forge, so every remark is checked and every bad one named
//   in one answer: the agent fixes them together instead of spending an attempt per remark

export type DiffSide = "LEFT" | "RIGHT";

/** The anchorable lines of one file, per side. */
export interface AnchorableLines {
  LEFT: Set<number>;
  RIGHT: Set<number>;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses one file's `patch` — its hunks, without the `diff --git` header.
 *
 * A hunk is read for exactly the lines its header counts, never "until the next header": the text
 * can end in a newline (GitLab's per-file `diff` does, GitHub's `patch` does not), and the empty
 * string after it is no line of the file — read as context, it advertised an added file's line
 * n+1 on RIGHT and line 0 on LEFT. Within the count a context line is " ", and "" too: a blank
 * context line some tool stripped of its space is still a line. A side whose count is 0
 * (`@@ -0,0` for an added file) gets no line at all.
 */
export function anchorableLines(patch: string): AnchorableLines {
  const out: AnchorableLines = { LEFT: new Set(), RIGHT: new Set() };
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(HUNK);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      continue;
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) {
      if (newLeft === 0) continue;
      out.RIGHT.add(newLine++);
      newLeft--;
    } else if (line.startsWith("-")) {
      if (oldLeft === 0) continue;
      out.LEFT.add(oldLine++);
      oldLeft--;
    } else if (line === "" || line.startsWith(" ")) {
      if (oldLeft === 0 || newLeft === 0) continue;
      out.LEFT.add(oldLine++);
      out.RIGHT.add(newLine++);
      oldLeft--;
      newLeft--;
    }
  }
  return out;
}

/** A side's lines as ranges a model can read: "lines 10–40, 88–95". */
export function describeLines(lines: Set<number>): string {
  const sorted = [...lines].sort((a, b) => a - b);
  if (sorted.length === 0) return "no lines";
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const n of [...sorted.slice(1), Number.NaN]) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  return `${sorted.length === 1 ? "line" : "lines"} ${ranges.join(", ")}`;
}

/** One remark as the check sees it. */
export interface Remark {
  path: string;
  line: number;
  side: DiffSide;
}

/**
 * Every remark that cannot anchor, as sentences numbered by the remark's position (from 1).
 * `complete` false: a path missing from the listing may be a file the forge stopped listing
 * before, so it passes through to the forge to decide.
 */
export function unanchoredRemarks(
  files: ReadonlyArray<{ path: string; patch: string | null }>,
  complete: boolean,
  remarks: readonly Remark[],
): string[] {
  const byPath = new Map(files.map((f) => [f.path, f.patch]));
  const parsed = new Map<string, AnchorableLines>();
  const problems: string[] = [];
  remarks.forEach((remark, i) => {
    const at = `remark ${i + 1} (${remark.path}:${remark.line})`;
    if (!byPath.has(remark.path)) {
      if (complete) problems.push(`${at}: the pull request does not change that file`);
      return;
    }
    const patch = byPath.get(remark.path)!;
    if (patch === null) {
      problems.push(`${at}: the forge shows no diff for that file, so nothing can anchor there`);
      return;
    }
    let lines = parsed.get(remark.path);
    if (lines === undefined) {
      lines = anchorableLines(patch);
      parsed.set(remark.path, lines);
    }
    if (!lines[remark.side].has(remark.line)) {
      problems.push(
        `${at}: not a line of the diff on side ${remark.side}; there it has ${
          describeLines(lines[remark.side])
        }`,
      );
    }
  });
  return problems;
}
