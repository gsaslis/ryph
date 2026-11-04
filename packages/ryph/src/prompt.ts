// Terminal input for `ryph setup` and the shutdown question. Hand-rolled, because everything here
// has to work inside a compiled binary with no dependency that expects a package manager, and the
// whole interaction is four shapes — a line, a line that must not echo, a choice, and a yes/no.
//
// CHOICES ARE AN ARROW-KEY MENU AT A TERMINAL, AND NUMBERED EVERYWHERE ELSE. The menu holds raw
// mode for exactly one question and leaves it in a `finally`; anywhere raw mode is not on offer (a
// pipe, an odd terminal) the same question is asked as a numbered list read a line at a time, which
// works over anything and reads back the same in a pasted scrollback.
//
// NOBODY THERE IS A FIRST-CLASS CASE. `answeringPrompter` answers each question from its id —
// `ryph setup --egress direct` — and either asks the rest or takes their defaults, so a script or
// an agent drives the same wizard a person does, with no terminal at all.
//
// Everything is written to STDERR, like the banner and status block: `ryph up` on a fresh
// machine may be piped somewhere, and the questions are not that pipe's data.
//
// Input is read a chunk at a time from `process.stdin`, paused between reads, rather than through a
// stream reader, because a stream reader locks stdin for its lifetime and this module is asked for
// one line at a time across the whole wizard.

import { writeSync } from "node:fs";

const decoder = new TextDecoder();

const ABORTED = Symbol("aborted");

/** Bytes read past the end of the last line, kept for the next one. */
let pending = new Uint8Array(0);

/** Raised when the person answering goes away — EOF, or Ctrl-C during a hidden prompt. */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

/**
 * Raised when a question has no answer and nobody to ask: no flag for it, and no default to take.
 * The message names the flag that answers it.
 */
export class NeedsAnswer extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsAnswer";
  }
}

export interface Choice<T> {
  label: string;
  /** The dim half-sentence after the label: what picking this actually gets you. */
  hint?: string;
  value: T;
  /** The word a flag answers this choice with; the value itself when that is a string. */
  key?: string;
}

/** Every question can carry an id: the flag (`--<id>`) that answers it without a terminal. */
export interface QuestionId {
  id?: string;
}

export interface SelectOptions extends QuestionId {
  /** Abandons the question: the menu is taken down and the promise never settles. */
  signal?: AbortSignal;
}

export interface Prompter {
  say(text?: string): void;
  /** A step's title: bold, and kept at the top of every page while the step lasts. */
  heading(text: string): void;
  /** Done asking: gives the normal screen back, where what follows is printed. */
  close?(): void;
  ask(question: string, opts?: AskOptions): Promise<string>;
  /** Reads without echoing. For a master key or a token, which end up in scrollback otherwise. */
  secret(question: string, opts?: QuestionId): Promise<string>;
  select<T>(
    question: string,
    choices: Choice<T>[],
    defaultIndex?: number,
    opts?: SelectOptions,
  ): Promise<T>;
  confirm(question: string, defaultYes: boolean, opts?: QuestionId): Promise<boolean>;
}

export interface AskOptions extends QuestionId {
  /** Offered in brackets and returned when the answer is empty. */
  default?: string;
  /** Returns a complaint to re-ask with, or null when the answer is good. */
  validate?: (value: string) => string | null | Promise<string | null>;
  /** Whether an empty answer with no default is allowed through as "". */
  optional?: boolean;
}

/** Set (to anything but 0) by `--no-input`: never ask, even at a terminal. */
export const NO_INPUT = "RYPH_NO_INPUT";

/**
 * Whether there is a person on the other end — both halves, since we ask on one and read the
 * other — and nobody said not to ask.
 */
export function interactiveTerminal(): boolean {
  const off = process.env[NO_INPUT]?.trim();
  if (off && off !== "0") return false;
  try {
    return process.stdin.isTTY === true && process.stderr.isTTY === true;
  } catch {
    return false;
  }
}

/** Told about everything written, while a paged wizard needs to know where the cursor is. */
let tracker: ((text: string) => void) | null = null;

function write(text: string): void {
  writeSync(2, text);
  tracker?.(text);
}

/**
 * Where the cursor is, in rows below where a page began, worked out from what was written. Good
 * enough for what this module writes: plain text, colour codes, `\r`, backspace and cursor-up.
 */
class Cursor {
  row = 0;
  private col = 0;

