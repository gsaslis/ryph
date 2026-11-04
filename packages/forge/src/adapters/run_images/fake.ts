// `RunImages` held in memory, for tests: the images each run's tools returned, by ref, and a
// record of every question asked — so a test can say "the forge resolved these refs against
// that run" and "fetched the bytes only for a forge that embeds".

import type { ImageResolution, ResolvedImage, RunImages } from "../../ports/run_images.ts";

export interface FakeRunImage extends ResolvedImage {
  bytes: Uint8Array;
}

export interface FakeRunImages extends RunImages {
  /** Every resolve, as asked. */
  resolved: Array<{ runId: string; refs: string[] }>;
  /** Every bytes read, as asked. */
  fetched: Array<{ runId: string; attachmentId: string }>;
  /** Makes every later call throw — the control plane unreachable. */
  fail(): void;
}

export function fakeRunImages(byRun: Record<string, FakeRunImage[]> = {}): FakeRunImages {
  const resolved: FakeRunImages["resolved"] = [];
  const fetched: FakeRunImages["fetched"] = [];
  let down = false;
  return {
    resolved,
    fetched,
    fail() {
      down = true;
    },
    resolve(runId, refs): Promise<ImageResolution> {
      resolved.push({ runId, refs: [...refs] });
      if (down) return Promise.reject(new Error("the orchestrator is unreachable"));
      const held = byRun[runId] ?? [];
      const images: ResolvedImage[] = [];
      const unknown: string[] = [];
      for (const ref of refs) {
        const hit = held.find((i) => i.ref === ref);
        if (hit === undefined) unknown.push(ref);
        else {
          images.push({
            ref: hit.ref,
            attachmentId: hit.attachmentId,
            mime: hit.mime,
            url: hit.url,
          });
        }
      }
      return Promise.resolve({ images, unknown });
    },
    bytes(runId, attachmentId) {
      fetched.push({ runId, attachmentId });
      if (down) return Promise.reject(new Error("the orchestrator is unreachable"));
      const hit = (byRun[runId] ?? []).find((i) => i.attachmentId === attachmentId);
      if (hit === undefined) return Promise.reject(new Error(`no attachment ${attachmentId}`));
      return Promise.resolve({ bytes: hit.bytes, mime: hit.mime });
    },
  };
}
