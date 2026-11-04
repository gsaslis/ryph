<script lang="ts">
import { Badge } from "$lib/components/ui/badge";
import * as InputGroup from "$lib/components/ui/input-group";
import XIcon from "@lucide/svelte/icons/x";

// A list of short names, typed one at a time: each becomes a chip on Enter or a comma, and
// Backspace on an empty field takes the last one back. What is typed and not yet entered is
// still taken on blur, so a name is never lost to leaving the field. Pasting a comma-separated
// list drops in as chips. The chips are the value; the field holds only what is being typed.
let {
  tags = $bindable(),
  id,
  placeholder,
  disabled = false,
  "aria-invalid": invalid,
}: {
  tags: string[];
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  "aria-invalid"?: boolean;
} = $props();

let draft = $state("");
let input = $state<HTMLInputElement | null>(null);

function add(raw: string) {
  const names = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (names.length === 0) return;
  const seen = new Set(tags.map((t) => t.toLowerCase()));
  const fresh = names.filter((n) => {
    if (seen.has(n.toLowerCase())) return false;
    seen.add(n.toLowerCase());
    return true;
  });
  if (fresh.length > 0) tags = [...tags, ...fresh];
  draft = "";
}

function remove(tag: string) {
  tags = tags.filter((t) => t !== tag);
}

function onkeydown(event: KeyboardEvent) {
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    add(draft);
  } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
    event.preventDefault();
    tags = tags.slice(0, -1);
  }
}
</script>

<!-- The group is the field: clicking anywhere in it focuses the input, and the chips wrap
     ahead of it. -->
<InputGroup.Root
  class="h-auto min-h-9 flex-wrap gap-1.5 py-1.5 pl-2"
  data-disabled={disabled}
  onclick={() => input?.focus()}
>
  {#each tags as tag (tag)}
    <Badge variant="secondary" class="gap-1 pr-1 font-normal">
      {tag}
      <button
        type="button"
        class="hover:bg-foreground/10 focus-visible:ring-ring/50 -my-0.5 flex size-4 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2 disabled:pointer-events-none"
        aria-label="Remove {tag}"
        {disabled}
        onclick={(event) => {
          event.stopPropagation();
          remove(tag);
        }}
      >
        <XIcon class="size-3" />
      </button>
    </Badge>
  {/each}
  <InputGroup.Input
    bind:ref={input}
    {id}
    {disabled}
    aria-invalid={invalid}
    bind:value={draft}
    placeholder={tags.length === 0 ? placeholder : undefined}
    class="h-6 min-w-32 flex-1 px-1"
    {onkeydown}
    onblur={() => add(draft)}
    onpaste={(event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text") ?? "";
      if (!text.includes(",")) return;
      event.preventDefault();
      add(text);
    }}
  />
</InputGroup.Root>
