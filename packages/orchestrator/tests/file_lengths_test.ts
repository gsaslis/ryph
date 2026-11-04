import { test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals } from "@std/assert";
import { longSourceFiles } from "../scripts/check_file_lengths.ts";

test("file-length advisory counts source lines, recurses, and ignores non-source files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    await mkdir(`${dir}/nested`);
    await writeFile(`${dir}/empty.ts`, "");
    await writeFile(`${dir}/at-limit.ts`, "line\n".repeat(800));
    await writeFile(`${dir}/no-final-newline.ts`, "line\n".repeat(799) + "line");
    await writeFile(`${dir}/long.ts`, "line\n".repeat(801));
    await writeFile(`${dir}/nested/page.svelte`, "line\n".repeat(800) + "line");
    await writeFile(`${dir}/not-source.md`, "line\n".repeat(900));
    assertEquals(await longSourceFiles(dir), [
      { path: "long.ts", lines: 801 },
      { path: "nested/page.svelte", lines: 801 },
    ]);
  } finally {
    await rm(dir, { recursive: true });
  }
});
