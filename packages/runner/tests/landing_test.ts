// Agent-driven git after a merge (orchestrator docs/patch-lifecycle.md "Landing"): a patch of the
// run merges, the control plane lands the repo onto the branch it merged into, and the merged
// cue says which (`PatchPayload.onto`). The shipper on real git against a throwaway origin: the
// cue fetches THAT branch as `origin/<onto>`, records its tip and says so in the cue's text,
// moving nothing else; a submit is refused until the branch holds that tip, and ships as the
// next generation once the agent rebased (or merged); a landing only ever moves forward; and at
// finalize a branch nobody rebased ships as it stands, as the next generation, held for a person.

import { test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { GRANT_SETTLE_MS, hasShipped, resolveLine, retargetClone } from "../src/core/patches.ts";
import { isPlainRef } from "../src/helpers/commands.ts";
import type { PatchPayload, ReleasedPayload } from "../src/core/types.ts";
import { git } from "../src/helpers/git_exec.ts";
import { plantRemoteConfig } from "./fixtures/remote_config.ts";
import {
  commitFile,
  CR,
  IDENTITY,
  mergeAndDelete,
  merged,
  shipFirst,
  upstream,
  world,
} from "./fixtures/landing.ts";

const mainOf = (w: { origin: { url: string } }) =>
  git(w.origin.url, "rev-parse", "refs/heads/main");

test("a merged cue fetches the branch it merged into, records its tip, says so, and moves nothing else", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const before = await git(w.dir, "rev-parse", `refs/heads/${w.clone.branch}`);

    const taken = await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    const tip = await mainOf(w);
    assert(typeof taken === "object", JSON.stringify(taken));
    assert(taken.note.startsWith(`ryph fetched \`origin/main\` at \`${tip.slice(0, 12)}\`. `));
    // The exact rebase, past the runner's own landed head and naming the line's branch.
    assertStringIncludes(
      taken.note,
      `\`git rebase --onto origin/main ${landed.slice(0, 12)} ${w.clone.branch}\``,
    );
    // Starting fresh deletes the old branch only once the new one's submit was accepted: a run
    // that ends in between ships lines, never a branch nobody submitted.
    assertStringIncludes(
      taken.note,
      "move your later commits onto it and submit it with ryph__submit_patch; only once that " +
        `submit is accepted, delete \`${w.clone.branch}\` (\`git branch -D ${w.clone.branch}\`)`,
    );
    // The target, never the head that merged: that one is gone upstream.
    assertEquals(w.asked, ["main"]);
    assertEquals(w.clone.landedTip, tip);
    assertEquals(await git(w.dir, "rev-parse", "refs/remotes/origin/main"), tip);
    assertEquals([w.clone.landedHead, w.clone.landing?.onto], [landed, "main"]);
    // No branch moved, no generation began.
    assertEquals(await git(w.dir, "rev-parse", `refs/heads/${w.clone.branch}`), before);
    assertEquals([w.clone.generation, w.clone.repo.ref], [1, CR]);
    // Delivered again: no news, and no second fetch.
    assertEquals(await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main")), false);
    assertEquals(w.asked, ["main"]);
  } finally {
    await w.cleanup();
  }
});

test("a submit not on what merged is refused with the rebase to run, and ships as the next generation once rebased", async () => {
  const w = await world();
  const ns = () => w.clone.repo.branchNamespace;
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await commitFile(w.dir, "b.txt", "b\n", "add b");

    const refused = await w.shipper.submit(w.clone);
    assert(refused.kind === "refused", JSON.stringify(refused));
    assertStringIncludes(refused.reason, "your change request merged into `main`");
    assertStringIncludes(refused.reason, `\`${w.clone.branch}\` is not on it yet`);
    // The tip it wants, by sha.
    assertStringIncludes(
      refused.reason,
      `does not hold \`origin/main\` at \`${(await mainOf(w)).slice(0, 12)}\``,
    );
    assertStringIncludes(
      refused.reason,
      `git rebase --onto origin/main ${landed.slice(0, 12)} ${w.clone.branch}`,
    );
    assertStringIncludes(refused.reason, "ryph__update_from_base");
    assertEquals([w.clone.generation, w.reports.length], [1, 1]);

    // Main moves on after the cue's fetch: the rebase onto what was fetched is enough.
    await upstream(w.origin.url, async (work) => {
      await commitFile(work, "main.txt", "main moved\n", "main work");
      await git(work, "push", "--quiet", "origin", "main");
    });
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", landed);
    const branch = w.clone.branch;
    const next = await w.shipper.submit(w.clone);
    assert(next.kind === "submitted", JSON.stringify(next));
    assertEquals([next.generation, next.branch], [2, `${ns()}/work-2`]);
    // The local branch keeps its name; only what it ships as moved on.
    assertEquals(w.clone.branch, branch);
    assertEquals(
      await git(w.dir, "rev-parse", `refs/heads/${ns()}/work-2`).catch(() => null),
      null,
    );
    // Cut from where the branch meets main: the tip it was rebased onto, not main's newer one.
    const report = w.reports.at(-1)!;
    assertEquals(report.baseSha, await git(w.dir, "rev-parse", `refs/heads/${branch}~1`));
    assertEquals(report.branch.commits.map((c) => c.subject), ["add b"]);
    // The entry agrees with the control plane: on main, with nothing beyond it.
    assertEquals(w.clone.repo.ref, "main");
    assertEquals("targetRef" in w.clone.repo, false);
    assertEquals([w.clone.landing, w.clone.landedHead, w.clone.landedTip], [null, null, null]);
  } finally {
    await w.cleanup();
  }
});

