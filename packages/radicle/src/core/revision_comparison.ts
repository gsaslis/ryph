// Comparing recorded patch versions is independent of current refs. A rebase may leave the
// earlier head unreachable from the branch exported to the agent, but still in node storage.
import type { RevisionView } from "./types.ts";
import { RefusedError } from "./types.ts";
import type { RadExec } from "../ports/rad.ts";
import { isFullOid } from "../helpers/ids.ts";

export interface RevisionComparisonInput {
  from: string;
  to?: string;
  mode: "diff" | "range-diff";
}

export interface RevisionComparison {
  from: { id: string; base: string; head: string };
  to: { id: string; base: string; head: string };
  mode: "diff" | "range-diff";
  text: string;
  truncated: boolean;
}

export async function compareRevisions(
  revisions: RevisionView[],
  input: RevisionComparisonInput,
  git: RadExec["git"],
  storageDir: string,
): Promise<RevisionComparison> {
  const select = (revision: string | undefined) => {
    const found = revision === undefined
      ? revisions.at(-1)
      : revisions.find((r) => r.id === revision);
    if (found === undefined) throw new RefusedError("revision not found in this patch", 404);
    if (!isFullOid(found.base) || !isFullOid(found.head)) {
      throw new RefusedError("revision has no valid recorded base/head", 409);
    }
    return { id: found.id, base: found.base, head: found.head };
  };
  const from = select(input.from);
  const to = select(input.to);
  const args = input.mode === "diff"
    ? ["diff", "--find-renames", from.head, to.head]
    : ["range-diff", `${from.base}..${from.head}`, `${to.base}..${to.head}`];
  const out = await git(storageDir, [
    ...args,
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--",
  ], { timeoutMs: 120_000, maxOutputBytes: 60_000 });
  if (out.code !== 0 || out.timedOut) {
    throw new RefusedError(
      "revision comparison unavailable: commits may be missing from this node, or git failed; " +
        "this is not an empty comparison",
      409,
    );
  }
  return { from, to, mode: input.mode, text: out.stdout, truncated: out.truncated ?? false };
}
