import type { StackBackend } from "../backend.ts";
import { selectUnits } from "../stack.ts";
import { dim } from "../ui.ts";

/** Stops the named units (default: all); missing ones are reported, not errors. */
export async function down(
  backend: StackBackend,
  names: string[],
): Promise<number> {
  const desired = selectUnits(names);
  const observed = await backend.list();
  let stopped = 0;
  for (const unit of desired) {
    if (!observed.has(unit.name)) {
      console.log(`  ${unit.name.padEnd(6)} not running ${dim("skipped")}`);
      continue;
    }
    await backend.stop(unit.name);
    console.log(`  ${unit.name.padEnd(6)} stopped`);
    stopped++;
  }
  if (names.length === 0) await backend.removeShell();
  if (stopped === 0) console.log(dim("nothing to stop"));
  return 0;
}
