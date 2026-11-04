import { describe, expect, it } from "vitest";
import { OutputBuffer } from "./commands-view";
import { lineTone, OutputLines } from "./output-lines";

const texts = (lines: OutputLines) => lines.lines.map((l) => l.text);
const out = (text: string) => ({ text, skipped: false });

describe("OutputLines", () => {
  it("cuts chunks into lines, whatever their boundaries", () => {
    const lines = new OutputLines();
    expect(lines.append(out("one\ntw"))).toEqual({ dropped: 0, from: 0 });
    expect(lines.append(out("o\nthree\n"))).toEqual({ dropped: 0, from: 1 });
    expect(texts(lines)).toEqual(["one", "two", "three"]);
    // A final newline opens no line until something is written to it.
    expect(lines.append(out("four"))).toEqual({ dropped: 0, from: 3 });
    expect(texts(lines)).toEqual(["one", "two", "three", "four"]);
  });

  it("keeps blank lines", () => {
    const lines = new OutputLines();
    lines.append(out("a\n\n\nb\n"));
    expect(texts(lines)).toEqual(["a", "", "", "b"]);
    lines.append(out("\n"));
    expect(texts(lines)).toEqual(["a", "", "", "b", ""]);
  });

  it("puts a skipped note on a line of its own", () => {
    const lines = new OutputLines();
    lines.append(out("half a li"));
    lines.append({ text: "[2 KB of output skipped]\n", skipped: true });
    lines.append(out("ne\n"));
    expect(lines.lines).toEqual([
      { text: "half a li", ended: false, note: false },
      { text: "[2 KB of output skipped]", ended: false, note: true },
      { text: "ne", ended: true, note: false },
    ]);
  });

  it("lets go of as much as the buffer does, part of a line if need be", () => {
    const buffer = new OutputBuffer(12, 100);
    const lines = new OutputLines();
    buffer.subscribe((change) => {
      if (change.kind === "append") lines.append(change.chunk);
      else if (change.kind === "trim") lines.trim(change.count);
      else lines.reset(buffer.chunks);
    });
    buffer.append("aaa\nbb");
    buffer.append("b\ncc");
    expect(texts(lines)).toEqual(["aaa", "bbb", "cc"]);
    buffer.append("c\ndd\n");
    // The buffer dropped "aaa\nbb" (6 chars): the line it was in the middle of keeps its end.
    expect(buffer.text).toBe("b\ncc" + "c\ndd\n");
    expect(texts(lines)).toEqual(["b", "ccc", "dd"]);
  });

  it("starts over on a reset", () => {
    const lines = new OutputLines();
    lines.append(out("x\ny\n"));
    expect(lines.reset([out("z")])).toEqual({ dropped: 2, from: 0 });
    expect(texts(lines)).toEqual(["z"]);
  });
});

describe("lineTone", () => {
  it.each([
    ["error: Test failed", "error"],
    ["FAILED | 9 passed | 1 failed (9s)", "error"],
    ["answers 503 once the retries are exhausted ... FAILED (7s)", "error"],
    ["thread 'main' panicked at src/main.rs:4:5", "error"],
    ["npm ERR! code ELIFECYCLE", "error"],
    ["ok | 2 passed | 0 failed (41ms)", "success"],
    ["Tests: 12 passed, 12 total", "success"],
    ["✓ builds the app", "success"],
    ["Found 0 errors.", null],
    ["records a payment once ... ok (12ms)", null],
    ['{"lastError":"ECONNREFUSED"}', null],
    ["Task test deno test --allow-env tests/", null],
  ])("%s", (text, tone) => {
    expect(lineTone(text)).toBe(tone);
  });
});
