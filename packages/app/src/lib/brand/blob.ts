/**
 * The logo's blob: a circle with a few waves running round its edge. Wave k puts k bulges on it
 * (0 swells the whole thing, 1 nudges it off centre), `size` is how far each reaches as a fraction
 * of the radius, and `phase` turns it.
 *
 * Ported from the landing page (ryph-lp, src/lib/blob.ts); keep the two in step.
 */

export interface Wave {
  k: number;
  size: number;
  phase: number;
}

/** Stretch of the edge at an angle, 1 being the circle. */
function stretchAt(waves: readonly Wave[], angle: number): number {
  let stretch = 1;
  for (const w of waves) stretch += w.size * Math.cos(w.k * angle + w.phase);
  return Math.min(Math.max(stretch, 0.62), 1.28);
}

/**
 * The blob's edge as SVG path data, around (cx, cy) with radius r: `points` points joined with
 * curves (Catmull-Rom as cubic Béziers).
 */
export function blobPath(
  waves: readonly Wave[],
  cx: number,
  cy: number,
  r: number,
  points = 48,
  decimals = 1,
): string {
  const n = points;
  const at: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    const radius = r * stretchAt(waves, angle);
    at.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  const p = (i: number) => at[(i + n) % n];
  const f = (v: number) => v.toFixed(decimals);
  let d = `M${f(at[0][0])} ${f(at[0][1])}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${
      f(p2[0] - (p3[0] - p1[0]) / 6)
    } ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}

/** The blob's bounding box, as [left, top, right, bottom]. */
export function blobBounds(
  waves: readonly Wave[],
  cx: number,
  cy: number,
  r: number,
): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 360; i++) {
    const angle = (i / 360) * Math.PI * 2;
    const radius = r * stretchAt(waves, angle);
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  }
  return box;
}

/**
 * A random blob that always looks good: clearly not a circle, but soft. Shapes are drawn at
 * random and kept only if
 * - the edge stays between 80% and 120% of the circle, so it neither pinches nor spikes;
 * - it's lopsided enough to read as a blob (at least 12% between its narrowest and widest);
 * - any dents in it are shallow, so it's a pebble or a drop, never a bean or a star.
 * Pass a seeded `random` for the same blob every time.
 */
export function randomBlob(random: () => number = Math.random): Wave[] {
  const between = (a: number, b: number) => a + random() * (b - a);
  const turn = () => random() * Math.PI * 2;
  for (let attempt = 0; attempt < 200; attempt++) {
    const waves: Wave[] = [
      { k: 1, size: between(0, 0.04), phase: turn() },
      // The two- and three-lobed waves give it its shape; the rest only soften it.
      { k: 2, size: between(0.05, 0.13), phase: turn() },
      { k: 3, size: between(0, 0.08), phase: turn() },
      { k: 4, size: between(0, 0.04), phase: turn() },
      { k: 5, size: between(0, 0.02), phase: turn() },
    ];
    if (pleasing(waves)) return waves;
  }
  return [
    { k: 2, size: 0.09, phase: turn() },
    { k: 3, size: 0.04, phase: turn() },
  ];
}

function pleasing(waves: readonly Wave[]): boolean {
  const n = 180;
  const h = (Math.PI * 2) / n;
  // The raw stretch, unclamped, and its first two derivatives round the edge.
  const r = (a: number) => waves.reduce((s, w) => s + w.size * Math.cos(w.k * a + w.phase), 1);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = i * h;
    const r0 = r(a);
    min = Math.min(min, r0);
    max = Math.max(max, r0);
    const r1 = (r(a + h) - r(a - h)) / (2 * h);
    const r2 = (r(a + h) - 2 * r0 + r(a - h)) / (h * h);
    // The sign of a polar curve's curvature: below zero the edge dents in. Allow only a little.
    if (r0 * r0 + 2 * r1 * r1 - r0 * r2 < -0.25) return false;
  }
  return min >= 0.8 && max <= 1.2 && max - min >= 0.12;
}
