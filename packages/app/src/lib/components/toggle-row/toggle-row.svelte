<script lang="ts">
import { Label } from "$lib/components/ui/label";
import { Switch } from "$lib/components/ui/switch";
import type { Snippet } from "svelte";

// One permission as a row: what it is, a line on what it means, and the switch that grants it.
// Rows stack inside a `divide-y rounded-lg border` list, and a granted row opens its settings
// beneath its own text — the cap, the where — so a permission and its terms read as one thing.
let {
  id,
  label,
  description,
  checked = $bindable(),
  disabled = false,
  onCheckedChange,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  /** Told of every flip, for a caller that keeps the state elsewhere than a binding. */
  onCheckedChange?: (checked: boolean) => void;
  /** The granted row's settings; rendered only while it is on. */
  children?: Snippet;
} = $props();
</script>

<div class="flex flex-col gap-4 px-4 py-3">
  <div class="flex items-center justify-between gap-6">
    <div class="flex min-w-0 flex-col gap-0.5">
      <Label for={id} class={disabled ? "opacity-60" : undefined}>{label}</Label>
      {#if description}
        <span id="{id}-description" class="text-muted-foreground line-clamp-2 text-xs" title={description}>
          {description}
        </span>
      {/if}
    </div>
    <!-- Described by its line as well as named by its label: the line is often the reason the
         switch is off, or what turning it on lets in. -->
    <Switch
      {id}
      {disabled}
      aria-describedby={description ? `${id}-description` : undefined}
      bind:checked={() => checked, (next) => {
        checked = next;
        onCheckedChange?.(next);
      }}
    />
  </div>
  {#if checked && children}
    {@render children()}
  {/if}
</div>
