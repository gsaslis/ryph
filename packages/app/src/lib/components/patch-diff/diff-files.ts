// A patch's diff, as the detail page draws it: the one unified text the server sends, split into
// files, each with what the file tree needs to colour it. Pure, so it is tested away from the
// renderer; the parse itself is the diff library's.

import type { FileDiffMetadata } from "@pierre/diffs";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";

export interface DiffStats {
  additions: number;
  deletions: number;
}

/** Lines added and removed in one file, counted from its hunks. */
export function fileStats(file: FileDiffMetadata): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

/** A line as the diff holds it, without its line ending. */
const bare = (line: string) => line.replace(/\r?\n$/, "");

/**
 * What changed about the file besides its lines, as git's own header says it: a rename, a file
 * made or removed, a mode changed. A file with neither these nor hunks changed in a way the diff
 * does not show line by line (a binary file).
 */
function headerLines(file: FileDiffMetadata): string[] {
  const out: string[] = [];
  if (file.prevName !== undefined && file.prevName !== file.name) {
    out.push(`rename from ${file.prevName}`, `rename to ${file.name}`);
  }
  if (file.type === "new") out.push(`new file${file.mode ? ` mode ${file.mode}` : ""}`);
  else if (file.type === "deleted") {
    out.push(`deleted file${file.mode ? ` mode ${file.mode}` : ""}`);
  } else if (
    file.prevMode !== undefined && file.mode !== undefined && file.prevMode !== file.mode
  ) {
    out.push(`old mode ${file.prevMode}`, `new mode ${file.mode}`);
  }
  if (out.length === 0 && file.hunks.length === 0) out.push("contents changed, no lines to show");
  return out;
}

/**
 * The file as unified diff lines again — what git's header says changed, then each hunk's header
 * and lines with their ` `, `-` or `+` — for a file the renderer could not draw: shown plain, but
 * shown, renames and binary changes included.
 */
export function plainLines(file: FileDiffMetadata): string[] {
  const out = headerLines(file);
  for (const hunk of file.hunks) {
    out.push(
      bare(
        hunk.hunkSpecs ??
          `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`,
      ),
    );
    for (const part of hunk.hunkContent) {
      if (part.type === "context") {
        for (let i = 0; i < part.lines; i++) {
          out.push(` ${bare(file.additionLines[part.additionLineIndex + i] ?? "")}`);
        }
      } else {
        for (let i = 0; i < part.deletions; i++) {
          out.push(`-${bare(file.deletionLines[part.deletionLineIndex + i] ?? "")}`);
        }
        for (let i = 0; i < part.additions; i++) {
          out.push(`+${bare(file.additionLines[part.additionLineIndex + i] ?? "")}`);
        }
      }
    }
  }
  return out;
}

export function totalStats(files: FileDiffMetadata[]): DiffStats {
  const total = { additions: 0, deletions: 0 };
  for (const file of files) {
    const stats = fileStats(file);
    total.additions += stats.additions;
    total.deletions += stats.deletions;
  }
  return total;
}

const STATUS: Record<FileDiffMetadata["type"], GitStatus> = {
  change: "modified",
  new: "added",
  deleted: "deleted",
  "rename-pure": "renamed",
  "rename-changed": "renamed",
};

/** How each file changed, keyed by the path the tree shows it under: its new one. */
export function treeStatuses(files: FileDiffMetadata[]): GitStatusEntry[] {
  return files.map((file) => ({ path: file.name, status: STATUS[file.type] }));
}

/** A name split into runs of text and numbers, lowercased: "step10.ts" → ["step", 10, ".ts"]. */
function naturalTokens(value: string): (string | number)[] {
  return value.toLowerCase().split(/(\d+)/).filter((t) => t !== "").map((t) =>
    /^\d+$/.test(t) ? Number(t) : t
  );
}

/** Two names of one folder in the tree's order: numbers as numbers, the rest by code unit. */
function compareNames(a: string, b: string): number {
  const ta = naturalTokens(a);
  const tb = naturalTokens(b);
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    if (ta[i] === tb[i]) continue;
    if (typeof ta[i] === "number" && typeof tb[i] === "number") {
      return (ta[i] as number) < (tb[i] as number) ? -1 : 1;
    }
    return String(ta[i]) < String(tb[i]) ? -1 : 1;
  }
  if (ta.length !== tb.length) return ta.length - tb.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The files in the order the tree lists them, so reading the diff top to bottom walks the tree
 * top to bottom. The tree's own rule (@pierre/trees' path-store sort) at each level: folders
 * first, then names compared naturally, numbers as numbers.
 */
export function inTreeOrder(files: FileDiffMetadata[]): FileDiffMetadata[] {
  const compare = (a: string, b: string) => {
    const pa = a.split("/");
    const pb = b.split("/");
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      if (pa[i] === pb[i]) continue;
      const folderA = i < pa.length - 1;
      const folderB = i < pb.length - 1;
      if (folderA !== folderB) return folderA ? -1 : 1;
      return compareNames(pa[i], pb[i]);
    }
    return pa.length - pb.length;
  };
  return [...files].sort((a, b) => compare(a.name, b.name));
}
