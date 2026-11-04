// Fetching an image a thread shows — the forge's half of "agents can see images". The run's
// egress is locked, so the images in an issue or a change request are downloaded HERE, where the
// egress and the credentials already are, and travel on to the control plane as bytes.
//
// Every URL this file is handed came out of text somebody typed on a forge, and on a public repo
// that is anyone. So:
//
// - only an ALLOWLISTED origin is ever dialled (GitHub's own upload hosts, by default), and a
//   redirect is followed only while it stays inside that list: a thread must not be able to point
//   this service at an internal address, a metadata endpoint, or any third-party host
// - nothing of ours rides the request: no token, no cookie. GitHub's signed image URLs carry their
//   own short-lived authorization, and an installation token sent to an image host is a token
//   leaked to whoever controls the next redirect
// - the body is read with a byte cap that bites WHILE it streams, and a declared length over it is
//   refused before a byte is read
// - the format is decided by the bytes' magic numbers, never by a content type or an extension
//
// A failure is a value (`omitted` with a reason), never a throw: one image that cannot be had
// costs only itself.

import { readCappedBytes } from "@ryph/shared/http";

/** The largest image a thread read carries: the control plane's `MAX_ATTACHMENT_BYTES`
 * (packages/orchestrator/src/core/attachments.ts), restated because this package imports
 * nothing of the orchestrator's. The control plane checks again at its own door. */
export const MAX_THREAD_IMAGE_BYTES = 5 * 1024 * 1024;

/** How many images one thread read downloads: the control plane's `MAX_ATTACHMENTS`, the most a
 * run may start with or a message may carry. */
export const MAX_THREAD_IMAGES = 10;

/** One image's download, start to last byte. */
export const IMAGE_TIMEOUT_MS = 10_000;

/** How many redirects one download follows, each inside the allowlist. */
const MAX_REDIRECTS = 3;

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * The image format these bytes ARE, by their magic numbers; null for anything else. The same four
 * signatures the control plane's `sniffImage` (packages/orchestrator/src/core/attachments.ts)
 * checks, duplicated minimally because this package may not import it: PNG's eight-byte header,
 * JPEG's SOI marker and a marker byte, GIF's two versioned headers, WebP's RIFF container.
 */
export function sniffImage(bytes: Uint8Array): ImageMime | null {
  const at = (offset: number, sig: readonly number[]) =>
    bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return "image/gif";
  }
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

/** Why a download has no bytes to show — the port's `ThreadImageOmission` minus `limit`, which
 * is the selection's to decide and never a download's. */
export type ImageFailure = "too_large" | "unsupported" | "unavailable";

export type ImageOutcome =
  | { kind: "image"; bytes: Uint8Array }
  | { kind: "omitted"; reason: ImageFailure };

/** What a capped body read is as an image: too big, not one of the four formats, or one. */
export function imageOf(read: { ok: true; bytes: Uint8Array } | { ok: false }): ImageOutcome {
  if (!read.ok) return { kind: "omitted", reason: "too_large" };
  if (read.bytes.length === 0 || sniffImage(read.bytes) === null) {
    return { kind: "omitted", reason: "unsupported" };
  }
  return { kind: "image", bytes: read.bytes };
}

/**
 * Whether `url` is on one of `origins` — scheme, host and port all equal, so
 * `https://user-images.githubusercontent.com.evil.example` and `http://` of an allowed host are
 * both refused. Credentials in the URL are refused outright: nothing legitimate carries them.
 */
export function onAllowedOrigin(url: URL, origins: readonly string[]): boolean {
  if (url.username !== "" || url.password !== "") return false;
  return origins.includes(url.origin);
}

/**
 * Download one image from an allowlisted origin: no credentials of ours, redirects followed by
 * hand and only inside the allowlist, a capped read, a sniffed format, and a deadline (`signal`
 * also aborts it, for a read's overall budget). Never throws.
 */
export async function downloadImage(
  raw: string,
  opts: { origins: readonly string[]; signal?: AbortSignal; timeoutMs?: number },
): Promise<ImageOutcome> {
  const unavailable: ImageOutcome = { kind: "omitted", reason: "unavailable" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return unavailable;
  }
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? IMAGE_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!onAllowedOrigin(url, opts.origins)) return unavailable;
      const res = await fetch(url, {
        method: "GET",
        // `manual`, so every hop is checked against the allowlist before it is dialled.
        redirect: "manual",
        // No authorization, no cookies: see the header.
        credentials: "omit",
        headers: { accept: "image/png, image/jpeg, image/gif, image/webp" },
        signal,
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (location === null) return unavailable;
        url = new URL(location, url);
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        return unavailable;
      }
      return imageOf(await readCappedBytes(res, MAX_THREAD_IMAGE_BYTES));
    }
    return unavailable;
  } catch {
    // A network death, the deadline, a body that failed mid-read: all the same to the reader.
    return unavailable;
  }
}
