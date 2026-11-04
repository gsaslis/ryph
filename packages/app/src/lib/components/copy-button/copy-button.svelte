<script lang="ts">
import { Button } from "$lib/components/ui/button";
import CheckIcon from "@lucide/svelte/icons/check";
import CopyIcon from "@lucide/svelte/icons/copy";
import { toast } from "svelte-sonner";

let {
  value,
  label = "Copy",
  what = "Copied",
  size = "icon",
  variant = "ghost",
  disabled = false,
}: {
  /** What is copied; a function for text read only at the click, such as output still arriving. */
  value: string | (() => string);
  /** The accessible name — the button itself is an icon wherever it sits beside its subject. */
  label?: string;
  /** What the toast says was copied. */
  what?: string;
  size?: "icon" | "icon-sm" | "sm";
  variant?: "ghost" | "outline";
  /** There, but nothing to copy yet: holds its place so nothing around it moves when it is. */
  disabled?: boolean;
} = $props();

// A tick for a moment, because a clipboard write is otherwise entirely invisible.
let copied = $state(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  try {
    await navigator.clipboard.writeText(typeof value === "function" ? value() : value);
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1_500);
  } catch {
    // An insecure origin or a browser that refuses the permission: say so rather than looking
    // like nothing happened.
    toast.error("Could not copy — select the text and copy it yourself");
  }
}

$effect(() => () => clearTimeout(timer));
</script>

<Button
  type="button"
  {variant}
  {size}
  aria-label={copied ? `${what} to clipboard` : label}
  title={label}
  {disabled}
  onclick={copy}
>
  {#if copied}
    <CheckIcon />
  {:else}
    <CopyIcon />
  {/if}
  {#if size === "sm"}
    {copied ? what : label}
  {/if}
</Button>
