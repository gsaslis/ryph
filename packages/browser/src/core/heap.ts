// When a tab's JavaScript heap is collected by hand, and what the next decision is measured
// against. Pure, so the rule is tested without a browser; the adapter (adapters/chromium.ts
// `#tidy`) does the measuring and the collecting.
//
// The rule: collect once the heap is past HEAP_TIDY_MIN AND past twice the FLOOR, what the last
// collection left. The floor is what keeps a page whose live heap is genuinely large from being
// collected on every report. Two things keep the floor honest:
// - it is per DOCUMENT: a main-frame navigation resets it, since what the last page kept alive
//   says nothing about the next one (a floor carried over from a heavy page would let the light
//   page after it pile up old documents to twice that before anything is collected);
// - a collection that did not answer in time still records one (the usage measured before it),
//   or every later report on that page would ask for a collection again and wait out the timeout
//   again.

/**
 * A tab's JavaScript heap past this (and past twice what the last collection left) is collected
 * after the report. Measured in the image (1 CPU, 1.5 GiB): a page navigated over and over
 * keeps every old document until V8 gets round to a full collection, which it puts off because
 * it sizes its heap by the machine's memory, not the container's — the heap reached 844 MiB with
 * 634 detached documents after 600 visits to a tiny page, calls slowed and stalled for 2–10 s,
 * and the ariaSnapshot behind a report timed out. Collected as it grows instead: heap 2–8 MiB, no
 * call over 0.6 s in 500 visits, each collection a few milliseconds.
 */
export const HEAP_TIDY_MIN = 64 * 1024 * 1024;

/** True when a heap of `usedSize` bytes should be collected now (see the rule above). */
export function shouldCollect(usedSize: number, floor: number, min = HEAP_TIDY_MIN): boolean {
  return usedSize >= Math.max(min, 2 * floor);
}

/**
 * The floor after a collection attempt: what it left when it answered (`after`), else what was
 * measured before it (`before`), so a page whose collection times out is not asked again on the
 * very next report.
 */
export function floorAfter(before: number, after: number | null): number {
  return after ?? before;
}
