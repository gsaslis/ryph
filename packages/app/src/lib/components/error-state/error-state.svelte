<script lang="ts">
import { invalidateAll } from "$app/navigation";
import { page } from "$app/state";
import { Button } from "$lib/components/ui/button";
import * as Empty from "$lib/components/ui/empty";
import { Spinner } from "$lib/components/ui/spinner";
import { cn } from "$lib/utils";
import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
import CloudOffIcon from "@lucide/svelte/icons/cloud-off";
import LockIcon from "@lucide/svelte/icons/lock";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
import SearchXIcon from "@lucide/svelte/icons/search-x";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

let {
  noun = "page",
  back,
  class: className,
}: {
  /** What the page would have shown, as the reader knows it: "task", "trigger", "repository". */
  noun?: string;
  /** Where to go instead — the section this page belongs to, usually. `onclick` runs first. */
  back?: { href: string; label: string; onclick?: () => void };
  class?: string;
} = $props();

// The control plane's own status when a read of it is what failed: the page's is 500 for any
// error SvelteKit did not throw itself. See `$lib/utils/page-error.ts`.
const status = $derived(page.error?.status ?? page.status);
const message = $derived(page.error?.message ?? "");

type Kind = "missing" | "forbidden" | "refused" | "broken";
const kind: Kind = $derived(
  status === 404
    ? "missing"
    : status === 403
    ? "forbidden"
    : status >= 400 && status < 500
    ? "refused"
    : "broken",
);

const Icon = $derived(
  { missing: SearchXIcon, forbidden: LockIcon, refused: TriangleAlertIcon, broken: CloudOffIcon }[
    kind
  ],
);

const title = $derived(
  {
    missing: noun === "page" ? "Page not found" : `${capitalise(noun)} not found`,
    forbidden: `You can't open this ${noun}`,
    refused: `Couldn't open this ${noun}`,
    broken: `Couldn't load this ${noun}`,
  }[kind],
);

const description = $derived(
  {
    missing: noun === "page"
      ? "Nothing lives at this address. Check the link for typos."
      : `There's no ${noun} with this ID. It may have been deleted, or the link is wrong.`,
    forbidden: `Your account doesn't have access to this ${noun}. An admin can grant it.`,
    // A 400 and its kin are the control plane objecting to the request itself, and its own words
    // are the only useful explanation there is.
    refused: sentence(message),
    broken: "Something failed on the way. It's usually temporary, so try again in a moment.",
  }[kind],
);

// What the server said, for someone reporting the problem — only where the words above did not
// already carry it, and never SvelteKit's placeholder, which says nothing.
const detail = $derived(
  kind === "broken" && message && message !== "Internal Error" ? message : null,
);

let retrying = $state(false);

async function retry() {
  retrying = true;
  try {
    await invalidateAll();
  } finally {
    retrying = false;
  }
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sentence(s: string) {
  const text = capitalise(s.trim());
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
</script>

<Empty.Root class={cn("min-h-[calc(100svh-12rem)]", className)}>
  <Empty.Header>
    <Empty.Media variant="icon">
      <Icon />
    </Empty.Media>
    <Empty.Title>{title}</Empty.Title>
    <Empty.Description>{description}</Empty.Description>
  </Empty.Header>
  {#if back || kind === "broken"}
    <Empty.Content>
      <div class="flex flex-wrap justify-center gap-2">
        {#if kind === "broken"}
          <Button onclick={retry} disabled={retrying}>
            {#if retrying}
              <Spinner data-icon="inline-start" />
            {:else}
              <RotateCwIcon data-icon="inline-start" />
            {/if}
            Try again
          </Button>
        {/if}
        {#if back}
          <Button
            href={back.href}
            variant={kind === "broken" ? "outline" : "default"}
            onclick={back.onclick}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            {back.label}
          </Button>
        {/if}
      </div>
    </Empty.Content>
  {/if}
  {#if detail}
    <p class="text-muted-foreground max-w-sm text-xs">
      Error {status}: {detail}
    </p>
  {/if}
</Empty.Root>
