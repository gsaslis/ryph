// What `ryph up` prints. This is the whole first impression of a downloaded binary, so it is
// treated as an interface rather than as logging: the machinery's own log lines go to the
// structured logger, and this block answers only the questions a person actually has — is it up,
// where do I go, and what is switched off that I might have expected to be on.
//
// Everything is written to STDERR. The status block is not data, and a `ryph up | something`
// should not have to filter it out.
//
// Colour degrades rather than breaking: NO_COLOR or a non-TTY (a pipe, a CI log, a systemd
// unit) drops the styling without changing the content. The lettering itself is plain ASCII.

import { writeSync } from "node:fs";

// Conventional terminal lettering, with the brand's Ryph capitalization rather than an
// approximation of the logo's typeface. One drawing works in every terminal locale.
const WORDMARK = [
  " ____              _",
  String.raw`|  _ \ _   _ _ __ | |__`,
  "| |_) | | | | '_ \\| '_ \\",
  "|  _ <| |_| | |_) | | | |",
  String.raw`|_| \_\\__, | .__/|_| |_|`,
  "       |___/|_|",
];

interface Style {
  bold: (s: string) => string;
  dim: (s: string) => string;
  accent: (s: string) => string;
  good: (s: string) => string;
  warn: (s: string) => string;
}

const plain: Style = {
  bold: (s) => s,
  dim: (s) => s,
  accent: (s) => s,
  good: (s) => s,
  warn: (s) => s,
};

const coloured: Style = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  accent: (s) => `\x1b[36m${s}\x1b[0m`,
  good: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
};

function style(): Style {
  if (process.env.NO_COLOR) return plain;
  try {
    return process.stderr.isTTY === true ? coloured : plain;
  } catch {
    return plain;
  }
}

export function banner(version: string): string {
  const s = style();
  const art = WORDMARK.map((line) => s.accent(line));
  const width = Math.max(...WORDMARK.map((line) => line.length));
  // `v0.1.0` for a release; an edge build's `sha-…` and `dev` as they are.
  const tag = /^\d/.test(version) ? `v${version}` : version;
  return [
    "",
    ...art,
    s.dim(`${" ".repeat(Math.max(0, width - tag.length))}${tag}`),
    "",
  ].join("\n");
}

/** One line of the status block: a label, a value, and whether the value is reassuring. */
export interface StatusRow {
  label: string;
  value: string;
  tone?: "good" | "warn" | "plain";
}

export interface StatusBlock {
  /** Set on a launch that provisioned or migrated the database. */
  setup?: string[];
  rows: StatusRow[];
  /** Where to send the person next, and anything that will bite them. */
  notes?: string[];
  /** The one URL worth opening. */
  open?: string;
}

export function status(block: StatusBlock): string {
  const s = style();
  const out: string[] = [];

  if (block.setup && block.setup.length > 0) {
    out.push(s.bold("  First launch"));
    for (const line of block.setup) out.push(`    ${s.good("✓")} ${line}`);
    out.push("");
  }

  const width = Math.max(...block.rows.map((r) => r.label.length));
  for (const row of block.rows) {
    const label = s.dim(row.label.padEnd(width));
    const value = row.tone === "good"
      ? s.good(row.value)
      : row.tone === "warn"
      ? s.warn(row.value)
      : row.value;
    out.push(`  ${label}  ${value}`);
  }

  if (block.notes && block.notes.length > 0) {
    out.push("");
    for (const note of block.notes) out.push(`  ${s.warn("!")} ${note}`);
  }

  if (block.open) {
    out.push("");
    out.push(`  ${s.bold("Open")} ${s.accent(block.open)}`);
  }
  out.push("");
  return out.join("\n");
}

/**
 * Writes to stderr, which is where all of this belongs — see the note at the top. Never throws:
 * once the terminal is closed every write fails (EIO), and what prints then is the shutdown the
 * hangup started, which must not be aborted by having nowhere to say so.
 */
export function print(text: string): void {
  try {
    writeSync(2, `${text}\n`);
  } catch {
    try {
      console.error(text);
    } catch {
      // Nowhere left to say it.
    }
  }
}
