import type { LiveFrame } from "$lib/api/browser-live";

/**
 * Draws the live frames onto a canvas.
 *
 * A frame is a base64 JPEG, up to ten a second. Each is decoded once, off the main thread
 * (`createImageBitmap`), drawn, and its bitmap closed — no object URLs to leak, and no `<img>`
 * re-decoding a data URL on every swap. At most one decode is in flight: a frame that arrives
 * while one is decoding waits, and a newer one replaces it, so a slow tab skips frames rather
 * than falling behind on them. Frames are never decoded out of order.
 */
export class FramePainter {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D | null;
  #pending: LiveFrame | null = null;
  #shown: LiveFrame | null = null;
  #busy = false;
  #disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d");
  }

  paint(frame: LiveFrame | null): void {
    if (frame === null || frame === this.#shown || this.#disposed) return;
    this.#pending = frame;
    if (!this.#busy) void this.#drain();
  }

  dispose(): void {
    this.#disposed = true;
    this.#pending = null;
  }

  async #drain(): Promise<void> {
    this.#busy = true;
    try {
      while (this.#pending !== null && !this.#disposed) {
        const frame = this.#pending;
        this.#pending = null;
        let bitmap: ImageBitmap;
        try {
          bitmap = await decodeFrame(frame);
        } catch {
          continue; // a frame that will not decode is skipped; the next one may
        }
        if (this.#disposed) {
          bitmap.close();
          break;
        }
        // Resizing a canvas clears it, so only when the picture's size changed.
        if (this.#canvas.width !== bitmap.width) this.#canvas.width = bitmap.width;
        if (this.#canvas.height !== bitmap.height) this.#canvas.height = bitmap.height;
        this.#ctx?.drawImage(bitmap, 0, 0);
        bitmap.close();
        this.#shown = frame;
      }
    } finally {
      this.#busy = false;
    }
  }
}

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeFrame(frame: LiveFrame): Promise<ImageBitmap> {
  const blob = new Blob([base64ToBytes(frame.data)], { type: frame.mime || "image/jpeg" });
  return createImageBitmap(blob);
}
