// A throwaway git origin for tests: a real local bare repo with one seed commit,
// created in a temp dir. Its URL is an ordinary path remote — indistinguishable from ssh or
// https to the runner — so the real `cliGitTransport` clones and pushes against it for real,
// exercising the full clone → commit → push path with nothing but local disk. This is
// the git port's local stand-in: not a fake adapter, just a disposable remote to aim the real
// one at. Call `cleanup()` (or remove `dir`) when done.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../src/helpers/git_exec.ts";
import { removeTree } from "./remove_tree.ts";

export interface ThrowawayOrigin {
  /** Use as WorkItem.repo.url — an ordinary path remote, indistinguishable from any other. */
  url: string;
  /** Use as WorkItem.repo.ref. */
  ref: string;
  /** Root temp dir holding the bare origin; remove to clean up. */
  dir: string;
  cleanup(): Promise<void>;
}

export async function makeThrowawayOrigin(
  opts: {
    /** Extra files to seed, path (relative, may nest) → content. */
    files?: Record<string, string>;
  } = {},
): Promise<ThrowawayOrigin> {
  const root = await mkdtemp(join(tmpdir(), "runner-origin-"));
  const bare = `${root}/origin.git`;
  const seed = `${root}/seed`;

  await git(root, "init", "--bare", "-b", "main", bare);
  await mkdir(seed);
  await git(seed, "init", "-b", "main");
  await writeFile(`${seed}/README.md`, "# seeded repo\n");
  for (const [path, content] of Object.entries(opts.files ?? {})) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (dir) await mkdir(`${seed}/${dir}`, { recursive: true });
    await writeFile(`${seed}/${path}`, content);
  }
  await git(seed, "add", "-A");
  await git(
    seed,
    "-c",
    "user.name=seed",
    "-c",
    "user.email=seed@test.local",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "seed: initial commit",
  );
  await git(seed, "remote", "add", "origin", bare);
  await git(seed, "push", "origin", "main");

  return {
    url: bare,
    ref: "main",
    dir: root,
    cleanup: () => removeTree(root),
  };
}