  feed(text: string): void {
    const cols = terminalColumns();
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\x1b") {
        // oxlint-disable-next-line no-control-regex
        const csi = /^\x1b\[([0-9;?]*)([@-~])/.exec(text.slice(i, i + 16));
        if (csi) {
          if (csi[2] === "A") this.row = Math.max(0, this.row - (Number(csi[1]) || 1));
          if (csi[2] === "B") this.row += Number(csi[1]) || 1;
          i += csi[0].length - 1;
        }
        continue;
      }
      if (ch === "\n") {
        this.row++;
        this.col = 0;
      } else if (ch === "\r") this.col = 0;
      else if (ch === "\b") this.col = Math.max(0, this.col - 1);
      else if (ch >= " " && ch !== "\ufe0f" && !(ch >= "\udc00" && ch <= "\udfff")) {
        // A character past the last column lands on the next row.
        if (this.col >= cols) {
          this.row++;
          this.col = 0;
        }
        this.col++;
      }
    }
  }

  reset(): void {
    this.row = 0;
    this.col = 0;
  }
}

function terminalColumns(): number {
  try {
    return Math.max(20, process.stderr.columns || 80);
  } catch {
    return 80;
  }
}

/**
 * `text` broken at spaces to fit `width`, each line keeping the first one's indent. Words longer
 * than a line are broken where they must be. A terminal's own wrapping cuts words in half.
 */
export function wrapText(text: string, width: number): string {
  return text.split("\n").map((line) => {
    // A line that fits is left exactly as it is: its spacing may be alignment.
    if (visibleWidth(line) <= width) return line;
    const indent = /^ */.exec(line)![0];
    const room = Math.max(4, width - indent.length);
    const out: string[] = [];
    let current = "";
    for (const word of line.slice(indent.length).split(/ +/)) {
      if (current === "") current = word;
      else if (visibleWidth(current) + 1 + visibleWidth(word) <= room) current += ` ${word}`;
      else {
        out.push(current);
        current = word;
      }
      while (visibleWidth(current) > room) {
        out.push(current.slice(0, room));
        current = current.slice(room);
      }
    }
    out.push(current);
    return out.map((l) => indent + l).join("\n");
  }).join("\n");
}

/** Wrapped to the terminal, at a terminal; as it is anywhere else. */
function fit(text: string): string {
  try {
    if (process.stderr.isTTY !== true) return text;
  } catch {
    return text;
  }
  return wrapText(text, terminalColumns() - 1);
}

/**
 * The next chunk on stdin, or null at its end. Stdin is paused again as soon as the chunk is in,
 * so nothing is read while nobody is asking and the process is not held open between questions.
 */
function readChunk(): Promise<Uint8Array | null>;
function readChunk(signal?: AbortSignal): Promise<Uint8Array | null | typeof ABORTED>;
function readChunk(signal?: AbortSignal): Promise<Uint8Array | null | typeof ABORTED> {
  const stdin = process.stdin;
  if (signal?.aborted) return Promise.resolve(ABORTED);
  if (stdin.readableEnded) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const settle = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      stdin.pause();
    };
    // Abandoned: the listeners go, so nothing holds the loop open or eats the next keystroke.
    const onAbort = () => {
      settle();
      resolve(ABORTED);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const onData = (chunk: Uint8Array | string) => {
      settle();
      resolve(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
    };
    const onEnd = () => {
      settle();
      resolve(null);
    };
    const onError = (err: Error) => {
      settle();
      reject(err);
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
  });
}

async function readLine(): Promise<string | null> {
  for (;;) {
    const nl = pending.indexOf(0x0a);
    if (nl >= 0) {
      const line = decoder.decode(pending.subarray(0, nl));
      pending = pending.slice(nl + 1);
      return line.replace(/\r$/, "");
    }
    const chunk = await readChunk();
    if (chunk === null) {
      if (pending.length === 0) return null;
      const line = decoder.decode(pending);
      pending = new Uint8Array(0);
      return line;
    }
    const grown = new Uint8Array(pending.length + chunk.length);
    grown.set(pending);
    grown.set(chunk, pending.length);
    pending = grown;
  }
}

const ESC = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  accent: (s: string) => `\x1b[36m${s}\x1b[0m`,
  good: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const PLAIN: typeof ESC = { bold: (s) => s, dim: (s) => s, accent: (s) => s, good: (s) => s };

function colours(): typeof ESC {
  if (process.env.NO_COLOR) return PLAIN;
  try {
    return process.stderr.isTTY === true ? ESC : PLAIN;
  } catch {
    return PLAIN;
  }
}