test("update_from_base after a landing merges what it merged into, and the submit after it passes", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await commitFile(w.dir, "b.txt", "b\n", "add b");

    const caughtUp = await w.shipper.update(w.clone);
    assert(caughtUp.kind === "merged", JSON.stringify(caughtUp));
    assertEquals([caughtUp.target, caughtUp.tip], ["main", await mainOf(w)]);
    const next = await w.shipper.submit(w.clone);
    assert(next.kind === "submitted", JSON.stringify(next));
    assertEquals(next.generation, 2);
    assertEquals(w.reports.at(-1)!.baseSha, await mainOf(w));
  } finally {
    await w.cleanup();
  }
});

test("the remote config the agent writes steers neither the cue's fetch nor update_from_base's", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    const planted = await plantRemoteConfig(w.dir, w.origin.url);
    try {
      const taken = await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
      assert(typeof taken === "object", JSON.stringify(taken));
      assertEquals(w.clone.landedTip, await mainOf(w));
      await commitFile(w.dir, "b.txt", "b\n", "add b");
      const caughtUp = await w.shipper.update(w.clone);
      assert(caughtUp.kind === "merged", JSON.stringify(caughtUp));
      assertEquals(caughtUp.tip, await mainOf(w));
      assertEquals(await git(w.dir, "rev-parse", "refs/remotes/origin/main"), await mainOf(w));
      assertEquals(await planted.uploadPackRan(), false, "the planted upload-pack ran");
      assertEquals(await planted.decoyRefs(), "", "the planted fetch refspec was used");
    } finally {
      await planted.cleanup();
    }
  } finally {
    await w.cleanup();
  }
});

test("update_from_base after a squash with nothing new leaves nothing to ship, mid-run or at finalize", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    // The merge commit holds main's tree: its change request would change nothing.
    const caughtUp = await w.shipper.update(w.clone);
    assert(caughtUp.kind === "merged", JSON.stringify(caughtUp));
    assertEquals(
      await git(w.dir, "rev-parse", `${w.clone.branch}^{tree}`),
      await git(w.dir, "rev-parse", "origin/main^{tree}"),
    );
    assertEquals((await w.shipper.submit(w.clone)).kind, "nothing-to-submit");
    assertEquals((await w.shipper.finalize(w.clone)).kind, "nothing-to-submit");
    assertEquals([w.clone.generation, w.reports.length], [1, 1]);
  } finally {
    await w.cleanup();
  }
});

test("at finalize a branch nobody rebased that undoes what merged still ships, held", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    // Back at the old base's tree: a revert of all the merged work, never rebased.
    await git(w.dir, "rm", "-q", "a.txt", "cr.txt");
    await git(w.dir, "commit", "-q", "-m", "drop a");
    const head = await git(w.dir, "rev-parse", "HEAD");

    const last = await w.shipper.finalize(w.clone);
    assert(last.kind === "submitted", JSON.stringify(last));
    assertEquals([last.generation, last.headSha], [2, head]);
    assertEquals(w.reports.at(-1)!.requiresApproval, true);
    assertEquals(w.clone.unrebased, { onto: "main" });
  } finally {
    await w.cleanup();
  }
});

test("a cue whose fetch fails says how to get it, and update_from_base stands in for it", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    // Both tries fail, the second past the grant's window.
    w.failNext(2);
    const taken = await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    assert(typeof taken === "object", JSON.stringify(taken));
    assertStringIncludes(taken.note, "ryph could not fetch `origin/main`");
    assertStringIncludes(taken.note, "call ryph__update_from_base");
    assertEquals(w.clone.landedTip, null);
    assertEquals(w.sleeps, [GRANT_SETTLE_MS]);

    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const caughtUp = await w.shipper.update(w.clone);
    assert(caughtUp.kind === "merged", JSON.stringify(caughtUp));
    assertEquals(w.clone.landedTip, await mainOf(w));
    const next = await w.shipper.submit(w.clone);
    assert(next.kind === "submitted", JSON.stringify(next));
    assertEquals(next.generation, 2);
  } finally {
    await w.cleanup();
  }
});

test("right after the landing the gateway may still serve the old head: the cue's fetch waits out the window once", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    w.failNext(1);
    const cue = merged(landed, "main");
    // The cue is taken at `now`; the first fetch fails as a grant naming the deleted head does.
    const taken = await w.shipper.onPatchCue([w.clone.owner], cue);
    assertEquals(w.sleeps, [GRANT_SETTLE_MS]);
    assertEquals(w.asked, ["main", "main"]);
    assert(typeof taken === "object" && taken.note.startsWith("ryph fetched"), String(taken));
    assertEquals(w.clone.landedTip, await mainOf(w));
  } finally {
    await w.cleanup();
  }
});

