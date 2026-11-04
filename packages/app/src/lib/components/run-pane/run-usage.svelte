<script lang="ts">
import { costLabel, isIncluded, type RunUsageState } from "$lib/api/model-usage";
import * as Card from "$lib/components/ui/card";
import { Badge } from "$lib/components/ui/badge";
import { formatCount, formatElapsed, formatUsd } from "$lib/utils/format";

let {
  usage,
  terminal,
  elapsedMs,
  spendCap,
}: {
  usage: RunUsageState;
  terminal: boolean;
  /** How long the settled run took; null while it is live. */
  elapsedMs: number | null;
  /** The run's spend cap; null when uncapped. */
  spendCap: number | null;
} = $props();

/** A part of a whole, as a whole-number percentage; a whole of nothing is "—", not NaN. */
const percent = (part: number, whole: number) =>
  whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;

/** The usage page's stat card face. */
const card = "from-foreground/5 to-card bg-linear-to-t shadow-xs";

const modelLabel = (model: string | null) => model ?? "(no model named)";
</script>

<!-- The usage page's cards, drawn for one run and a narrow column: the same faces and the same
     facts, one card a fact, two abreast once the pane is wide enough to hold them. -->
<div class="@container flex flex-col gap-6 px-4 pt-4 pb-6 text-sm">
  {#if usage.unavailable}
    <p class="text-muted-foreground">
      The model proxy did not answer, so this run's usage cannot be shown right now.
    </p>
  {:else if usage.usage === null || usage.usage.totals.requests === 0}
    <p class="text-muted-foreground">
      {terminal ? "The run made no model calls." : "No model calls yet."}
    </p>
  {:else}
    {@const bill = usage.usage}
    {@const cost = bill.totals.cost}
    {@const tokens = bill.totals.tokens}
    {@const tokensIn = tokens.input + tokens.cacheRead + tokens.cacheWrite}
    {@const capped = spendCap !== null}
    {@const reached = spendCap !== null && cost.total >= spendCap}
    {@const included = isIncluded(bill.totals)}

    <div class="grid gap-3 @md:grid-cols-2">
      <Card.Root size="sm" class={[card, "@md:col-span-2"]}>
        <Card.Header>
          <Card.Description>Estimated cost</Card.Description>
          <!-- The one number a reader opens this tab for, a size above the rest. The `!`s outrank the
               small card's own title size. -->
          <Card.Title class="text-2xl! font-semibold tracking-tight tabular-nums">
            {included ? "Included" : formatUsd(cost.total)}
            {#if spendCap !== null}
              <span class="text-muted-foreground font-heading text-sm font-normal tracking-normal">
                of {formatUsd(spendCap)}
              </span>
            {/if}
          </Card.Title>
          {#if spendCap !== null}
            <Card.Action>
              <Badge variant={reached ? "destructive" : "outline"}>
                {reached ? "Cap reached" : `${percent(cost.total, spendCap)} of cap`}
              </Badge>
            </Card.Action>
          {/if}
        </Card.Header>
        <Card.Footer class="flex-col items-stretch gap-2 text-xs">
          {#if spendCap !== null}
            <!-- How much of the cap is spent. Past it the run is asked to stop. -->
            <div
              class="bg-muted h-1.5 overflow-hidden rounded-full"
              role="meter"
              aria-label="Share of the spend cap used"
              aria-valuemin={0}
              aria-valuemax={spendCap}
              aria-valuenow={cost.total}
              aria-valuetext="{formatUsd(cost.total)} of {formatUsd(spendCap)}"
            >
              <div
                class={["h-full rounded-full", reached ? "bg-destructive" : "bg-primary"]}
                style:width="{Math.min(100, spendCap === 0 ? 100 : (cost.total / spendCap) * 100)}%"
              ></div>
            </div>
          {/if}
          <div class="text-muted-foreground">
            {#if included}
              Included in your ChatGPT plan
            {:else}
              Output {formatUsd(cost.output)}, input {formatUsd(cost.input)}, cache
              {formatUsd(cost.cacheRead + cost.cacheWrite)}
            {/if}
          </div>
        </Card.Footer>
      </Card.Root>

      <Card.Root size="sm" class={card}>
        <Card.Header>
          <Card.Description>Model calls</Card.Description>
          <Card.Title class="text-lg! font-semibold tabular-nums">
            {formatCount(bill.totals.requests)}
          </Card.Title>
          <Card.Action>
            <Badge variant={bill.totals.failedRequests > 0 ? "destructive" : "outline"}>
              {bill.totals.failedRequests > 0 ? `${bill.totals.failedRequests} failed` : "None failed"}
            </Badge>
          </Card.Action>
        </Card.Header>
        {#if elapsedMs !== null && elapsedMs > 0}
          <Card.Footer class="text-muted-foreground text-xs">
            One every {formatElapsed(elapsedMs / bill.totals.requests)}
          </Card.Footer>
        {/if}
      </Card.Root>

      <Card.Root size="sm" class={card}>
        <Card.Header>
          <Card.Description>Tokens in</Card.Description>
          <Card.Title class="text-lg! font-semibold tabular-nums">{formatCount(tokensIn)}</Card.Title>
          {#if tokensIn > 0}
            <Card.Action>
              <Badge variant="outline">{percent(tokens.cacheRead, tokensIn)} cached</Badge>
            </Card.Action>
          {/if}
        </Card.Header>
        <Card.Footer class="text-muted-foreground text-xs">
          {formatCount(tokens.cacheRead)} read from cache, {formatCount(tokens.cacheWrite)} written
        </Card.Footer>
      </Card.Root>

      <Card.Root size="sm" class={card}>
        <Card.Header>
          <Card.Description>Tokens out</Card.Description>
          <Card.Title class="text-lg! font-semibold tabular-nums">
            {formatCount(tokens.output)}
          </Card.Title>
          {#if tokens.output > 0}
            <Card.Action>
              <Badge variant="outline">{percent(tokens.reasoning, tokens.output)} reasoning</Badge>
            </Card.Action>
          {/if}
        </Card.Header>
        <Card.Footer class="text-muted-foreground text-xs">
          {formatCount(tokens.output - tokens.reasoning)} in answers and tool calls
        </Card.Footer>
      </Card.Root>
    </div>

    <section class="flex flex-col gap-2">
      <h3 class="text-muted-foreground px-1 text-xs font-medium">By model</h3>
      <div class="flex flex-col gap-3">
        {#each bill.byModel as row (`${row.provider}/${row.model}`)}
          <Card.Root size="sm" class="bg-background shadow-xs">
            <Card.Header>
              <Card.Title class="truncate font-mono text-xs!">{modelLabel(row.model)}</Card.Title>
              <Card.Description class="text-xs">{row.provider}</Card.Description>
              <Card.Action class="text-sm font-medium tabular-nums">
                {costLabel(row)}
              </Card.Action>
            </Card.Header>
            <Card.Content>
              <!-- The counts two abreast, each label against its number: five columns side by side
                   wrapped their labels in a pane this narrow. -->
              <dl class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs tabular-nums">
                {#each [
                  ["Calls", formatCount(row.requests)],
                  ["Input", formatCount(row.tokens.input)],
                  ["Cache read", formatCount(row.tokens.cacheRead)],
                  ["Cache write", formatCount(row.tokens.cacheWrite)],
                  ["Output", formatCount(row.tokens.output)],
                ] as [label, value] (label)}
                  <div class="flex items-baseline justify-between gap-2">
                    <dt class="text-muted-foreground whitespace-nowrap">{label}</dt>
                    <dd>{value}</dd>
                  </div>
                {/each}
              </dl>
            </Card.Content>
          </Card.Root>
        {/each}
      </div>
    </section>

    <div class="text-muted-foreground flex flex-col gap-1 px-1 text-xs">
      <p>
        Estimated at list price, not an invoice. Tokens are what the provider reported. Input counts
        uncached tokens only; reads from and writes to the prompt cache are priced apart.
      </p>
      {#if bill.totals.failedRequests > 0}
        <p>
          {bill.totals.failedRequests} of the calls failed at the provider and reported no usage.
        </p>
      {/if}
      {#if bill.totals.includedRequests > 0}
        <p>
          {bill.totals.includedRequests}
          {bill.totals.includedRequests === 1 ? "call was" : "calls were"} included in a ChatGPT
          plan and {bill.totals.includedRequests === 1 ? "is" : "are"} not counted as spend.
        </p>
      {/if}
      {#if bill.totals.unpricedRequests > 0}
        <p>
          {bill.totals.unpricedRequests}
          {bill.totals.unpricedRequests === 1 ? "call was" : "calls were"} on a model the price
          list does not know: their tokens are counted, their cost is not.
        </p>
      {/if}
      {#if capped && spendCap !== null}
        <p>
          {reached
            ? "The run reached its cap: it was asked to stop, and the proxy refuses its calls."
            : `${formatUsd(Math.max(0, spendCap - cost.total))} left of the cap. Past it the run is asked to stop, and the proxy refuses its calls.`}
        </p>
      {/if}
    </div>
  {/if}
</div>
