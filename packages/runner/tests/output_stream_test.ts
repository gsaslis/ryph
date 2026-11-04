// A job's output stream, cleaned as it streams: escapes read by their grammar and removed whole,
// control and bidi characters out, carriage returns as redraws, partial escapes carried and
// never surfacing as text — every scan linear, every carry bounded.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { OutputStream, shownText } from "../src/core/output_stream.ts";
import { OutputRing } from "../src/core/background.ts";

/**
 * That `work(n)` costs its length: four times the input takes well under eight times as long
 * (linear is ~4×, quadratic ~16×). A ratio, not a budget in ms, so a slow or shared machine (a
 * check pod under gVisor) passes as a fast one does; each size is timed best of three, once warm.
 */
function assertLinear(what: string, work: (n: number) => void, n: number) {
  const best = (size: number) => {
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      work(size);
      ms = Math.min(ms, performance.now() - t0);
    }
    return ms;
  };
  best(n);
  const small = best(n);
  const large = best(4 * n);
  assert(
    large < 8 * small + 5,
    `${what}: ${small.toFixed(1)} ms at n, ${large.toFixed(1)} ms at 4n`,
  );
}

/** Everything a stream shows for these pushes, the release between them where asked. */
function through(pieces: Array<string | "release">): string {
  const stream = new OutputStream();
  let shown = "";
  for (const piece of pieces) shown += piece === "release" ? stream.release() : stream.push(piece);
  return shown + stream.end();
}

test("output stream: control, C1 and bidi characters go, text around them joins", () => {
  for (const c of ["\x00", "\x07", "\x85", "‎", "‮", "⁦", "؜", "\x7f"]) {
    assertEquals(through([`ab${c}cd\n`]), "abcd\n", JSON.stringify(c));
  }
});

test("output stream: a redraw stays a redraw, `\\r\\n` is a break, a `\\r` opening a line goes", () => {
  assertEquals(through(["\x1b[32mok\x1b[0m 10%\r\r50%\r\n\rdone\r\n"]), "ok 10%\r50%\ndone\n");
  // A `\r\n` split across pushes is one break.
  assertEquals(through(["a\r", "\nb\n", "\rc"]), "a\nb\nc");
  assertEquals(through(["\x1b]0;title\x07x\x00y\x1b"]), "xy");
  // A release lets go a trailing `\r` as the redraw it is.
  const stream = new OutputStream();
  assertEquals(stream.push("line\r"), "line");
  assertEquals(stream.release(), "\r");
  assertEquals(stream.release(), "");
});

test("output stream: a run of returns costs its length, and only one is carried", () => {
  assertLinear("returns", (n) => new OutputStream().push("\r".repeat(n) + "x"), 1 << 14);
  const stream = new OutputStream();
  assertEquals(stream.push("abc" + "\r".repeat(1 << 20) + "x"), "abc\rx");
  stream.push("\r".repeat(1 << 20));
  assert(stream.held <= 257, `${stream.held} held`);
});

test("output stream: escapes are read by their grammar", () => {
  const clean = (...pieces: string[]) => through(pieces);
  // CSI, with parameters and intermediates, and its C1 form.
  assertEquals(clean("a\x1b[1;31mb\x1b[?25lc\x1b[1 qd\x9b2Je"), "abcde");
  // Control strings — OSC by BEL or ST, DCS, SOS, PM, APC, and their C1 forms — go whole.
  assertEquals(clean("a\x1b]0;title\x07b\x1b]8;;http://x\x1b\\c\x1bPq#1\x1b\\d"), "abcd");
  assertEquals(
    clean("a\x1bXsos\x1b\\b\x1b^pm\x9cc\x1b_apc\x07d\x9dosc\x07e\x90dcs\x9cf"),
    "abcdef",
  );
  // nF, Fp, Fe and Fs forms.
  assertEquals(clean("a\x1b(Bb\x1b%Gc\x1b#8d\x1b7e\x1bMf\x1bcg"), "abcdefg");
  // An ESC that starts none of them goes alone, and what follows it is text.
  assertEquals(clean("FAILED\x1b\x01: 3 tests\x1bé\n"), "FAILED: 3 testsé\n");
  // An unterminated string held across pushes: its body never shows.
  assertEquals(through(["x \x1b]0;t", "itle\x07y\n"]), "x y\n");
  // A string body past its bound is no string: its introducer goes, the rest is text.
  assertEquals(clean("a\x1b]" + "z".repeat(5_000) + "b"), "a" + "z".repeat(5_000) + "b");
  // A stray ESC at the very end of the output is nothing.
  assertEquals(clean("tail\x1b"), "tail");
});