/** The real one: questions to stderr, answers from the tty. */
export function terminalPrompter(opts: { paged?: boolean } = {}): Prompter {
  const c = colours();

  // PAGED: one question on screen at a time. After an answer, the first thing written clears
  // back up to where that question's page began and puts the step's heading back, so what is on
  // screen is the current question and what was said to explain it. It stays on the normal
  // screen, under whatever was there before: the cursor's row is tracked from what is written
  // (and from what the terminal echoes of a typed answer), and only those rows are cleared.
  // Only where both halves are a terminal: in a pipe the questions read as a plain transcript.
  let paged = false;
  try {
    paged = opts.paged === true && process.stdin.isTTY === true && process.stderr.isTTY === true;
  } catch {
    paged = false;
  }
  const cursor = new Cursor();
  let heading: string | null = null;
  let answered = false;
  /** Nothing but the heading on this page yet: a blank line here would only push it down. */
  let fresh = true;
  /** Before anything is written: tracking from here on, and a fresh page after an answer. */
  const page = () => {
    if (!paged) return;
    if (tracker === null) tracker = (text) => cursor.feed(text);
    if (!answered) return;
    answered = false;
    write(`${cursor.row > 0 ? `\x1b[${cursor.row}A` : ""}\r\x1b[J`);
    cursor.reset();
    if (heading !== null) write(`${heading}\n\n`);
    fresh = true;
  };
  /** Marks a question answered: the next thing said starts a new page. */
  const done = <T>(value: T): T => {
    answered = true;
    return value;
  };
  /** What the terminal echoed of a typed line, which moved the cursor without our writing it. */
  const echoed = (line: string) => {
    if (paged) cursor.feed(`${line}\n`);
  };

  return {
    say(text = "") {
      page();
      if (text === "" && fresh) return;
      fresh = false;
      write(`${fit(text)}\n`);
    },

    heading(text) {
      heading = c.bold(text);
      // Straight after an answer the new page starts with this heading; otherwise it follows
      // whatever is already on this one, a blank line below it.
      if (paged && answered) return page();
      page();
      write(`${fresh ? "" : "\n"}${heading}\n\n`);
      fresh = true;
    },

    close() {
      // For good: what is said after this stays, so nothing may page again.
      paged = false;
      tracker = null;
    },

    async ask(question, opts = {}) {
      page();
      fresh = false;
      for (;;) {
        const suffix = opts.default !== undefined ? ` ${c.dim(`[${opts.default}]`)}` : "";
        write(`${c.accent("?")} ${c.bold(question)}${suffix}: `);
        const line = await readLine();
        if (line === null) throw new Cancelled();
        echoed(line);
        const answer = line.trim() === "" ? (opts.default ?? "") : line.trim();
        if (answer === "" && !opts.optional && opts.default === undefined) {
          write(`${c.dim("an answer is needed")}\n`);
          continue;
        }
        const complaint = answer === "" ? null : await opts.validate?.(answer) ?? null;
        if (complaint === null) return done(answer);
        write(`${c.dim(complaint)}\n`);
      }
    },

    async secret(question) {
      page();
      fresh = false;
      write(`${c.accent("?")} ${c.bold(question)}: `);
      const value = await readHidden();
      write("\n");
      return done(value);
    },

    async select(question, choices, defaultIndex = 0, opts = {}) {
      page();
      fresh = false;
      const picked = await arrowSelect(question, choices, defaultIndex, c, opts.signal);
      if (picked !== undefined) return done(picked);
      return done(await numberedSelect(question, choices, defaultIndex, c));
    },

    async confirm(question, defaultYes) {
      page();
      fresh = false;
      const picked = await arrowSelect(
        question,
        [{ label: "Yes", value: true }, { label: "No", value: false }],
        defaultYes ? 0 : 1,
        c,
      );
      if (picked !== undefined) return done(picked);
      for (;;) {
        write(`${c.accent("?")} ${c.bold(question)} ${c.dim(defaultYes ? "[Y/n]" : "[y/N]")}: `);
        const line = await readLine();
        if (line === null) throw new Cancelled();
        echoed(line);
        const answer = line.trim().toLowerCase();
        if (answer === "") return done(defaultYes);
        if (["y", "yes"].includes(answer)) return done(true);
        if (["n", "no"].includes(answer)) return done(false);
      }
    },
  };
}

/** A question as a numbered list, answered by a line: where there is no raw mode to draw a menu in. */
async function numberedSelect<T>(
  question: string,
  choices: Choice<T>[],
  defaultIndex: number,
  c: typeof ESC,
): Promise<T> {
  write(`${c.bold(question)}\n`);
  for (const [i, choice] of choices.entries()) {
    const marker = i === defaultIndex ? c.accent("›") : " ";
    const hint = choice.hint ? `  ${c.dim(choice.hint)}` : "";
    write(`${marker} ${c.bold(String(i + 1))}. ${choice.label}${hint}\n`);
  }
  for (;;) {
    write(`choose ${c.dim(`[${defaultIndex + 1}]`)}: `);
    const line = await readLine();
    if (line === null) throw new Cancelled();
    const raw = line.trim();
    const n = raw === "" ? defaultIndex + 1 : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
    write(`${c.dim(`pick a number between 1 and ${choices.length}`)}\n`);
  }
}

/** What a key press in the menu means. */
type MenuKey = "up" | "down" | "first" | "last" | "enter" | "interrupt" | "eof" | number;

/** The menu's keys in one chunk of raw input, in order; everything else is dropped. */
export function menuKeys(chunk: Uint8Array): MenuKey[] {
  const text = decoder.decode(chunk);
  const keys: MenuKey[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\x1b") {
      // CSI (`ESC [`) and SS3 (`ESC O`) both carry the arrows, depending on the terminal's mode.
      // The whole sequence is consumed whatever it is, so Delete (`ESC [3~`) or Ctrl-Up
      // (`ESC [1;5A`) is never read as the digits inside it.
      const seq = /^(?:\[[0-?]*[ -/]*[@-~]|O.)/.exec(text.slice(i + 1));
      if (seq === null) continue;
      i += seq[0].length;
      const key = ({
        "[A": "up",
        "OA": "up",
        "[B": "down",
        "OB": "down",
        "[H": "first",
        "OH": "first",
        "[1~": "first",
        "[F": "last",
        "OF": "last",
        "[4~": "last",
      } as Record<string, MenuKey>)[seq[0]];
      if (key !== undefined) keys.push(key);
      continue;
    }
    if (ch === "\r" || ch === "\n") keys.push("enter");
    else if (ch === "\x03") keys.push("interrupt");
    else if (ch === "\x04") keys.push("eof");
    else if (ch === "k" || ch === "\x10") keys.push("up"); // k, Ctrl-P
    else if (ch === "j" || ch === "\x0e") keys.push("down"); // j, Ctrl-N
    else if (ch >= "1" && ch <= "9") keys.push(Number(ch) - 1);
  }
  return keys;
}

/** Visible width of a line once its colour codes are gone. */
function visibleWidth(text: string): number {
  // oxlint-disable-next-line no-control-regex
  return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

/** Terminal rows a block of lines takes, wrapping included, so a redraw knows how far to go up. */
function rowsOf(lines: string[], columns: number): number {
  return lines.flatMap((line) => line.split("\n")).reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(visibleWidth(line) / columns)),
    0,
  );
}

