import type { Attachment } from "svelte/attachments";
import type { ThumbnailState } from "./thumbnail-state.svelte";

/** A busy renderer has no queue. Give visible cards a few staggered chances, then stop. */
export const THUMBNAIL_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 35_000] as const;

/** Wait until visible before checking the session: a card may sit offscreen for hours. */
export function lazyThumbnail(
  image: ThumbnailState,
  ready: () => Promise<boolean>,
): Attachment<HTMLImageElement> {
  return (node) => {
    let active = true;
    let visible = false;
    let requesting = false;
    let finished = false;
    let retries = 0;
    let pendingDelay: number | null = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cancelTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const finish = (success: boolean) => {
      finished = true;
      cancelTimer();
      observer.disconnect();
      if (success) image.load();
      else image.fail();
    };
    const request = async () => {
      if (!active || !visible || finished || requesting) return;
      requesting = true;
      let available = false;
      try {
        available = await ready();
      } catch {
        // A failed refresh should not initiate more image requests.
      }
      requesting = false;
      if (!active || finished) return;
      if (!available) return finish(false);
      if (!visible) return;
      pendingDelay = null;
      // A distinct URL makes a new request even if the browser remembers the failed image.
      node.src = retries === 0 ? image.src : `${image.src}?retry=${retries}`;
    };
    const schedule = () => {
      if (
        !active || !visible || finished || requesting || timer !== null || pendingDelay === null
      ) return;
      if (pendingDelay === 0) {
        void request();
      } else {
        timer = setTimeout(() => {
          timer = null;
          void request();
        }, pendingDelay);
      }
    };
    const onload = () => {
      if (active && !finished) finish(true);
    };
    const onerror = () => {
      if (!active || finished || pendingDelay !== null) return;
      if (retries >= THUMBNAIL_RETRY_DELAYS_MS.length) return finish(false);
      pendingDelay = THUMBNAIL_RETRY_DELAYS_MS[retries++] * (0.8 + Math.random() * 0.4);
      schedule();
    };
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) schedule();
      else cancelTimer();
    });
    node.addEventListener("load", onload);
    node.addEventListener("error", onerror);
    observer.observe(node);
    return () => {
      active = false;
      cancelTimer();
      observer.disconnect();
      node.removeEventListener("load", onload);
      node.removeEventListener("error", onerror);
    };
  };
}
