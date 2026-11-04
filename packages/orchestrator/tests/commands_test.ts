// The /ryph command grammar, pure — every edge a comment body can throw at it.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { parseRyphCommand } from "../src/core/commands.ts";

test("a plain command parses: handle, then everything else as instructions", () => {
  assertEquals(parseRyphCommand("/ryph ada fix the flaky test"), {
    kind: "command",
    handle: "ada",
    instructions: "fix the flaky test",
  });
});

test("instructions span lines: the rest of the command line plus every line after", () => {
  assertEquals(parseRyphCommand("/ryph ada fix this\nand also that\n\nthanks!"), {
    kind: "command",
    handle: "ada",
    instructions: "fix this\nand also that\n\nthanks!",
  });
});

test("the command need not be the first line, and the token is case-insensitive", () => {
  const parsed = parseRyphCommand("Some context first.\n\n/Ryph ada do the thing");
  assertEquals(parsed.kind, "command");
});

test("a comment with no /ryph token is simply not addressed to us", () => {
  assertEquals(parseRyphCommand("just discussing /ryphish things").kind, "none");
  assertEquals(parseRyphCommand("").kind, "none");
  // Mid-line mentions don't trigger: the token must start its line.
  assertEquals(parseRyphCommand("try running /ryph ada maybe?").kind, "none");
});

test("addressed but unusable is malformed, never silently a command", () => {
  assertEquals(parseRyphCommand("/ryph").kind, "malformed"); // no handle
  assertEquals(parseRyphCommand("/ryph @ada fix it").kind, "malformed"); // not slug-shaped
  assertEquals(parseRyphCommand("/ryph ada").kind, "malformed"); // no instructions
  assertEquals(parseRyphCommand("/ryph ada       \n  ").kind, "malformed"); // blank instructions
});

test("a capitalised handle addresses the same agent — folded like the token itself", () => {
  // Handles are lower-case by construction, so "Ada" cannot name a different agent than "ada".
  assertEquals(parseRyphCommand("/ryph Ada fix it"), {
    kind: "command",
    handle: "ada",
    instructions: "fix it",
  });
});

test("only the FIRST command line counts; later ones ride along as instructions", () => {
  assertEquals(parseRyphCommand("/ryph ada first\n/ryph bob second"), {
    kind: "command",
    handle: "ada",
    instructions: "first\n/ryph bob second",
  });
});

test("a fenced /ryph still triggers — markdown is deliberately not parsed", () => {
  const parsed = parseRyphCommand("```\n/ryph ada from inside a fence\n```");
  assertEquals(parsed.kind, "command");
});

test("leading whitespace before the token is tolerated", () => {
  assertEquals(parseRyphCommand("     /ryph ada indented ask").kind, "command");
});