test("a submit with a rebase in progress is refused, and the rebase left as it is", async () => {
  const w = await world({ files: { "shared.txt": "base\n" } });
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await upstream(w.origin.url, async (work) => {
      await commitFile(work, "shared.txt", "theirs\n", "theirs");
      await git(work, "push", "--quiet", "origin", "main");
    });
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await commitFile(w.dir, "shared.txt", "ours\n", "ours");
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", landed).catch(() => {});
    const stopped = await w.shipper.submit(w.clone);
    assert(stopped.kind === "refused", JSON.stringify(stopped));
    assertStringIncludes(stopped.reason, "`repo` has a rebase in progress");
    assertStringIncludes(stopped.reason, "git rebase --continue");
    assert(existsSync(`${w.dir}/.git/rebase-merge`), "the rebase is still there");
    assertEquals(w.clone.generation, 1);
  } finally {
    await w.cleanup();
  }
});

test("at finalize a branch nobody rebased ships as it stands, as the next generation, held and noted", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const head = await git(w.dir, "rev-parse", "HEAD");

    const last = await w.shipper.finalize(w.clone);
    assert(last.kind === "submitted", JSON.stringify(last));
    assertEquals([last.generation, last.headSha], [2, head]);
    assertEquals(w.reports.at(-1)!.requiresApproval, true);
    assertEquals(w.clone.unrebased, { onto: "main" });
    // From where the branch meets main: after the squash, the old base.
    assertEquals(w.reports.at(-1)!.baseSha, await git(w.dir, "merge-base", head, await mainOf(w)));
  } finally {
    await w.cleanup();
  }
});

test("at finalize a rebased branch ships as a submit would, with no note", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", landed);
    const last = await w.shipper.finalize(w.clone);
    assert(last.kind === "submitted", JSON.stringify(last));
    assertEquals(last.generation, 2);
    assertEquals(w.clone.unrebased, null);
    assertEquals(w.reports.at(-1)!.branch.commits.map((c) => c.subject), ["add b"]);
  } finally {
    await w.cleanup();
  }
});

test("finalize with nothing after the landed head fetches nothing more and ships nothing", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    const last = await w.shipper.finalize(w.clone);
    assertEquals(last.kind, "nothing-to-submit");
    assertEquals(w.asked, ["main"]);
  } finally {
    await w.cleanup();
  }
});

test("a cue whose fetch outlasts the next generation's submit says the line already ships on", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", landed);
    // A later cue of the generation fetches; the submit ships the next generation meanwhile.
    const release = w.holdNextFetch();
    const asked = w.asked.length;
    const late = w.shipper.onPatchCue([w.clone.owner], {
      ...merged(landed, "main"),
      patchId: "p-9",
    });
    while (w.asked.length === asked) await new Promise((resolve) => setTimeout(resolve, 5));
    const next = await w.shipper.submit(w.clone);
    assert(next.kind === "submitted", JSON.stringify(next));
    release();
    const taken = await late;
    assert(typeof taken === "object", JSON.stringify(taken));
    assertStringIncludes(taken.note, `already ships as \`${next.branch}\``);
    assert(!taken.note.includes("git rebase"), taken.note);
    assertEquals(w.clone.landedTip, null);
  } finally {
    await w.cleanup();
  }
});

test("a merge cue naming no branch (a control plane a version behind) fetches the branch's own target", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, undefined));
    assertEquals(w.clone.landing?.onto, "main");
    assertEquals(w.asked, ["main"]);
  } finally {
    await w.cleanup();
  }
});

test("a merge cue repeated, for an earlier head, or naming another branch, moves nothing back", async () => {
  const w = await world();
  try {
    const first = await shipFirst(w);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const second = await w.shipper.submit(w.clone);
    assert(second.kind === "submitted");
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], {
      ...merged(second.headSha, "main"),
      patchId: "p-2",
    });
    assertEquals(w.clone.landedHead, second.headSha);
    // An earlier head, cued late: the landed head stays.
    await w.shipper.onPatchCue([w.clone.owner], merged(first, "elsewhere"));
    assertEquals([w.clone.landedHead, w.clone.landing?.onto], [second.headSha, "main"]);
  } finally {
    await w.cleanup();
  }
});

test("a later head of the generation, cued after an earlier one, moves the landed head forward", async () => {
  const w = await world();
  try {
    const first = await shipFirst(w);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const second = await w.shipper.submit(w.clone);
    assert(second.kind === "submitted");
    await w.shipper.onPatchCue([w.clone.owner], merged(first, "main"));
    await w.shipper.onPatchCue([w.clone.owner], {
      ...merged(second.headSha, "main"),
      patchId: "p-2",
    });
    assertEquals(w.clone.landedHead, second.headSha);
  } finally {
    await w.cleanup();
  }
});

function missed(patchId: string, headSha: string, onto?: string): PatchPayload {
  return { ...merged(headSha, onto), patchId, state: "missed" };
}

