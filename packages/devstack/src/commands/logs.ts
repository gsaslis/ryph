import { writeSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import type { StackBackend } from "../backend.ts";
import { exitCode, listRuns, pipeLogs, streamLogs } from "../docker.ts";
import { selectUnits } from "../stack.ts";
import { dim, runColor, unitColor } from "../ui.ts";

/**
 * The short run-id form used in log prefixes: "r-" plus the id's LAST six characters. The tail,
 * because a sortable id starts with its timestamp: runs started minutes apart share their first
 * characters and differ only in the random end. A run's other containers (`ryph-browser-r-…`,
 * `ryph-svc-r-…-<name>`) keep their name's first characters, so they never pass for the run.
 */
const RUN_WIDTH = 8;

const shortRun = (runId: string) =>
  runId.startsWith("r-") && runId.length > RUN_WIDTH
    ? `r-${runId.slice(-(RUN_WIDTH - 2))}`
    : runId.slice(0, RUN_WIDTH);

/**
 * Prints or follows logs. Targets: a unit name (its piped pane output), "run [id]" (an agent
 * run container via docker — newest without an id, or, when following, every run as it
 * appears), or no target — all units merged, and in follow mode the run streams are
 * interleaved too, so the bare form watches the whole system.
 */
export async function logs(
  backend: StackBackend,
  target: string[],
  follow: boolean,
  tail?: number,
): Promise<number> {
  if (target[0] === "run") return await runLogs(follow, target[1]);

  const selected = selectUnits(target);
  const prefixed = selected.length > 1;
  // In the bare follow view run-id prefixes join the unit ones, so all pad to the wider column.
  const width = target.length === 0 && follow ? RUN_WIDTH : 5;
  const sources = selected.map((unit, i) => ({
    name: unit.name,
    path: backend.logPath(unit.name),
    color: unitColor(unit.name, i),
  }));

  for (const source of sources) {
    const text = await readIfExists(source.path);
    if (text === null) {
      if (!prefixed && !follow) {
        console.error(`no logs for ${source.name} yet (${dim(source.path)})`);
        return 1;
      }
      continue;
    }
    print(
      tail === undefined ? text : lastLines(text, tail),
      prefixed ? source : undefined,
      width,
    );
  }
  if (!follow) return 0;

  if (target.length === 0) {
    followRuns(
      (runId, line) => console.log(runColor(runId)(`${shortRun(runId).padEnd(width)} | `) + line),
      (note) => console.log(dim(note)),
    ).catch(() => {});
  }

  const offsets = new Map<string, number>();
  for (const source of sources) {
    offsets.set(source.path, await size(source.path));
  }
  const encoder = new TextEncoder();
  while (true) {
    await new Promise((r) => setTimeout(r, 200));
    for (const source of sources) {
      let from = offsets.get(source.path) ?? 0;
      const current = await size(source.path);
      if (current < from) from = 0;
      if (current <= from) continue;
      // The offset advances by what was consumed, not by the size sampled before the read: a
      // unit writing between the two would otherwise have those bytes printed twice.
      const chunk = await readFrom(source.path, from);
      let text = chunk.text;
      let consumed = chunk.bytes;
      if (prefixed) {
        // Prefixes are per line, so a chunk cut mid-line is held back until its newline lands.
        const lastBreak = text.lastIndexOf("\n");
        if (lastBreak === -1) continue;
        text = text.slice(0, lastBreak + 1);
        consumed = encoder.encode(text).length;
      }
      offsets.set(source.path, from + consumed);
      print(text, prefixed ? source : undefined, width);
    }
  }
}

async function runLogs(follow: boolean, runId?: string): Promise<number> {
  if (runId !== undefined) {
    const runs = await listRuns();
    if (runs === null) {
      console.error("docker not available");
      return 1;
    }
    // The whole id, the short form the log prefixes print, or the start of exactly one: ids
    // start with their mint time, so a short start can match every recent run.
    const prefixed = runs.filter((r) => r.runId.startsWith(runId));
    const target = runs.find((r) => r.runId === runId) ??
      runs.find((r) => shortRun(r.runId) === runId) ??
      (prefixed.length === 1 ? prefixed[0] : undefined);
    if (!target) {
      const matches = prefixed.length > 1
        ? `${prefixed.length} run containers match`
        : "no run container matches";
      console.error(`${matches} "${runId}" — ./dev status lists recent runs`);
      return 1;
    }
    console.error(dim(`run ${target.runId} (${target.state})`));
    await streamLogs(target.id, follow && target.running);
    return 0;
  }

  if (!follow) {
    const runs = await listRuns();
    if (runs === null) {
      console.error("docker not available");
      return 1;
    }
    const target = runs.find((r) => r.running) ?? runs[0];
    if (!target) {
      console.error("no run containers found");
      return 1;
    }
    console.error(dim(`run ${target.runId} (${target.state})`));
    await streamLogs(target.id, false);
    return 0;
  }

  console.error(dim("watching runs — every container as it appears; C-c stops"));
  await followRuns(
    (id, line) => console.log(runColor(id)(`${shortRun(id).padEnd(RUN_WIDTH)} | `) + line),
    (note) => console.error(dim(note)),
  );
  console.error("docker not available");
  return 1;
}

/**
 * Follows the whole run population: every container carrying the run label gets its own
 * concurrent stream the moment it appears, so parallel runs interleave instead of serializing.
 * Containers already exited when the watch starts are history; running ones are attached from
 * their beginning, and one that starts and exits between polls is still dumped in full. Each
 * stream's end is marked with the container's exit code. Resolves only when docker goes away.
 */
async function followRuns(
  onLine: (runId: string, line: string) => void,
  onEvent: (note: string) => void,
): Promise<void> {
  const seen = new Set<string>();
  let attaching = true;
  for (const run of (await listRuns()) ?? []) {
    if (!run.running) seen.add(run.id);
  }
  while (true) {
    const runs = await listRuns();
    if (runs === null) return;
    for (const run of runs.toReversed()) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      onEvent(`run ${run.runId} ${run.running ? (attaching ? "attached" : "started") : run.state}`);
      pipeLogs(run.id, run.running, (line) => onLine(run.runId, line))
        .then(async () => {
          onEvent(`run ${run.runId} exited (code ${await exitCode(run.id) ?? "?"})`);
        })
        .catch(() => {});
    }
    attaching = false;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n).map((line) => line + "\n").join("");
}

function print(
  text: string,
  source: { name: string; color: (s: string) => string } | undefined,
  width: number,
): void {
  if (!source) {
    writeSync(1, new TextEncoder().encode(text));
    return;
  }
  const prefix = source.color(`${source.name.padEnd(width)} | `);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) console.log(prefix + line);
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function size(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Reads a file from `offset` to EOF, reporting the byte count alongside the decoded text. */
async function readFrom(
  path: string,
  offset: number,
): Promise<{ text: string; bytes: number }> {
  const file = await open(path, "r");
  try {
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(64 * 1024);
    let position = offset;
    while (true) {
      const { bytesRead: n } = await file.read(buf, 0, buf.length, position);
      if (n === 0) break;
      position += n;
      chunks.push(buf.slice(0, n));
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const joined = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      joined.set(c, at);
      at += c.length;
    }
    return { text: new TextDecoder().decode(joined), bytes: total };
  } finally {
    await file.close();
  }
}
