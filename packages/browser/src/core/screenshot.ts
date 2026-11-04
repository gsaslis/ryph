// How big a screenshot may be, and how one too big is brought within it. Measured against what
// reads the image after us (packages/pi-mcp/images.ts and pi):
//
// - pi re-encodes any image larger than 2000 px on a side, and Anthropic refuses 2000x2000+ images
//   in a request holding more than 20 of them: so no side over SCREENSHOT_MAX_SIDE.
// - the images extension leaves out any image over 5 MiB of base64 (3.75 MiB of bytes), and every
//   image counts against a request's 16 MiB: so at most SCREENSHOT_MAX_BYTES, well under.
//
// A region larger than that is scaled down to fit, but never below SCREENSHOT_MIN_SCALE (text at
// half size is still a layout you can judge; at a tenth it is a grey smear): past that it is also
// cropped to the top-left, and the result says so.

import { jpegSize } from "./live.ts";

export const SCREENSHOT_MAX_SIDE = 2000;
export const SCREENSHOT_MIN_SCALE = 0.5;
/** Decoded bytes; 4 MiB of base64, under the images extension's 5 MiB. */
export const SCREENSHOT_MAX_BYTES = 3 * 1024 * 1024;

/** A part of the page, in CSS px from the document's top-left. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CapturePlan {
  /** The part of the region captured: all of it unless `cropped`. */
  clip: Region;
  /** 1 when the region already fits; otherwise below 1, at least SCREENSHOT_MIN_SCALE. */
  scale: number;
  cropped: boolean;
}

/** How to capture `region` so that neither side of the image is over `maxSide`. */
export function planCapture(
  region: Region,
  maxSide = SCREENSHOT_MAX_SIDE,
  minScale = SCREENSHOT_MIN_SCALE,
): CapturePlan {
  const long = Math.max(region.width, region.height);
  if (long <= maxSide) return { clip: region, scale: 1, cropped: false };
  // Floored to three places, so the image's side (Chromium rounds up) cannot land on maxSide + 1.
  const scale = Math.max(minScale, Math.floor((maxSide / long) * 1000) / 1000);
  const fits = Math.floor(maxSide / scale);
  const width = Math.min(region.width, fits);
  const height = Math.min(region.height, fits);
  return {
    clip: { x: region.x, y: region.y, width, height },
    scale,
    cropped: width < region.width || height < region.height,
  };
}

/** A PNG's pixel size from its IHDR; null when the bytes are not one. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  return pngSize(bytes) ?? jpegSize(bytes);
}

const px = (n: number) => Math.round(n);
const percent = (scale: number) => `${Math.round(scale * 100)}%`;

/** The note a scaled or cropped screenshot carries; null when it was taken as it is. */
export function captureNote(
  what: "page" | "viewport" | "element",
  region: Region,
  plan: CapturePlan,
): string | null {
  if (plan.scale === 1 && !plan.cropped) return null;
  const size = `${px(region.width)}x${px(region.height)} px`;
  const why = `an image is at most ${SCREENSHOT_MAX_SIDE} px on a side`;
  if (!plan.cropped) {
    return `The ${what} is ${size}; it is shown at ${percent(plan.scale)} (${why}).`;
  }
  const shown = `${px(plan.clip.width)}x${px(plan.clip.height)} px`;
  return `The ${what} is ${size}; this shows its top-left ${shown} at ${
    percent(plan.scale)
  } (${why}). Scroll and take the viewport, or pass a ref, for the rest.`;
}