test("a missed cue beside a merged one lands nothing; one that ends its generation lands it at its base", async () => {
  const w = await world();
  try {
    const first = await shipFirst(w);
    const base = w.clone.baseSha;
    // Without `onto`: an earlier head merged, and the merged cue decides.
    assertEquals(await w.shipper.onPatchCue([w.clone.owner], missed("p-1", first)), true);
    assertEquals(w.clone.landedHead, null);
    // With `onto`: none of the generation merged, so the whole of it moves.
    await mergeAndDelete(w.origin.url, CR);
    const taken = await w.shipper.onPatchCue([w.clone.owner], missed("p-2", first, "main"));
    assert(typeof taken === "object", JSON.stringify(taken));
    assertEquals([w.clone.landedHead, w.clone.landing?.onto], [base, "main"]);
    assertEquals(w.clone.landedTip, await mainOf(w));

    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", base);
    const next = await w.shipper.submit(w.clone);
    assert(next.kind === "submitted", JSON.stringify(next));
    assertEquals(next.generation, 2);
    assertEquals(w.reports.at(-1)!.branch.commits.map((c) => c.subject), ["add a"]);
  } finally {
    await w.cleanup();
  }
});

/** A release: the change request the repo worked merged with nothing of the run's on it. */
function released(onto = "main"): ReleasedPayload {
  return { kind: "released", path: "repo", line: "work", generation: 1, onto, forgeRef: "7" };
}

test("a release lands the generation at its base, and the run's own commits ship once moved onto where it merged", async () => {
  const w = await world();
  try {
    const base = w.clone.baseSha;
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    await mergeAndDelete(w.origin.url, CR);
    const taken = await w.shipper.onPatchCue([w.clone.owner], released());
    assert(typeof taken === "object", JSON.stringify(taken));
    assertEquals([w.clone.landedHead, w.clone.landing?.onto], [base, "main"]);
    // Delivered again: no news, and nothing moves.
    assertEquals(await w.shipper.onPatchCue([w.clone.owner], released()), false);

    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", base);
    const next = await w.shipper.submit(w.clone);
    assert(next.kind === "submitted", JSON.stringify(next));
    assertEquals(next.generation, 2);
    const report = w.reports.at(-1)!;
    assertEquals(report.baseSha, await mainOf(w));
    assertEquals(report.branch.commits.map((c) => c.subject), ["add a", "add b"]);
    // The entry drops the change request, as the task did: on main, with nothing beyond it.
    assertEquals(w.clone.repo.ref, "main");
    assertEquals("targetRef" in w.clone.repo, false);
  } finally {
    await w.cleanup();
  }
});

test("a release changes nothing once a landing of the generation is heard", async () => {
  const w = await world();
  try {
    const first = await shipFirst(w);
    await w.shipper.onPatchCue([w.clone.owner], merged(first, "main"));
    // Nothing moves; the note repeats what to run, since the release's own text defers to it.
    const again = await w.shipper.onPatchCue([w.clone.owner], released("elsewhere"));
    assert(typeof again === "object", JSON.stringify(again));
    assertStringIncludes(again.note, `git rebase --onto origin/main ${first.slice(0, 12)}`);
    assertEquals([w.clone.landedHead, w.clone.landing?.onto], [first, "main"]);
  } finally {
    await w.cleanup();
  }
});

test("a release is held to the change request the clone targets now", async () => {
  const w = await world();
  try {
    const base = w.clone.baseSha;
    assert(await w.shipper.onPatchCue([w.clone.owner], released()));
    assertEquals(w.clone.landedHead, base);
    assertEquals(hasShipped(w.clone), false);
    // The agent moves the clone onto another change request: the old target's landing goes.
    await retargetClone(git, w.clone, {
      ref: CR,
      targetRef: "main",
      headSha: base,
      changeRequest: "9",
    });
    assertEquals([w.clone.landedHead, w.clone.landing, w.clone.landedTip], [null, null, null]);
    // The old target's release: nothing to rebase, and the note says so, naming where it works.
    const old = await w.shipper.onPatchCue([w.clone.owner], { ...released(), forgeRef: "8" });
    assert(typeof old === "object", JSON.stringify(old));
    assertStringIncludes(old.note, "ryph: nothing to do for this one");
    assertStringIncludes(old.note, "now works on change request `#9`; leave it as it is");
    assertEquals(w.clone.landedHead, null);
    assert(await w.shipper.onPatchCue([w.clone.owner], { ...released(), forgeRef: "9" }));
    assertEquals(w.clone.landedHead, base);
  } finally {
    await w.cleanup();
  }
});

test("a release is held to the generation it ends", async () => {
  const w = await world();
  try {
    const first = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(first, "main"));
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", first);
    const second = await w.shipper.submit(w.clone);
    assert(second.kind === "submitted", JSON.stringify(second));
    assertEquals(w.clone.generation, 2);
    const late = await w.shipper.onPatchCue([w.clone.owner], released("elsewhere"));
    assert(typeof late === "object", JSON.stringify(late));
    assertStringIncludes(late.note, "ryph: nothing to do for this one");
    assertStringIncludes(late.note, `already ships as \`${w.clone.shipAs}\``);
    assertEquals([w.clone.landedHead, w.clone.landing], [null, null]);
    // A missed cue of the generation it left says the same.
    const missedLate = await w.shipper.onPatchCue(
      [w.clone.owner],
      missed("p-9", first, "main"),
    );
    assert(typeof missedLate === "object", JSON.stringify(missedLate));
    assertStringIncludes(missedLate.note, "ryph: nothing to do for this one");
  } finally {
    await w.cleanup();
  }
});

