// The process groups below a process, read from the OS's process table: what a subagent's stop
// kills besides the agent's own group.
//
// Needed because a group kill of the agent alone is not enough: pi's bash tool starts each
// command DETACHED, in a session and process group of its own (measured, pi 1.0.0 in
// ryph-agent:dev: pi pgid 34, its `sleep 100` pgid and sid 53), so it is no member of pi's group,
// and a SIGKILL to pi orphans it. Once orphaned it is re-parented and nothing ties it to pi any
// more, so its group is read here while pi is still its ancestor.
//
// Linux reads /proc (no `ps` needed in the environment's image); anything else asks `ps`.

import { readdir, readFile } from "node:fs/promises";
import { command } from "@ryph/process";

interface Row {
  pid: number;
  ppid: number;
  pgid: number;
}

/** Every process the OS lists, with its parent and group; empty when the table cannot be read. */
async function processTable(): Promise<Row[]> {
  if (process.platform === "linux") {
    const rows: Row[] = [];
    let entries: string[];
    try {
      entries = await readdir("/proc");
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!/^[0-9]+$/.test(entry)) continue;
      try {
        const stat = await readFile(`/proc/${entry}/stat`, "utf8");
        // `pid (comm) state ppid pgrp ...`: comm may hold spaces and parens, so after its last ')'.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        rows.push({ pid: Number(entry), ppid: Number(fields[1]), pgid: Number(fields[2]) });
      } catch {
        // Gone between the listing and the read.
      }
    }
    return rows;
  }
  try {
    const out = await command("ps", {
      args: ["-A", "-o", "pid=,ppid=,pgid="],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(out.stdout).split("\n").flatMap((line) => {
      const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
      return Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)
        ? [{ pid, ppid, pgid }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * The process groups of every descendant of `root`, `root`'s own excluded, and never this
 * process's own group nor 0 or 1. Empty when there are none, or the table cannot be read.
 */
export async function descendantGroups(root: number): Promise<number[]> {
  const rows = await processTable();
  const children = new Map<number, Row[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const own = rows.find((row) => row.pid === process.pid)?.pgid ?? null;
  const groups = new Set<number>();
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
      if (child.pgid > 1 && child.pgid !== root && child.pgid !== own) groups.add(child.pgid);
    }
  }
  return [...groups];
}

/** Whether any process is in group `pgid` that this process may signal. A group of another uid
 * (EPERM) is none of ours, so it reads as gone too. */
export function groupExists(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}
