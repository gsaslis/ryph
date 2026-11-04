// Patch lines, pure: the branch shape a run ships under, and how a local branch the agent named
// becomes one. A run owns one branch NAMESPACE per repo (`ryph/<agent-handle>/<runId>`, the same
// string in every repo of the run), and every independent stream of work in a repo — a LINE —
// ships on `<namespace>/<line>`, its later generations on `<namespace>/<line>-<n>` (n ≥ 2). Each
// line is its own change request, its own generations, its own landings. The default line is
// `work`: a run that never names a branch ships on `<namespace>/work`.
//
// One copy for the three sides of the contract: the runner mints these branches, the forge's
// bundle intake holds every upload to them, the orchestrator derives patches from them. A
// divergence means a branch one side mints is refused by another.
//
// Invariants:
// - a line name is `^[a-z0-9][a-z0-9-]{0,39}$`, holds no `--`, and does not end in `-<digits>`
//   (that suffix is how a generation is spelled, so a line spelled with one would read as two
//   different things)
// - a branch parses to exactly one (line, generation) or to nothing: the first generation has
//   no suffix, so `-1` is never a generation, and a suffix that is not a plain counter from 2 up
//   leaves the whole segment to be judged as a line name — which then fails, by the rule above
// - exactly one segment under the namespace: `<namespace>/a/b` is nobody's line, and neither is
//   the bare namespace (git cannot hold `a/b` as a branch beside `a/b/c`)
// - the mapping from a local branch never invents a generation: one that would map to a name
//   ending in `-<digits>` is refused, never trimmed into something else

/** The line a run ships on when nothing names another. */
export const DEFAULT_LINE = "work";

/** How many distinct lines one run may ship in one repo. The runner refuses a ninth with a
 * message; patch intake refuses it too, as the backstop. */
export const MAX_LINES_PER_REPO = 8;

const LINE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LINE_MAX = 40;

/** Whether `name` is a valid line name. */
export function isLineName(name: string): boolean {
  return LINE.test(name) && !name.includes("--") && !/-[0-9]+$/.test(name);
}

/** The branch a line ships on in its `generation`: `<namespace>/<line>` for the first, then
 * `…-<n>`. The generation is always given: a caller that means the first says 1. */
export function lineBranch(namespace: string, line: string, generation: number): string {
  return generation <= 1 ? `${namespace}/${line}` : `${namespace}/${line}-${generation}`;
}

/**
 * The (line, generation) a branch under `namespace` names, or null when it names none. Takes a
 * bare branch name or a fully qualified `refs/heads/…` one.
 */
export function parseLineBranch(
  branch: string,
  namespace: string,
): { line: string; generation: number } | null {
  const name = branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
  if (!name.startsWith(`${namespace}/`)) return null;
  const rest = name.slice(namespace.length + 1);
  if (rest.includes("/")) return null;
  const numbered = /^(.*)-([1-9][0-9]*)$/.exec(rest);
  if (numbered !== null && Number(numbered[2]) >= 2 && isLineName(numbered[1])) {
    return { line: numbered[1], generation: Number(numbered[2]) };
  }
  return isLineName(rest) ? { line: rest, generation: 1 } : null;
}

/**
 * Where intake files a run's bundle, and the key the control plane derives for its patch: under
 * the run, then the branch it declared (its LINE and generation, as the last segment of the
 * branch spells them — `<line>` or `<line>-<n>`, path-safe by the line rule), then the repo, then
 * the head. Two lines of one run at the same head are two bundles, each declaring its own branch:
 * one key for both would let the second overwrite the first, whose publish then fetches a branch
 * the stored bundle does not carry. Ends `/<connectedRepoId>/<headSha>.bundle`, the one shape the
 * gateway's candidate arm and the patch routes accept.
 */
export function runBundleKey(
  runId: string,
  connectedRepoId: string,
  branch: { line: string; generation: number },
  headSha: string,
): string {
  const leaf = branch.generation <= 1 ? branch.line : `${branch.line}-${branch.generation}`;
  return `${runId}/${leaf}/${connectedRepoId}/${headSha}.bundle`;
}

/**
 * The line a local branch ships as, or why it cannot ship as one, in words for the agent. The
 * run's own `<namespace>/<line>` maps to `<line>`; a numbered `<namespace>/<line>-<n>` is a
 * generation only the runner starts, so it is refused here (a line the runner moved there is
 * found by its state before this is asked). Any other name maps to its slug: lowercased, every
 * run of characters outside `[a-z0-9-]` one `-`, dashes collapsed and trimmed, cut to the length
 * a line may have. A slug that is empty, or ends in what reads as a generation, is refused rather
 * than bent into another name.
 */
export function lineOfBranch(
  namespace: string,
  branch: string,
): { line: string } | { refused: string } {
  if (branch.startsWith(`${namespace}/`)) {
    const parsed = parseLineBranch(branch, namespace);
    if (parsed !== null && parsed.generation === 1) return { line: parsed.line };
    return {
      refused: parsed === null
        ? `\`${branch}\` is under this run's own branch namespace but names no line; ` +
          `use a plain branch name, such as \`fix-login\``
        : `\`${branch}\` is a numbered branch, which only the platform starts after a merge; ` +
          `use a plain branch name, such as \`fix-login\``,
    };
  }
  const slug = branch.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LINE_MAX)
    .replace(/-+$/, "");
  if (slug === "") {
    return { refused: `\`${branch}\` has no letters or digits to name a branch line after` };
  }
  if (/-[0-9]+$/.test(slug)) {
    return {
      refused: `\`${branch}\` ends in a dash and a number, which reads as a numbered branch; ` +
        "rename it (`git branch -m`) to end in a letter",
    };
  }
  return { line: slug };
}