test("a landing cue for a line the run does not hold says there is nothing to do", async () => {
  const w = await world();
  try {
    const first = await shipFirst(w);
    for (
      const cue of [
        { ...merged(first, "main"), line: "other" },
        { ...missed("p-2", first, "main"), line: "other" },
        { ...released(), line: "other" },
      ]
    ) {
      const taken = await w.shipper.onPatchCue([w.clone.owner], cue);
      assert(typeof taken === "object", JSON.stringify(taken));
      assertStringIncludes(taken.note, "ryph does not know the line `other` of `repo`");
    }
    assertEquals(w.clone.landedHead, null);
  } finally {
    await w.cleanup();
  }
});

/** The first command a note spells out in backticks that starts with `git rebase`. */
function rebaseIn(note: string): string[] {
  const found = /`(git rebase [^`]+)`/.exec(note);
  assert(found !== null, note);
  return found[1].split(" ").slice(1);
}

test("the cue's rebase names the line's branch, so it rebases that one whatever HEAD is on", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const taken = await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    assert(typeof taken === "object", JSON.stringify(taken));
    // The agent is on another branch when it runs what the note says.
    await git(w.dir, "switch", "--quiet", "-c", "elsewhere", "origin/main");
    const elsewhere = await git(w.dir, "rev-parse", "HEAD");
    await git(w.dir, ...rebaseIn(taken.note));
    assert(
      await git(w.dir, "merge-base", "--is-ancestor", await mainOf(w), w.clone.branch).then(
        () => true,
        () => false,
      ),
      "the line's branch is on what merged",
    );
    assertEquals(await git(w.dir, "rev-parse", "refs/heads/elsewhere"), elsewhere);
    const next = await w.shipper.submit(w.clone);
    assert(next.kind === "submitted", JSON.stringify(next));
    assertEquals(w.reports.at(-1)!.branch.commits.map((c) => c.subject), ["add b"]);
  } finally {
    await w.cleanup();
  }
});

test("a rebase of a line the checkout is not on says it checks that line out, and how back", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    await git(w.dir, "switch", "--quiet", "-c", "fix", "origin/main");
    const taken = await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    assert(typeof taken === "object", JSON.stringify(taken));
    const refused = await w.shipper.submit(w.clone);
    assert(refused.kind === "refused", JSON.stringify(refused));
    for (const said of [taken.note, refused.reason]) {
      assertStringIncludes(said, "commit or stash uncommitted changes first");
      assertStringIncludes(
        said,
        `it checks out \`${w.clone.branch}\`, so run \`git switch fix\` after it to go back`,
      );
      // update_from_base merges into the branch checked out: the line's, switched to first.
      assertStringIncludes(
        said,
        `or \`git switch ${w.clone.branch}\` and merge it with ryph__update_from_base`,
      );
    }
    await git(w.dir, ...rebaseIn(taken.note));
    assertEquals(await git(w.dir, "branch", "--show-current"), w.clone.branch);
    await git(w.dir, "switch", "--quiet", "fix");
    assertEquals(await git(w.dir, "branch", "--show-current"), "fix");
    // On the line's own branch, there is nothing to go back to.
    await git(w.dir, "switch", "--quiet", w.clone.branch);
    const again = await w.shipper.onPatchCue([w.clone.owner], released("elsewhere"));
    assert(typeof again === "object", JSON.stringify(again));
    assert(!again.note.includes("git switch"), again.note);
  } finally {
    await w.cleanup();
  }
});

test("after a merge-commit landing, the cue's rebase moves only the later work and the next generation ships it", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch, "merge");
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const taken = await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    assert(typeof taken === "object", JSON.stringify(taken));
    const refused = await w.shipper.submit(w.clone);
    assert(refused.kind === "refused", JSON.stringify(refused));
    await git(w.dir, ...rebaseIn(taken.note));
    const next = await w.shipper.submit(w.clone);
    assert(next.kind === "submitted", JSON.stringify(next));
    assertEquals(next.generation, 2);
    const report = w.reports.at(-1)!;
    assertEquals(report.baseSha, await mainOf(w));
    assertEquals(report.branch.commits.map((c) => c.subject), ["add b"]);
  } finally {
    await w.cleanup();
  }
});

test("after a merge-commit landing, a branch still at the landed head has nothing to submit or check", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch, "merge");
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    const nothing = await w.shipper.submit(w.clone);
    assertEquals(nothing.kind, "nothing-to-submit");
    const checked = await w.shipper.pushCandidate(w.clone);
    assert("refused" in checked, JSON.stringify(checked));
    assertStringIncludes(checked.refused, "has nothing committed past what merged");
    // Leftovers are something: they ask for the rebase, and stay uncommitted.
    await writeFile(`${w.dir}/left.txt`, "left\n");
    const refused = await w.shipper.submit(w.clone);
    assert(refused.kind === "refused", JSON.stringify(refused));
    assertStringIncludes(refused.reason, "is not on it yet");
    assertEquals(await git(w.dir, "rev-parse", "HEAD"), landed);
    assertEquals(w.reports.length, 1);
  } finally {
    await w.cleanup();
  }
});