test("output stream: an escape a pause interrupts never surfaces its rest", () => {
  const csi = new OutputStream();
  let shown = csi.push("x \x1b[");
  shown += csi.release();
  shown += csi.push("1my\n");
  assertEquals(shown + csi.end(), "x y\n");
  const osc = new OutputStream();
  shown = osc.push("x \x1b]0;ti");
  shown += osc.release();
  shown += osc.push("tle\x07y\n");
  assertEquals(shown + osc.end(), "x y\n");
});

test("output stream: a flood of escape introducers costs its length, and what is held stays bounded", () => {
  for (
    const unit of [
      "\u009d",
      "\x1b]",
      "\x1bP",
      "\u0090",
      "\x1b[",
      "\u009b",
      "\x1b",
      "\x1b(",
      "\x1b]0;\x1b",
    ]
  ) {
    // An introducer costs what a plain character does, not a scan of the string bound after it:
    // the flood is timed against plain text of its length, which a slow machine slows alike.
    const n = 1 << 16;
    const flood = unit.repeat(Math.ceil(n / unit.length));
    const plain = "a".repeat(flood.length);
    const cost = (text: string) => {
      let ms = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        new OutputStream().push(text);
        ms = Math.min(ms, performance.now() - t0);
      }
      return ms;
    };
    cost(plain);
    const [asText, asFlood] = [cost(plain), cost(flood)];
    assert(
      asFlood < 20 * asText + 5,
      `${JSON.stringify(unit)}: ${asFlood.toFixed(1)} ms, ${asText.toFixed(1)} ms as plain text`,
    );
    const stream = new OutputStream();
    stream.push(flood);
    stream.push(flood);
    assert(stream.held <= 4_200, `${JSON.stringify(unit)}: ${stream.held} held`);
  }
});

test("output stream: a control string past its bound is read as text, not held", () => {
  const stream = new OutputStream();
  const shown = stream.push("a\x1b]" + "z".repeat(5_000));
  assertEquals(shown, "a" + "z".repeat(5_000));
  assert(stream.held <= 4_200, `${stream.held} held`);
});

test("output ring: a redraw replaces only its line, and a flood of them costs their length", () => {
  const ring = new OutputRing();
  ring.append(("y".repeat(119) + "\n").repeat(2_000));
  for (let i = 0; i < 100_000; i++) ring.append(`\ra${i}`);
  ring.append("\r" + "\ra".repeat(2 << 20));
  assert(ring.text.endsWith("y\na"), JSON.stringify(ring.text.slice(-4)));
  // A redraw costs its line, not the ring: the same redraws take about as long in a nearly full
  // ring as in an empty one, where costing the ring would be ~2000× slower. Compared with each
  // other, not with a budget in ms, so a slow or shared machine passes as a fast one does.
  const redraws = (fill: number) => {
    let ms = Infinity;
    for (let round = 0; round < 3; round++) {
      const ring = new OutputRing();
      ring.append(("y".repeat(119) + "\n").repeat(fill));
      const t0 = performance.now();
      for (let i = 0; i < 20_000; i++) ring.append(`\ra${i}`);
      ms = Math.min(ms, performance.now() - t0);
    }
    return ms;
  };
  redraws(0);
  const empty = redraws(0);
  const nearlyFull = redraws(2_000);
  assert(
    nearlyFull < 4 * empty + 10,
    `${empty.toFixed(1)} ms on an empty ring, ${nearlyFull.toFixed(1)} ms on a nearly full one`,
  );
  // A released `\r` followed by its `\n` keeps the line it ended.
  const stream = new OutputStream();
  const kept = new OutputRing();
  kept.append(stream.push("abc\r"));
  kept.append(stream.release());
  kept.append(stream.push("\nnext"));
  assertEquals(kept.text, "abc\nnext");
});

test("shown text: a label, a command or a cwd is cleaned", () => {
  assertEquals(shownText(`a\x1b[1m‮b\x85c\r\nd`), "abc\nd");
});
