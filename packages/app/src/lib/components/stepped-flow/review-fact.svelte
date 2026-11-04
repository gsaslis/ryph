<script lang="ts">
// One line of a review: a term and its value, inside a `<dl class="divide-y">`.
let {
  term,
  value,
  mono = false,
}: {
  term: string;
  value: string;
  /** Set for a value that is code: a cron expression, a model id. */
  mono?: boolean;
} = $props();
</script>

<div class="flex gap-4 py-1.5 text-sm">
  <dt class="text-muted-foreground w-48 shrink-0">{term}</dt>
  <dd class={["min-w-0 truncate", mono && "font-mono text-xs leading-5"]} title={value}>
    {value}
  </dd>
</div>