test("a landed branch renamed without a rebase ships as a new line, as it stands", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    await git(w.dir, "branch", "-m", w.clone.branch, "fresh");
    const resolved = await resolveLine(git, w.clone.owner, "fresh");
    assert("line" in resolved && resolved.created, JSON.stringify(resolved));
    // Not the runner's to enforce: the agent could bypass it, and the person sees the diff.
    const shipped = await w.shipper.submit(resolved.line);
    assert(shipped.kind === "submitted", JSON.stringify(shipped));
    assertEquals(w.reports.at(-1)!.branch.commits.map((c) => c.subject), [
      "cr work",
      "add a",
      "add b",
    ]);
  } finally {
    await w.cleanup();
  }
});

test("a failed push leaves the landing standing: the rebase undone, the next submit is refused again", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const tip = w.clone.landedTip;
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", landed);

    w.failPushes(1);
    const failed = await w.shipper.submit(w.clone);
    assert(failed.kind === "refused", JSON.stringify(failed));
    assertStringIncludes(failed.reason, "could not be shipped");
    assertEquals([w.clone.generation, w.clone.landedHead, w.clone.landedTip], [1, landed, tip]);
    assertEquals(w.clone.shipAs, `${w.clone.repo.branchNamespace}/work`);

    // The agent undoes its rebase: the rule still holds, nothing ships without it.
    await git(w.dir, "reset", "--quiet", "--hard", "ORIG_HEAD");
    const again = await w.shipper.submit(w.clone);
    assert(again.kind === "refused", JSON.stringify(again));
    assertStringIncludes(again.reason, "is not on it yet");
    assertEquals([w.clone.generation, w.reports.length], [1, 1]);
  } finally {
    await w.cleanup();
  }
});

test("a rebased branch with nothing new to ship leaves the landing standing, and finalize ships nothing", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", landed);
    const nothing = await w.shipper.submit(w.clone);
    assertEquals(nothing.kind, "nothing-to-submit");
    assertEquals([w.clone.generation, w.clone.landedHead], [1, landed]);
    assertEquals((await w.shipper.finalize(w.clone)).kind, "nothing-to-submit");
    assertEquals([w.clone.generation, w.reports.length], [1, 1]);
  } finally {
    await w.cleanup();
  }
});

test("a finalize whose push fails throws and leaves the line in its landed generation", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    w.failPushes(1);
    let threw = false;
    await w.shipper.finalize(w.clone).catch(() => (threw = true));
    assert(threw, "a transport failure at finalize throws");
    assertEquals([w.clone.generation, w.clone.landedHead, w.clone.unrebased], [1, landed, null]);
  } finally {
    await w.cleanup();
  }
});

test("a refused submit after a landing commits nothing of the tree", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await writeFile(`${w.dir}/left.txt`, "uncommitted\n");
    const head = await git(w.dir, "rev-parse", "HEAD");
    const refused = await w.shipper.submit(w.clone);
    assert(refused.kind === "refused", JSON.stringify(refused));
    assertEquals(await git(w.dir, "rev-parse", "HEAD"), head);
    assertEquals(await git(w.dir, "status", "--porcelain"), "?? left.txt");
  } finally {
    await w.cleanup();
  }
});

test("an onto rewound after the cue: update_from_base takes its tip, and the submit after it passes", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    const before = await mainOf(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    // Somebody force-pushes the merge away.
    await upstream(w.origin.url, async (work) => {
      await git(work, "push", "--quiet", "-f", "origin", `${before}:refs/heads/main`);
    });
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const caughtUp = await w.shipper.update(w.clone);
    assert(caughtUp.kind === "up-to-date", JSON.stringify(caughtUp));
    assertEquals(w.clone.landedTip, before);
    const next = await w.shipper.submit(w.clone);
    assert(next.kind === "submitted", JSON.stringify(next));
    assertEquals(next.generation, 2);
    assertEquals(w.reports.at(-1)!.baseSha, before);
  } finally {
    await w.cleanup();
  }
});

test("an onto rewound after the cue, under a branch that holds it: the submit ships against the rewound tip", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    const before = await mainOf(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", landed);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    await upstream(w.origin.url, async (work) => {
      await git(work, "push", "--quiet", "-f", "origin", `${before}:refs/heads/main`);
    });
    const next = await w.shipper.submit(w.clone);
    assert(next.kind === "submitted", JSON.stringify(next));
    assertEquals([w.reports.at(-1)!.baseSha, w.clone.landedTip], [before, null]);
  } finally {
    await w.cleanup();
  }
});

