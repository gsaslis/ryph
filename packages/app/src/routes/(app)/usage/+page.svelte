<script lang="ts">
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { goto } from "$app/navigation";
import { navigating } from "$app/state";
import { costLabel, isIncluded, type UsageReport, type UsageTotals } from "$lib/api/model-usage";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Card from "$lib/components/ui/card";
import * as Empty from "$lib/components/ui/empty";
import * as Table from "$lib/components/ui/table";
import * as Tabs from "$lib/components/ui/tabs";
import { formatCount, formatUsd } from "$lib/utils/format";
import ChartColumnIcon from "@lucide/svelte/icons/chart-column";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import { AWAITING_PROMPT_LABEL } from "$lib/utils/task-prompt";
import DailyCostChart from "./daily-cost-chart.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const WINDOWS = [7, 30, 90];
const DAY_MS = 24 * 60 * 60 * 1000;

const report = $derived(data.report);

// Every day of the window gets a column, spent on or not — a gap is information too.
const bars = $derived.by(() => {
  if (report === null) return [];
  const byDay = new Map(report.byDay.map((d) => [d.day, d]));
  const out: Array<{ day: string; cost: number; requests: number }> = [];
  for (let t = Date.parse(report.from); t < Date.parse(report.to); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    const spent = byDay.get(day);
    out.push({ day, cost: spent?.cost.total ?? 0, requests: spent?.requests ?? 0 });
  }
  return out;
});

const agentNames = $derived(new Map(data.agents.map((a) => [a.id, a.name])));
const keyLabels = $derived(new Map(data.providerKeys.map((k) => [k.id, k.label])));
const taskTitles = $derived(
  new Map(data.namedTasks.map((t) => [t.id, t.title ?? AWAITING_PROMPT_LABEL])),
);

const inputTokens = (t: UsageTotals) => t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite;

/** A part of the window's cost, as a share of it. */
const share = (part: UsageTotals) =>
  report === null || report.totals.cost.total === 0 || isIncluded(part)
    ? "—"
    : `${Math.round((part.cost.total / report.totals.cost.total) * 100)}%`;

/** A part of a whole, as a whole-number percentage; a whole of nothing is "—", not NaN. */
const percent = (part: number, whole: number) =>
  whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;

// Every list on the page shows its head and opens the rest on request: each is in cost order,
// so the first few rows are the answer and the tail is the long, mostly flat remainder — on a busy
// month the day table alone is ninety rows.
const SHOWN = 5;
const expanded = $state({ days: false, agents: false, models: false, tasks: false, keys: false });
type Section = keyof typeof expanded;
const head = <T>(rows: T[], section: Section) => expanded[section] ? rows : rows.slice(0, SHOWN);
// A table with fewer rows than that is padded out to the height of a full one — the header's
// `h-10` and its border, then five `h-12` rows — with a muted fill where the rows would be, so the
// four tables in the grid keep the same outline whatever the window holds. A full or opened table
// needs neither: its rows are its height.
const PADDED = "bg-muted/40 min-h-[calc(--spacing(10)_+_1px_+_5_*_--spacing(12))]";
const pad = (rows: unknown[]) => (rows.length < SHOWN ? PADDED : undefined);

// Calls a ChatGPT plan paid for read "Included", never a $0.00 that looks like a real cost.
const costCell = costLabel;
</script>

<svelte:head>
  <title>Usage · Ryph</title>
</svelte:head>

