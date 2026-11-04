import { attachmentProblem, MAX_ATTACHMENTS, type UploadedAttachment } from "$lib/api/attachments";

// The images waiting in the message box, each uploaded the moment it is added so that pressing
// send is only the message: the ids are already the run's. A chip leaves only by being removed
// or by the message it rode being sent. Removing one mid-upload cancels the upload; removing one
// that finished, or leaving with it still in the box, takes the upload back from the run. One
// that finished on the server after its chip was gone is swept there a day later.

export type ComposerImage = {
  /** This chip's own key, minted here; the attachment id only exists once the upload answers. */
  key: string;
  name: string;
  /** An object URL of the local file, for the thumbnail: the upload's own bytes, never fetched. */
  preview: string;
  state: "uploading" | "done" | "failed";
  /** 0..1 while uploading. */
  progress: number;
  /** The attachment's id once uploaded. */
  id: string | null;
  /** Why the upload failed, in the control plane's words when it gave them. */
  error: string | null;
};

/** Sends one file to the run; reports progress as a fraction and honours the abort. */
export type Uploader = (
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) => Promise<UploadedAttachment>;

/** Takes an upload back from the run, by its attachment id. */
export type Discarder = (id: string) => Promise<void>;

export type Previews = { create: (file: File) => string; revoke: (url: string) => void };

const browserPreviews: Previews = {
  create: (file) => URL.createObjectURL(file),
  revoke: (url) => URL.revokeObjectURL(url),
};

let minted = 0;

export class ComposerImages {
  items = $state<ComposerImage[]>([]);

  /** Nothing is still on its way: what send waits for. */
  readonly settled = $derived(this.items.every((item) => item.state !== "uploading"));
  /** A failed chip holds the message until it is retried or removed: sending without it would
   * drop an image the person can still see in the box. */
  readonly ready = $derived(this.items.every((item) => item.state === "done"));
  /** The ids to send, in the order the chips show. */
  readonly ids = $derived(this.items.flatMap((item) => (item.id === null ? [] : [item.id])));

  /** The files behind the chips, in the order they show: what a box that has to send them
   * somewhere else (a task started again) uploads anew. */
  get files(): File[] {
    return this.items.flatMap((item) => {
      const held = this.#files.get(item.key);
      return held === undefined ? [] : [held.file];
    });
  }

  readonly #upload: Uploader;
  readonly #discard: Discarder | null;
  readonly #previews: Previews;
  /** Files and their aborts by chip key: kept off the reactive list, which has no use for them. */
  readonly #files = new Map<string, { file: File; abort: AbortController }>();

  constructor(
    upload: Uploader,
    discard: Discarder | null = null,
    previews: Previews = browserPreviews,
  ) {
    this.#upload = upload;
    this.#discard = discard;
    this.#previews = previews;
  }

  /**
   * Takes what it can of `files` and starts uploading each. Returns why the others were not
   * taken (not an image this accepts, too large, past the per-message cap), for a toast.
   */
  add(files: Iterable<File>): string[] {
    const refused: string[] = [];
    let overCap = 0;
    for (const file of files) {
      const problem = attachmentProblem(file);
      if (problem !== null) {
        refused.push(problem);
        continue;
      }
      if (this.items.length >= MAX_ATTACHMENTS) {
        overCap++;
        continue;
      }
      const key = `img-${++minted}`;
      this.#files.set(key, { file, abort: new AbortController() });
      this.items.push({
        key,
        name: file.name,
        preview: this.#previews.create(file),
        state: "uploading",
        progress: 0,
        id: null,
        error: null,
      });
      void this.#start(key);
    }
    if (overCap > 0) {
      refused.push(
        `A message takes at most ${MAX_ATTACHMENTS} images; ${overCap} ${
          overCap === 1 ? "was" : "were"
        } left out`,
      );
    }
    return refused;
  }

  /** Uploads a failed chip again, from the file it was added with. */
  retry(key: string) {
    const item = this.#item(key);
    const held = this.#files.get(key);
    if (item === undefined || held === undefined || item.state !== "failed") return;
    held.abort = new AbortController();
    item.state = "uploading";
    item.progress = 0;
    item.error = null;
    void this.#start(key);
  }

  remove(key: string) {
    const index = this.items.findIndex((item) => item.key === key);
    if (index === -1) return;
    this.#takeBack(this.items[index]);
    this.#forget(this.items[index]);
    this.items.splice(index, 1);
  }

  /** Empties the box: after a send, and when it goes away. */
  clear() {
    for (const item of this.items) this.#forget(item);
    this.items = [];
  }

  /** Lets go of what the box holds outside the list (uploads in flight, preview URLs) when the
   * box goes away. Leaves the list alone: nothing is left to draw it. */
  dispose() {
    for (const item of this.items) {
      this.#takeBack(item);
      this.#forget(item);
    }
  }

  /** Best-effort: an upload that is not taken back is swept by the control plane anyway. */
  #takeBack(item: ComposerImage) {
    if (item.id === null || this.#discard === null) return;
    this.#discard(item.id).catch(() => {});
  }

  #item(key: string): ComposerImage | undefined {
    return this.items.find((item) => item.key === key);
  }

  #forget(item: ComposerImage) {
    this.#files.get(item.key)?.abort.abort();
    this.#files.delete(item.key);
    this.#previews.revoke(item.preview);
  }

  async #start(key: string) {
    const held = this.#files.get(key);
    if (held === undefined) return;
    const { file, abort } = held;
    try {
      const uploaded = await this.#upload(
        file,
        (fraction) => {
          const item = this.#item(key);
          if (item !== undefined) item.progress = fraction;
        },
        abort.signal,
      );
      // Removed while it was in flight: nothing to update, and the id is simply never sent.
      const item = this.#item(key);
      if (item === undefined || abort.signal.aborted) return;
      item.id = uploaded.id;
      item.state = "done";
      item.progress = 1;
    } catch (e) {
      const item = this.#item(key);
      if (item === undefined || abort.signal.aborted) return;
      item.state = "failed";
      item.error = e instanceof Error ? e.message : "The upload failed";
    }
  }
}