test("an onto rewritten after the cue: the refusal asks for its new tip by sha", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    const before = await mainOf(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", landed);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    await upstream(w.origin.url, async (work) => {
      await git(work, "reset", "--quiet", "--hard", before);
      await commitFile(work, "other.txt", "other\n", "rewritten");
      await git(work, "push", "--quiet", "-f", "origin", "main");
    });
    const refused = await w.shipper.submit(w.clone);
    assert(refused.kind === "refused", JSON.stringify(refused));
    const rewritten = await mainOf(w);
    assertEquals(w.clone.landedTip, rewritten);
    assertStringIncludes(refused.reason, `at \`${rewritten.slice(0, 12)}\``);
  } finally {
    await w.cleanup();
  }
});

test("an onto gone from the origin is said plainly: the line ships no more mid-run, and finalize sends it held", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const taken = await w.shipper.onPatchCue([w.clone.owner], merged(landed, "stack-base"));
    assert(typeof taken === "object", JSON.stringify(taken));
    const refused = await w.shipper.submit(w.clone);
    assert(refused.kind === "refused", JSON.stringify(refused));
    const caughtUp = await w.shipper.update(w.clone);
    assert(caughtUp.kind === "refused", JSON.stringify(caughtUp));
    const checked = await w.shipper.pushCandidate(w.clone);
    assert("refused" in checked, JSON.stringify(checked));
    for (const said of [taken.note, refused.reason, caughtUp.reason, checked.refused]) {
      assertStringIncludes(
        said,
        `\`stack-base\`, where your change request merged, could not be found at the origin, so ` +
          `\`${w.clone.branch}\` can't ship again in this run; its work goes to a person when ` +
          "the run ends.",
      );
      assert(!said.includes("try again"), said);
    }

    const last = await w.shipper.finalize(w.clone);
    assert(last.kind === "submitted", JSON.stringify(last));
    assertEquals(last.generation, 2);
    assertEquals(w.reports.at(-1)!.requiresApproval, true);
    assertEquals(w.clone.unrebased, { onto: "stack-base" });
  } finally {
    await w.cleanup();
  }
});

test("an onto deleted after its tip was fetched refuses the submit, though the branch holds that tip", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await upstream(w.origin.url, async (work) => {
      await git(work, "push", "--quiet", "origin", "origin/main:refs/heads/stack-base");
    });
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "stack-base"));
    assert(w.clone.landedTip !== null, "the cue fetched the tip");
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/stack-base", landed);
    await upstream(w.origin.url, async (work) => {
      await git(work, "push", "--quiet", "origin", ":stack-base");
    });

    const refused = await w.shipper.submit(w.clone);
    assert(refused.kind === "refused", JSON.stringify(refused));
    assertStringIncludes(refused.reason, "`stack-base`, where your change request merged");
    assertStringIncludes(refused.reason, "can't ship again in this run");
    assertEquals([w.clone.generation, w.reports.length], [1, 1]);
  } finally {
    await w.cleanup();
  }
});

test("a landed branch left behind after starting fresh ships at finalize, held, for a person to discard", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const old = w.clone.branch;
    await mergeAndDelete(w.origin.url, old, "rebase");
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    // The agent starts afresh, moves its later commit over, and forgets the old branch.
    await git(w.dir, "switch", "--quiet", "-c", "fresh", "origin/main");
    await git(w.dir, ...IDENTITY, "cherry-pick", `refs/heads/${old}`);
    const resolved = await resolveLine(git, w.clone.owner, "fresh");
    assert("line" in resolved, JSON.stringify(resolved));
    const fresh = await w.shipper.submit(resolved.line);
    assert(fresh.kind === "submitted", JSON.stringify(fresh));

    const last = await w.shipper.finalize(w.clone);
    assert(last.kind === "submitted", JSON.stringify(last));
    assertEquals(last.generation, 2);
    const report = w.reports.at(-1)!;
    assertEquals(report.requiresApproval, true);
    assertEquals(w.clone.unrebased, { onto: "main" });
  } finally {
    await w.cleanup();
  }
});

test("checks after a landing run once the branch holds the tip, filed under the next generation, which the line does not take", async () => {
  const w = await world();
  const ns = () => w.clone.repo.branchNamespace;
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const refused = await w.shipper.pushCandidate(w.clone);
    assert("refused" in refused, JSON.stringify(refused));
    assertStringIncludes(
      refused.refused,
      `git rebase --onto origin/main ${landed.slice(0, 12)} ${w.clone.branch}`,
    );

    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", landed);
    const candidate = await w.shipper.pushCandidate(w.clone);
    assert(!("refused" in candidate), JSON.stringify(candidate));
    assertEquals(candidate.branch, `${ns()}/work-2`);
    assertEquals(candidate.baseSha, await mainOf(w));
    assertEquals(candidate.headSha, await git(w.dir, "rev-parse", w.clone.branch));
    assertEquals([w.clone.generation, w.clone.shipAs, w.clone.landedHead], [
      1,
      `${ns()}/work`,
      landed,
    ]);
    // The submit ships what was checked, as the next generation.
    const next = await w.shipper.submit(w.clone);
    assert(next.kind === "submitted", JSON.stringify(next));
    assertEquals([next.branch, next.headSha], [candidate.branch, candidate.headSha]);
  } finally {
    await w.cleanup();
  }
});