/**
 * A question as a menu: ↑/↓ (or j/k, or the choice's number) to move, Enter to pick. Undefined
 * when there is no terminal to put in raw mode, and the caller asks it numbered instead.
 *
 * Only the highlighted choice's hint is shown, on the line under the list: hints are half a
 * sentence each, and all of them at once wrap into a wall on a narrow terminal. Once picked, the
 * menu folds into one line saying what was chosen, so the scrollback reads like a transcript.
 *
 * Ctrl-C arrives as a byte in raw mode rather than as a signal, so it is turned back into one:
 * where something listens for SIGINT (`ryph up`'s shutdown, whose second Ctrl-C means "exit now")
 * the signal is raised and the question is left unanswered, as a line prompt's would be; with no
 * listener it cancels like Ctrl-D.
 */
async function arrowSelect<T>(
  question: string,
  choices: Choice<T>[],
  defaultIndex: number,
  c: typeof ESC,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const stdin = process.stdin;
  try {
    if (stdin.isTTY !== true || process.stderr.isTTY !== true) return undefined;
    stdin.setRawMode(true);
  } catch {
    return undefined;
  }

  let index = Math.min(Math.max(defaultIndex, 0), choices.length - 1);
  let drawn = 0;
  const columns = () => Math.max(20, process.stderr.columns || 80);

  const draw = () => {
    const width = columns() - 1;
    const lines = [`${c.accent("?")} ${c.bold(wrapText(question, width - 2))}`];
    for (const [i, choice] of choices.entries()) {
      lines.push(i === index ? `${c.accent("❯")} ${c.accent(choice.label)}` : `  ${choice.label}`);
    }
    const hint = choices[index].hint;
    lines.push(c.dim(wrapText(hint ? `  ${hint}` : "  ↑/↓ to move · enter to choose", width)));
    // Back to the top of the last drawing, then down over it: clearing to the end of the
    // screen takes whatever a longer hint wrapped onto.
    const up = drawn > 1 ? `\x1b[${drawn - 1}A` : "";
    write(`${drawn > 0 ? `${up}\r\x1b[J` : ""}${lines.join("\n")}`);
    drawn = rowsOf(lines, columns());
  };
  const clear = () => {
    if (drawn === 0) return;
    write(`${drawn > 1 ? `\x1b[${drawn - 1}A` : ""}\r\x1b[J`);
    drawn = 0;
  };

  const restore = () => {
    try {
      stdin.setRawMode(false);
    } catch {
      // Already out of raw mode.
    }
    write("\x1b[?25h");
  };
  // A process that exits mid-question (a signal handler calling exit) must not leave the
  // terminal raw and the cursor hidden behind it.
  process.once("exit", restore);
  write("\x1b[?25l");

  try {
    draw();
    for (;;) {
      const chunk = await readChunk(signal);
      if (chunk === ABORTED) {
        // Never settles, so the `finally` below never runs: the terminal is given back here.
        clear();
        restore();
        return await new Promise<never>(() => {});
      }
      if (chunk === null) throw new Cancelled();
      for (const key of menuKeys(chunk)) {
        if (key === "up") index = (index - 1 + choices.length) % choices.length;
        else if (key === "down") index = (index + 1) % choices.length;
        else if (key === "first") index = 0;
        else if (key === "last") index = choices.length - 1;
        else if (typeof key === "number") {
          if (key < choices.length) index = key;
        } else if (key === "enter") {
          clear();
          write(`${c.good("✔")} ${c.bold(question)} ${c.dim("·")} ${choices[index].label}\n`);
          return choices[index].value;
        } else if (key === "eof") {
          clear();
          throw new Cancelled();
        } else if (key === "interrupt") {
          clear();
          if (process.listenerCount("SIGINT") > 0) {
            restore();
            process.kill(process.pid, "SIGINT");
            return await new Promise<never>(() => {});
          }
          throw new Cancelled();
        }
      }
      draw();
    }
  } finally {
    process.off("exit", restore);
    restore();
  }
}

/** A URL with its password masked (`smtp://bob:•••@host`), for anything said back or printed. */
export function maskUrl(text: string): string {
  return text.replace(/(\/\/[^:/@\s]*):[^@/\s]+@/g, "$1:•••@");
}

/** What a flag can say to a yes/no question. */
const YES = ["y", "yes", "true", "1", "on"];
const NO = ["n", "no", "false", "0", "off"];

/**
 * Answers questions from their ids — the flags `ryph setup` was given — and passes everything
 * else to `fallback`: a terminal to ask, or null to take each question's default. A question with
 * no flag and no default, and nobody to ask, is a NeedsAnswer naming the flag.
 *
 * Every answer it gives on its own is said back (`Internet access: direct`), so a log of an
 * unattended setup reads like the transcript of an attended one.
 */
export function answeringPrompter(
  answers: Map<string, string>,
  fallback: Prompter | null,
  say: (text?: string) => void = (text = "") => write(`${text}\n`),
): Prompter & { unused(): string[] } {
  const used = new Set<string>();
  const take = (id: string | undefined): string | undefined => {
    if (id === undefined || !answers.has(id)) return undefined;
    used.add(id);
    return answers.get(id);
  };
  const flag = (id: string | undefined) => id === undefined ? "a terminal" : `--${id}`;
  const told = (question: string, answer: string) => say(`${question}: ${maskUrl(answer)}`);

  // Said through the terminal when there is one, so its paging sees every line.
  if (fallback) say = (text) => fallback.say(text);
  return {
    say,

    heading(text) {
      if (fallback) return fallback.heading(text);
      say();
      say(text);
      say();
    },

    close() {
      fallback?.close?.();
    },

    unused: () => [...answers.keys()].filter((id) => !used.has(id)),

    async ask(question, opts = {}) {
      let answer = take(opts.id);
      if (answer === undefined) {
        if (fallback) return await fallback.ask(question, opts);
        answer = opts.default;
        if (answer === undefined) {
          if (opts.optional) return "";
          throw new NeedsAnswer(`"${question}" needs an answer: pass ${flag(opts.id)}`);
        }
      }
      answer = answer.trim();
      if (answer === "" && !opts.optional && opts.default === undefined) {
        throw new NeedsAnswer(`${flag(opts.id)} needs a value`);
      }
      const complaint = answer === "" ? null : await opts.validate?.(answer) ?? null;
      if (complaint !== null) throw new NeedsAnswer(`${flag(opts.id)} ${answer}: ${complaint}`);
      told(question, answer);
      return answer;
    },

    async secret(question, opts = {}) {
      const answer = take(opts.id);
      if (answer === undefined) {
        if (fallback) return await fallback.secret(question, opts);
        throw new NeedsAnswer(`"${question}" needs an answer: pass ${flag(opts.id)}`);
      }
      if (answer !== "-") return answer.trim();
      // `-` reads it from stdin, so it stays out of the process list and the shell history; at a
      // terminal, without echoing it.
      if (process.stdin.isTTY === true) {
        write(`${question}: `);
        const value = await readHidden();
        write("\n");
        return value;
      }
      const line = await readLine();
      if (line === null) throw new NeedsAnswer(`${flag(opts.id)} -: nothing on stdin`);
      return line.trim();
    },

    async select(question, choices, defaultIndex = 0, opts = {}) {
      const keyOf = (choice: Choice<unknown>) =>
        choice.key ?? (typeof choice.value === "string" ? choice.value : choice.label);
      const answer = take(opts.id);
      if (answer === undefined) {
        if (fallback) return await fallback.select(question, choices, defaultIndex, opts);
        const choice = choices[defaultIndex];
        told(question, choice.label);
        return choice.value;
      }
      const choice = choices.find((c) => keyOf(c) === answer.trim().toLowerCase());
      if (choice === undefined) {
        throw new NeedsAnswer(
          `${flag(opts.id)} ${answer} is not one of the choices here: ` +
            choices.map(keyOf).join(", "),
        );
      }
      told(question, choice.label);
      return choice.value;
    },

    async confirm(question, defaultYes, opts = {}) {
      const answer = take(opts.id)?.trim().toLowerCase();
      if (answer === undefined) {
        if (fallback) return await fallback.confirm(question, defaultYes, opts);
        told(question, defaultYes ? "yes" : "no");
        return defaultYes;
      }
      if (YES.includes(answer)) {
        told(question, "yes");
        return true;
      }
      if (NO.includes(answer)) {
        told(question, "no");
        return false;
      }
      throw new NeedsAnswer(`${flag(opts.id)} takes yes or no, not ${answer}`);
    },
  };
}

/**
 * A line with echo suppressed, for a master key or a token.
 *
 * Raw mode is entered for exactly this read and left in a `finally`, so a validation failure or a
 * Ctrl-C cannot strand the terminal without an echo. Only the four keys that matter are
 * interpreted — Enter, Backspace, Ctrl-C, Ctrl-D — and every other control byte is dropped rather
 * than guessed at; a pasted token arrives as one chunk of printable bytes either way.
 */
async function readHidden(): Promise<string> {
  const bytes: number[] = [];
  try {
    if (process.stdin.isTTY !== true) throw new Error("stdin is not a terminal");
    process.stdin.setRawMode(true);
  } catch {
    // No tty to put in raw mode (a pipe under test, an odd terminal): read it plainly rather
    // than refusing. The value is still not echoed by us — only by whatever is feeding it.
    const line = await readLine();
    if (line === null) throw new Cancelled();
    return line.trim();
  }
  try {
    for (;;) {
      const chunk = await readChunk();
      if (chunk === null) throw new Cancelled();
      for (const byte of chunk) {
        if (byte === 0x0d || byte === 0x0a) return decoder.decode(new Uint8Array(bytes)).trim();
        if (byte === 0x03) throw new Cancelled(); // Ctrl-C: raw mode ate the signal
        if (byte === 0x04) {
          if (bytes.length === 0) throw new Cancelled(); // Ctrl-D on an empty line is EOF
          continue;
        }
        if (byte === 0x7f || byte === 0x08) {
          if (bytes.length > 0) {
            bytes.pop();
            write("\b \b");
          }
          continue;
        }
        if (byte < 0x20) continue;
        bytes.push(byte);
        write("•");
      }
    }
  } finally {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Already out of raw mode, or never in it.
    }
  }
}
