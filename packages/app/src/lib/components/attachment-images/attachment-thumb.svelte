<script lang="ts">
import ImageOffIcon from "@lucide/svelte/icons/image-off";
import { Spinner } from "$lib/components/ui/spinner";
import { attemptUrl, ImageRetry } from "./image-retry.svelte";

// One image of a run, as a button that opens it full size. Until it has loaded, the box holds a
// spinner while the image is asked for again (a ref can be read before its upload lands); once
// that has gone on long enough, a grey placeholder that tries once more when clicked.

let { src, label, size, onopen }: {
  src: string;
  label: string;
  size: "thumbnail" | "preview";
  /** Called on a click once the image has loaded. */
  onopen: () => void;
} = $props();

const load = new ImageRetry();
$effect(() => () => load.dispose());

function click() {
  if (load.state === "loaded") onopen();
  else if (load.state === "failed") load.retry();
}
</script>

<button
  type="button"
  class={[
    "bg-muted focus-visible:ring-ring relative block overflow-hidden rounded-md border outline-none focus-visible:ring-2",
    size === "thumbnail" ? "size-20" : "h-48 max-w-full",
    size === "preview" && load.state !== "loaded" && "w-48",
  ]}
  aria-label={load.state === "failed" ? `Retry loading ${label}` : `Open ${label}`}
  aria-busy={load.state === "loading"}
  title={load.state === "failed" ? `${label} (could not load, click to retry)` : label}
  onclick={click}
>
  {#if load.state !== "failed"}
    {#key load.attempt}
      <img
        src={attemptUrl(src, load.attempt)}
        alt={label}
        loading="lazy"
        decoding="async"
        class={[
          size === "thumbnail" ? "size-full object-cover" : "h-full w-auto max-w-full object-contain",
          load.state === "loading" && "invisible absolute",
        ]}
        onload={() => load.loaded()}
        onerror={() => load.errored()}
      />
    {/key}
  {/if}
  {#if load.state === "loading"}
    <span class="text-muted-foreground absolute inset-0 flex items-center justify-center">
      <Spinner aria-label="Loading {label}" />
    </span>
  {:else if load.state === "failed"}
    <span class="text-muted-foreground/60 absolute inset-0 flex items-center justify-center">
      <ImageOffIcon class="size-6" aria-hidden="true" />
    </span>
  {/if}
</button>
