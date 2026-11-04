// The menu's key handling, and the prompter that answers from flags. The menu's drawing needs a
// real terminal; what a key press means does not.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { answeringPrompter, menuKeys, type Prompter, wrapText } from "../src/prompt.ts";

const keys = (s: string) => menuKeys(new TextEncoder().encode(s));

test("arrows in both terminal modes, vi keys, numbers and Enter", () => {
  assertEquals(keys("\x1b[A\x1b[B\x1bOA\x1bOB"), ["up", "down", "up", "down"]);
  assertEquals(keys("kj\x10\x0e"), ["up", "down", "up", "down"]);
  assertEquals(keys("\x1b[H\x1b[F\x1b[1~\x1b[4~"), ["first", "last", "first", "last"]);
  assertEquals(keys("3\r"), [2, "enter"]);
  assertEquals(keys("\x03"), ["interrupt"]);
  assertEquals(keys("\x04"), ["eof"]);
});

test("anything else is dropped, including a lone Escape and other sequences", () => {
  assertEquals(keys("\x1b"), []);
  assertEquals(keys("\x1b[C\x1b[Dxq "), []);
  assertEquals(keys("\x1b[C\x1b[B"), ["down"]);
});

test("a flag answers its question; the rest go to the terminal", async () => {
  const asked: string[] = [];
  const terminal: Prompter = {
    say() {},
    heading() {},
    ask: (q) => (asked.push(q), Promise.resolve("typed")),
    secret: (q) => (asked.push(q), Promise.resolve("hidden")),
    select: (q, choices) => (asked.push(q), Promise.resolve(choices[1].value)),
    confirm: (q) => (asked.push(q), Promise.resolve(true)),
  };
  const io = answeringPrompter(new Map([["mail", "smtp"]]), terminal, () => {});
  const choices = [{ label: "skip", value: "skip" }, { label: "smtp", value: "smtp" }];
  assertEquals(await io.select("Mail", choices, 0, { id: "mail" }), "smtp");
  assertEquals(await io.select("Other", choices, 0, { id: "other" }), "smtp");
  assertEquals(await io.ask("url", { id: "smtp-url" }), "typed");
  assertEquals(asked, ["Other", "url"], "the flagged question was not asked");
});

test("a choice's key answers it when its value is not a word", async () => {
  const io = answeringPrompter(new Map([["mail", "keep"], ["sure", "no"]]), null, () => {});
  const choices = [{ label: "keep the current server", value: "skip", key: "keep" }, {
    label: "smtp",
    value: "smtp",
  }];
  assertEquals(await io.select("Mail", choices, 1, { id: "mail" }), "skip");
  assertEquals(await io.confirm("Sure?", true, { id: "sure" }), false);
  assertEquals(await io.confirm("Unflagged?", false), false, "the default, with nobody to ask");
});

test("other keys' escape sequences are consumed whole, never read as their digits", () => {
  assertEquals(keys("\x1b[3~\x1b[2~\x1b[15~\x1b[1;5A\x1b[7~"), []);
  assertEquals(keys("\x1b[3~2"), [1]);
});

test("a URL's password is never said back", async () => {
  const said: string[] = [];
  const io = answeringPrompter(
    new Map([["smtp-url", "smtp://bob:hunter2@host:587"]]),
    null,
    (t = "") => said.push(t),
  );
  assertEquals(await io.ask("SMTP URL", { id: "smtp-url" }), "smtp://bob:hunter2@host:587");
  assertEquals(said, ["SMTP URL: smtp://bob:•••@host:587"]);
});

test("an empty flag for a question that needs an answer is refused", async () => {
  const io = answeringPrompter(new Map([["smtp-url", ""]]), null, () => {});
  const err = await io.ask("SMTP URL", { id: "smtp-url" }).then(() => null, (e) => e);
  assertEquals(err?.name, "NeedsAnswer");
});

test("text is wrapped at spaces, keeping its indent", () => {
  assertEquals(wrapText("one two three four", 9), "one two\nthree\nfour");
  assertEquals(wrapText("  a bb ccc dddd", 8), "  a bb\n  ccc\n  dddd");
  assertEquals(wrapText("abcdefghijkl", 10), "abcdefghij\nkl");
  assertEquals(wrapText("short", 80), "short");
});

test("a line that fits keeps its spacing", () => {
  assertEquals(wrapText("  KEY      value", 80), "  KEY      value");
});