test("checks after onto was rewritten fetch it again and ask for its new tip, as a submit does", async () => {
  const w = await world();
  try {
    const landed = await shipFirst(w);
    const before = await mainOf(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", landed);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    await upstream(w.origin.url, async (work) => {
      await git(work, "reset", "--quiet", "--hard", before);
      await commitFile(work, "other.txt", "other\n", "rewritten");
      await git(work, "push", "--quiet", "-f", "origin", "main");
    });
    const refused = await w.shipper.pushCandidate(w.clone);
    assert("refused" in refused, JSON.stringify(refused));
    const rewritten = await mainOf(w);
    assertEquals(w.clone.landedTip, rewritten);
    assertStringIncludes(refused.refused, `at \`${rewritten.slice(0, 12)}\``);
  } finally {
    await w.cleanup();
  }
});

test("checks during the agent's own rebase say to finish or abort it, never to submit", async () => {
  const w = await world({ files: { "shared.txt": "base\n" } });
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await upstream(w.origin.url, async (work) => {
      await commitFile(work, "shared.txt", "theirs\n", "theirs");
      await git(work, "push", "--quiet", "origin", "main");
    });
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await commitFile(w.dir, "shared.txt", "ours\n", "ours");
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", landed).catch(() => {});
    const refused = await w.shipper.pushCandidate(w.clone);
    assert("refused" in refused, JSON.stringify(refused));
    assertStringIncludes(refused.refused, "finish it (`git rebase --continue`) or abort it");
    assert(!refused.refused.includes("submit_patch"), refused.refused);
  } finally {
    await w.cleanup();
  }
});

test("a branch name a shell would read gets words, never a command to paste", async () => {
  assertEquals(
    ["main", "release/1.2", "feat_x-y", "-x", "a$(id)", "a;b", "a|b", "a&b", "a'b", "a`b`"].map(
      isPlainRef,
    ),
    [true, true, true, false, false, false, false, false, false, false],
  );
  const w = await world();
  try {
    const onto = "rel$(id);x";
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await upstream(w.origin.url, async (work) => {
      await git(work, "push", "--quiet", "origin", `origin/main:refs/heads/${onto}`);
    });
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const taken = await w.shipper.onPatchCue([w.clone.owner], merged(landed, onto));
    assert(typeof taken === "object", JSON.stringify(taken));
    assertStringIncludes(taken.note, "ryph fetched");
    const refused = await w.shipper.submit(w.clone);
    assert(refused.kind === "refused", JSON.stringify(refused));
    for (const said of [taken.note, refused.reason]) {
      assert(!said.includes("git rebase"), said);
      assertStringIncludes(said, "quote it");
    }
  } finally {
    await w.cleanup();
  }
});

test("a backtick in a branch name never closes a code span in a note or refusal", async () => {
  const w = await world();
  try {
    const onto = "rel`x";
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await upstream(w.origin.url, async (work) => {
      await git(work, "push", "--quiet", "origin", `origin/main:refs/heads/${onto}`);
    });
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const taken = await w.shipper.onPatchCue([w.clone.owner], merged(landed, onto));
    assert(typeof taken === "object", JSON.stringify(taken));
    const refused = await w.shipper.submit(w.clone);
    assert(refused.kind === "refused", JSON.stringify(refused));
    for (const said of [taken.note, refused.reason]) {
      assert(!said.includes(onto), said);
      assertStringIncludes(said, "`origin/rel'x`");
    }
  } finally {
    await w.cleanup();
  }
});

test("finalize over the agent's own rebase stopped on a landed line ships the branch as it stood, held, and says so", async () => {
  const w = await world({ files: { "shared.txt": "base\n" } });
  try {
    const landed = await shipFirst(w);
    await mergeAndDelete(w.origin.url, w.clone.branch);
    await upstream(w.origin.url, async (work) => {
      await commitFile(work, "shared.txt", "theirs\n", "theirs");
      await git(work, "push", "--quiet", "origin", "main");
    });
    await w.shipper.onPatchCue([w.clone.owner], merged(landed, "main"));
    await commitFile(w.dir, "shared.txt", "ours\n", "ours");
    const head = await git(w.dir, "rev-parse", "HEAD");
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", landed).catch(() => {});
    assert(existsSync(`${w.dir}/.git/rebase-merge`), "the rebase stopped");

    const last = await w.shipper.finalize(w.clone);
    assert(last.kind === "submitted", JSON.stringify(last));
    assertEquals([last.generation, last.headSha], [2, head]);
    assertEquals(last.abandoned?.step, "rebase");
    assertEquals(last.abandoned?.branch, "shipped");
    assertEquals(w.reports.at(-1)!.requiresApproval, true);
    // Nothing lost: the branch as it stood, from where it meets main (after the squash, the
    // landed commits come along, for the person to see).
    assertEquals(w.reports.at(-1)!.branch.commits.map((c) => c.subject).at(-1), "ours");
    assertEquals(w.clone.unrebased, { onto: "main" });
    // Nothing on disk was touched: the rebase is still there for nobody.
    assert(existsSync(`${w.dir}/.git/rebase-merge`), "the rebase is left as it stood");
  } finally {
    await w.cleanup();
  }
});