{#snippet showAll(section: Section, total: number)}
  {#if total > SHOWN}
    <Button
  variant="outline"
  size="sm"
  class="self-start"
  onclick={() => (expanded[section] = !expanded[section])}
  aria-expanded={expanded[section]}
>
      {expanded[section] ? "Show fewer" : `Show all ${total}`}
    </Button>
  {/if}
{/snippet}

<div class="flex flex-col gap-6">
  <PageTitle title="Usage">
    {#snippet description()}
      What model calls cost across every agent and the platform's own background work, as the
      model proxy metered them.
    {/snippet}
  </PageTitle>

  <!-- The window is a tab strip, as the task view's are: three names for one report, and the
       strip says which one is open. Choosing one navigates — the window is in the URL, so a
       reload and a shared link land on the same report — and the strip's value follows the URL
       back, so the browser's own back button moves the highlight too. No content panels: the
       page below IS the panel. -->
  <Tabs.Root
    value={String(data.days)}
    onValueChange={(days) => void goto(`?days=${days}`, { keepFocus: true })}
  >
    <Tabs.List aria-label="Time window">
      {#each WINDOWS as days (days)}
        <Tabs.Trigger value={String(days)}>Last {days} days</Tabs.Trigger>
      {/each}
    </Tabs.List>
  </Tabs.Root>

  <!-- Named for view transitions, but only during a same-page navigation (the attribute the
       root layout sets while one runs): when the window above changes, this is the part of the
       page that changes with it, so this is the part that moves — the title, the strip and the
       panel around them hold still (layout.css). Named all the time, it was cut out of the root
       snapshot on every navigation, and leaving the page it faded where the rest slid. The name
       is on a box around every branch, so a window with nothing in it and one with a report
       cross-fade the same way. -->
  <!-- The deployment's last line on spend, measured over ITS rolling window and not the report's:
       the strip above says seven days, and the ceiling still says thirty. A row of its own above
       the four facts, not a fifth beside them: it is a boundary on them, not one more of them, and
       a fifth column squeezed every card's text. -->
  {#snippet ceilingCard(ceiling: NonNullable<UsageReport["ceiling"]>)}
    {@const reached = ceiling.spentUsd >= ceiling.usd}
    <Card.Root
      class="@container/card from-foreground/5 to-card bg-linear-to-t shadow-xs sm:col-span-2 lg:col-span-4"
    >
      <Card.Header>
        <Card.Description class="whitespace-nowrap">Ceiling</Card.Description>
        <Card.Title class="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
          {formatUsd(ceiling.spentUsd)}
          <span class="text-muted-foreground text-base font-normal">of {formatUsd(ceiling.usd)}</span>
        </Card.Title>
        <Card.Action>
          <Badge variant={reached ? "destructive" : "outline"}>
            {reached ? "Reached" : `${percent(ceiling.spentUsd, ceiling.usd)} used`}
          </Badge>
        </Card.Action>
      </Card.Header>
      <Card.Footer class="flex-col items-start gap-1.5 text-sm">
        <div class="font-medium">
          {reached
            ? "No run may spend until the window moves on."
            : `${formatUsd(ceiling.usd - ceiling.spentUsd)} left in a ${ceiling.windowDays}-day window.`}
        </div>
        <div class="text-muted-foreground">
          The deployment's last line, set by RYPH_MODEL_SPEND_CEILING_USD over a rolling
          {ceiling.windowDays} days.
        </div>
      </Card.Footer>
    </Card.Root>
  {/snippet}

  <div class="[[data-navigation=same-page]_&]:[view-transition-name:usage-report]">
    {#if report === null}
      <Empty.Root class="border border-dashed">
        <Empty.Header>
          <Empty.Media variant="icon">
            <KeyRoundIcon />
          </Empty.Media>
          <Empty.Title>Model access is not configured</Empty.Title>
          <Empty.Description>
            This deployment runs without a master key, so no model call goes through the model proxy
            and nothing is metered.
          </Empty.Description>
        </Empty.Header>
      </Empty.Root>
    {:else if report.totals.requests === 0}
      <div class="flex flex-col gap-10">
        {#if report.ceiling}
          <!-- The ceiling stands whether or not anything was spent under it: an operator who set
               one wants to see it before the first call, not after. -->
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {@render ceilingCard(report.ceiling)}
          </div>
        {/if}
        <Empty.Root class="border border-dashed">
          <Empty.Header>
            <Empty.Media variant="icon">
              <ChartColumnIcon />
            </Empty.Media>
            <Empty.Title>No model calls in the last {data.days} days</Empty.Title>
            <Empty.Description>
              Usage shows up here as soon as an agent run or the platform calls a model.
            </Empty.Description>
          </Empty.Header>
        </Empty.Root>
      </div>
    {:else}
      {@const totals = report.totals}
      {@const allIncluded = isIncluded(totals)}
      <!-- While another window loads, the current one stays put, dimmed: no skeleton, no jump. -->
      <div
        class="flex flex-col gap-10 transition-opacity"
        class:opacity-60={navigating.to !== null}
      >
        <!-- Four facts, four equal cards, each the same shape: what it is, the number, a ratio in
             the corner, and two lines under it that say what the number is made of. The cost used
             to be a card twice the width at twice the type size, which made the other three look
             like footnotes to it; they are not — the calls and the tokens are what the cost is made
             of. No trend arrows: the report covers one window and has nothing to trend against. -->
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {#if report.ceiling}
            {@render ceilingCard(report.ceiling)}
          {/if}
          <Card.Root class="@container/card from-foreground/5 to-card bg-linear-to-t shadow-xs">
            <Card.Header>
              <Card.Description class="whitespace-nowrap">Estimated cost</Card.Description>
              <Card.Title class="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
                {allIncluded ? "Included" : formatUsd(totals.cost.total)}
              </Card.Title>
              {#if !allIncluded}
                <Card.Action>
                  <Badge variant="outline">{formatUsd(totals.cost.total / data.days)} a day</Badge>
                </Card.Action>
              {/if}
            </Card.Header>
            <Card.Footer class="flex-col items-start gap-1.5 text-sm">
              {#if allIncluded}
                <div class="line-clamp-1 font-medium">Every call was in your ChatGPT plan</div>
                <div class="text-muted-foreground">Not counted as spend</div>
              {:else}
                <div class="line-clamp-1 font-medium">
                  Output is {percent(totals.cost.output, totals.cost.total)} of it
                </div>
                <div class="text-muted-foreground">
                  Input {formatUsd(totals.cost.input)}, cache {formatUsd(
                    totals.cost.cacheRead + totals.cost.cacheWrite,
                  )}
                </div>
              {/if}
            </Card.Footer>
          </Card.Root>
          <Card.Root class="@container/card from-foreground/5 to-card bg-linear-to-t shadow-xs">
            <Card.Header>
              <Card.Description class="whitespace-nowrap">Model calls</Card.Description>
              <Card.Title class="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
                {formatCount(totals.requests)}
              </Card.Title>
              <Card.Action>
                <Badge variant="outline">
                  {totals.failedRequests > 0 ? `${totals.failedRequests} failed` : "none failed"}
                </Badge>
              </Card.Action>
            </Card.Header>
            <Card.Footer class="flex-col items-start gap-1.5 text-sm">
              <div class="line-clamp-1 font-medium">
                {formatCount(Math.round(totals.requests / data.days))} a day
              </div>
              <div class="text-muted-foreground">
                Across {report.byAgent.length}
                {report.byAgent.length === 1 ? "agent" : "agents"} and {report.byModel.length}
                {report.byModel.length === 1 ? "model" : "models"}
              </div>
            </Card.Footer>
          </Card.Root>
          <Card.Root class="@container/card from-foreground/5 to-card bg-linear-to-t shadow-xs">
            <Card.Header>
              <Card.Description class="whitespace-nowrap">Tokens in</Card.Description>
              <Card.Title class="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
                {formatCount(inputTokens(totals))}
              </Card.Title>
              <Card.Action>
                <Badge variant="outline">
                  {percent(totals.tokens.cacheRead, inputTokens(totals))} cached
                </Badge>
              </Card.Action>
            </Card.Header>
            <Card.Footer class="flex-col items-start gap-1.5 text-sm">
              <div class="line-clamp-1 font-medium">
                {formatCount(totals.tokens.cacheRead)} read from cache
              </div>
              <div class="text-muted-foreground">
                {formatCount(totals.tokens.cacheWrite)} written to it
              </div>
            </Card.Footer>
          </Card.Root>
          <Card.Root class="@container/card from-foreground/5 to-card bg-linear-to-t shadow-xs">
            <Card.Header>
              <Card.Description class="whitespace-nowrap">Tokens out</Card.Description>
              <Card.Title class="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
                {formatCount(totals.tokens.output)}
              </Card.Title>
              <Card.Action>
                <Badge variant="outline">
                  {percent(totals.tokens.reasoning, totals.tokens.output)} reasoning
                </Badge>
              </Card.Action>
            </Card.Header>
            <Card.Footer class="flex-col items-start gap-1.5 text-sm">
              <div class="line-clamp-1 font-medium">
                {formatCount(totals.tokens.reasoning)} spent thinking
              </div>
              <div class="text-muted-foreground">
                {formatCount(totals.tokens.output - totals.tokens.reasoning)} in answers and tool calls
              </div>
            </Card.Footer>
          </Card.Root>
        </div>

        <section class="flex min-w-0 flex-col gap-3">
          <div class="flex flex-col gap-1">
            <h2 class="text-base font-medium">Cost per day</h2>
            <p class="text-muted-foreground text-sm">Estimated, in US dollars. Days are UTC.</p>
          </div>
          <div class="flex flex-col gap-3">
            <DailyCostChart {bars} />
            <details class="text-sm">
              <summary class="text-muted-foreground cursor-pointer text-xs">Show as a table</summary>
              <div class="mt-2 flex flex-col gap-3">
                <Table.Root>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Day</Table.Head>
                      <Table.Head class="text-right">Calls</Table.Head>
                      <Table.Head class="text-right">Cost</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {#each head(report.byDay, "days") as day (day.day)}
                      <Table.Row class="h-12 tabular-nums">
                        <Table.Cell>{day.day}</Table.Cell>
                        <Table.Cell class="text-right">{day.requests}</Table.Cell>
                        <Table.Cell class="text-right">{costCell(day)}</Table.Cell>
                      </Table.Row>
                    {/each}
                  </Table.Body>
                </Table.Root>
                {@render showAll("days", report.byDay.length)}
              </div>
            </details>
          </div>
        </section>

        <!-- `min-w-0` on each section: a grid item's automatic minimum is its min-content width, so
           a wide table made its section wider than its column and the page scrolled sideways.
           At zero the section keeps its column and the table's own scroll box does the work. -->
      <div class="grid gap-10 lg:grid-cols-2">
          <section class="flex min-w-0 flex-col gap-3">
            <div class="flex flex-col gap-1">
              <h2 class="text-base font-medium">By agent</h2>
              <p class="text-muted-foreground text-sm">
                Every run of an agent counts towards it. The platform's own background work, such as
                memory consolidation, is listed by what it is.
              </p>
            </div>
            <Table.Root class="bg-background" containerClass={pad(report.byAgent)}>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Agent</Table.Head>
                  <Table.Head class="text-right">Calls</Table.Head>
                  <Table.Head class="text-right">Input</Table.Head>
                  <Table.Head class="text-right">Output</Table.Head>
                  <Table.Head class="text-right">Cost</Table.Head>
                  <Table.Head class="text-right">Share</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each head(report.byAgent, "agents") as row (row.agentId ?? `platform:${row.consumer}`)}
                  <Table.Row class="h-12 tabular-nums">
                    <Table.Cell>
                      {#if row.agentId !== null}
                        <a href="/agents/{row.agentId}/edit" class="underline-offset-4 hover:underline">
                          {agentNames.get(row.agentId) ?? row.agentId}
                        </a>
                      {:else if row.consumer !== null}
                        <span class="text-muted-foreground">Platform · {row.consumer}</span>
                      {:else}
                        <span class="text-muted-foreground">Unattributed</span>
                      {/if}
                    </Table.Cell>
                    <Table.Cell class="text-right">{formatCount(row.requests)}</Table.Cell>
                    <Table.Cell class="text-right">{formatCount(inputTokens(row))}</Table.Cell>
                    <Table.Cell class="text-right">{formatCount(row.tokens.output)}</Table.Cell>
                    <Table.Cell class="text-right">{costCell(row)}</Table.Cell>
                    <Table.Cell class="text-muted-foreground text-right">{share(row)}</Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
            {@render showAll("agents", report.byAgent.length)}
          </section>

          <section class="flex min-w-0 flex-col gap-3">
            <div class="flex flex-col gap-1">
              <h2 class="text-base font-medium">By model</h2>
              <p class="text-muted-foreground text-sm">
                Input counts uncached tokens only; reads from and writes to the prompt cache are
                priced apart.
              </p>
            </div>
            <Table.Root class="bg-background" containerClass={pad(report.byModel)}>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Model</Table.Head>
                  <Table.Head class="text-right">Calls</Table.Head>
                  <Table.Head class="text-right">Input</Table.Head>
                  <Table.Head class="text-right">Cache read</Table.Head>
                  <Table.Head class="text-right">Cache write</Table.Head>
                  <Table.Head class="text-right">Output</Table.Head>
                  <Table.Head class="text-right">Cost</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each head(report.byModel, "models") as row (`${row.provider}/${row.model}`)}
                  <Table.Row class="h-12 tabular-nums">
                    <!-- Two 16px lines stacked as blocks, 48px with the cell's padding: the same
                         `h-12` every other row on the page is. Inline, the first line sat in the
                         cell's 20px text-sm line box and the row ran five pixels taller than its
                         neighbour's. -->
                    <Table.Cell>
                      <div class="flex flex-col text-xs leading-4">
                        <span class="font-mono">{row.model ?? "(no model named)"}</span>
                        <span class="text-muted-foreground">{row.provider}</span>
                      </div>
                    </Table.Cell>
                    <Table.Cell class="text-right">{formatCount(row.requests)}</Table.Cell>
                    <Table.Cell class="text-right">{formatCount(row.tokens.input)}</Table.Cell>
                    <Table.Cell class="text-right">{formatCount(row.tokens.cacheRead)}</Table.Cell>
                    <Table.Cell class="text-right">{formatCount(row.tokens.cacheWrite)}</Table.Cell>
                    <Table.Cell class="text-right">{formatCount(row.tokens.output)}</Table.Cell>
                    <Table.Cell class="text-right">{costCell(row)}</Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
            {@render showAll("models", report.byModel.length)}
          </section>

          <section class="flex min-w-0 flex-col gap-3">
            <div class="flex flex-col gap-1">
              <h2 class="text-base font-medium">Most expensive tasks</h2>
              <p class="text-muted-foreground text-sm">Every run of a task counts towards it, retries included.</p>
            </div>
            <Table.Root class="bg-background" containerClass={pad(report.topTasks)}>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Task</Table.Head>
                  <Table.Head class="text-right">Calls</Table.Head>
                  <Table.Head class="text-right">Cost</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each head(report.topTasks, "tasks") as row (row.taskId)}
                  <Table.Row class="h-12 tabular-nums">
                    <Table.Cell class="max-w-72 truncate">
                      <a href="/tasks/{row.taskId}" class="underline-offset-4 hover:underline">
                        {taskTitles.get(row.taskId) ?? row.taskId}
                      </a>
                    </Table.Cell>
                    <Table.Cell class="text-right">{formatCount(row.requests)}</Table.Cell>
                    <Table.Cell class="text-right">{costCell(row)}</Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
            {@render showAll("tasks", report.topTasks.length)}
          </section>
          <section class="flex min-w-0 flex-col gap-3">
            <div class="flex flex-col gap-1">
              <h2 class="text-base font-medium">By provider key</h2>
              <p class="text-muted-foreground text-sm">Whose key the calls spent.</p>
            </div>
            <Table.Root class="bg-background" containerClass={pad(report.byProviderKey)}>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Key</Table.Head>
                  <Table.Head class="text-right">Calls</Table.Head>
                  <Table.Head class="text-right">Cost</Table.Head>
                  <Table.Head class="text-right">Share</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each head(report.byProviderKey, "keys") as row (row.providerKeyId)}
                  <Table.Row class="h-12 tabular-nums">
                    <Table.Cell>
                      {row.providerKeyId === null
                      ? "—"
                      : keyLabels.get(row.providerKeyId) ?? row.providerKeyId}
                    </Table.Cell>
                    <Table.Cell class="text-right">{formatCount(row.requests)}</Table.Cell>
                    <Table.Cell class="text-right">{costCell(row)}</Table.Cell>
                    <Table.Cell class="text-muted-foreground text-right">{share(row)}</Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
            {@render showAll("keys", report.byProviderKey.length)}
          </section>

        </div>

        <p class="text-muted-foreground text-xs">
          Tokens are what each provider reported on its responses. Costs are list-price estimates
          from Ryph's built-in price list ({report.pricing.source}), not an invoice.
          {#if totals.includedRequests > 0}
            {totals.includedRequests}
            {totals.includedRequests === 1 ? "call was" : "calls were"} included in a ChatGPT plan
            and {totals.includedRequests === 1 ? "is" : "are"} not counted as spend.
          {/if}
          {#if totals.unpricedRequests > 0}
            {totals.unpricedRequests}
            {totals.unpricedRequests === 1 ? "call was" : "calls were"} on a model the price list does
            not know: their tokens are counted, their cost is not.
          {/if}
        </p>
      </div>
    {/if}
  </div>
</div>
