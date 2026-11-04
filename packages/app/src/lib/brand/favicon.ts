/**
 * The favicon: the logo's mark, its R in a blob, and a different blob for every page. The same
 * drawing as the landing page's (ryph-lp, src/lib/favicon.ts and the mark in src/lib/brand/logo.ts),
 * which draws a new one for each request to /favicon.svg.
 *
 * Here it is drawn in the browser and handed to the tab as a data URI rather than served: no
 * request through the session hooks for every page, and nothing to keep from being cached.
 * `src/lib/assets/favicon.svg` is the same mark in the plain circle, for the server-rendered page
 * before this takes over (and for anyone without scripts).
 */
import { blobBounds, blobPath, randomBlob, type Wave } from "./blob";
import { CIRCLE, LETTER_R, R_MIDDLE } from "./logo";

/**
 * The logo's light colours as sRGB, the same as the static favicon's: blue into violet and orchid,
 * with a teal-to-amber glow.
 */
const SWEEP = ["#8cdffc", "#c0bfff", "#fdbde7"] as const;
const GLOW = ["#94f2eb", "#ffe2a3"] as const;

/** Space round the blob, as a fraction of the circle's diameter. */
const PADDING = 0.01;

/** The mark in a blob, as an SVG file, 32px square. */
export function faviconSvg(waves: readonly Wave[] = randomBlob()): string {
  const { cx, cy, r } = CIRCLE;
  const [l, t, rt, b] = blobBounds(waves, cx, cy, r);
  const pad = PADDING * r * 2;
  const w = rt - l + pad * 2;
  const h = b - t + pad * 2;
  // Square, with the blob in the middle.
  const side = Math.max(w, h);
  const x = l - pad - (side - w) / 2;
  const y = t - pad - (side - h) / 2;
  const round = (v: number) => Math.round(v * 10) / 10;
  const shape = `<path d="${blobPath(waves, cx, cy, r)}"`;
  // The R centred in the blob's box, not the circle's: the blob can sit off the circle's centre.
  const shift = [(l + rt) / 2 - R_MIDDLE[0], (t + b) / 2 - R_MIDDLE[1]].map(round).join(" ");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${
      [x, y, side, side].map(round).join(" ")
    }" width="32" height="32">`,
    `<title>Ryph</title>`,
    `<defs>`,
    `<linearGradient id="ryph-sweep" gradientUnits="userSpaceOnUse" x1="${cx - r}" y1="${cy}" x2="${
      cx + r
    }" y2="${cy}">`,
    `<stop offset="0" stop-color="${SWEEP[0]}"/><stop offset=".55" stop-color="${
      SWEEP[1]
    }"/><stop offset="1" stop-color="${SWEEP[2]}"/>`,
    `</linearGradient>`,
    `<radialGradient id="ryph-glow" gradientUnits="userSpaceOnUse" cx="${round(cx - 268)}" cy="${
      round(cy + 267.2)
    }" r="727">`,
    `<stop offset="0" stop-color="${GLOW[0]}" stop-opacity=".9"/><stop offset=".5" stop-color="${
      GLOW[1]
    }" stop-opacity=".35"/><stop offset="1" stop-color="${GLOW[1]}" stop-opacity="0"/>`,
    `</radialGradient>`,
    `</defs>`,
    `${shape} fill="url(#ryph-sweep)"/>`,
    `${shape} fill="url(#ryph-glow)"/>`,
    `<path d="${LETTER_R}" transform="translate(${shift})" fill="#000000"/>`,
    `</svg>`,
  ].join("");
}

/** A fresh favicon as a data URI, for a `<link rel="icon">`. */
export const faviconUri = (waves?: readonly Wave[]): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(faviconSvg(waves))}`;
