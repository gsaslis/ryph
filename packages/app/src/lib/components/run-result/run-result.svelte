<script lang="ts">
import type { RunnerResult } from "$lib/api/types";
import ExpandableText from "$lib/components/expandable-text/expandable-text.svelte";
import Markdown from "$lib/components/markdown/markdown.svelte";
import * as Alert from "$lib/components/ui/alert";
import { describeLimit } from "$lib/utils/limits";

let {
  runId,
  result,
  egressNote,
  limit,
  expanded,
  ontoggle,
}: {
  /** The run the result's images are read from; null leaves its image refs as alt text. */
  runId: string | null;
  result: RunnerResult;
  egressNote: string | null;
  /** The limit that ended the run, as its trail recorded it; null when none did. */
  limit: string | null;
  /** Whether a long summary is unfolded, held by the transcript across its windowing. */
  expanded: boolean;
  ontoggle: (expanded: boolean) => void;
} = $props();

// The line a run works on unless it names another; the result names only the others.
const DEFAULT_LINE = "work";

const failed = $derived(result.status === "failure" || result.status === "error");
</script>

<!-- How it ended, as the last thing that happened — which is what it is. The same shape
     a failure gets, because a run's outcome is one thing whichever way it went; only the
     colour and the icon change. The agent's closing message said all this a second time,
     and the row the runner marked as the one the result came from is hidden above. -->
<Alert.Root variant={failed ? "destructive" : "default"} class="min-w-0 gap-2">
  <!-- An eyebrow rather than a heading: at body size and body weight this was one more
       sentence in a callout made of sentences, and read as the first line of the summary
       rather than as the name of it. -->
  <Alert.Title
    class="text-xs font-medium tracking-wider uppercase {failed
      ? ''
      : 'text-muted-foreground'}"
  >
    {#if limit !== null}
      Stopped at a limit
    {:else if result.status === "error"}
      Failed while {result.during.replace("-", " ")}
    {:else if result.status === "failure"}
      The run did not finish
    {:else if result.status === "cancelled"}
      Cancelled
    {:else}
      Result
    {/if}
  </Alert.Title>
  <Alert.Description class={failed ? "" : "text-foreground"}>
    <!-- `wrap-anywhere` so a long URL or branch name breaks inside the card instead of
         widening it past the screen. -->
    <div class="flex min-w-0 flex-col gap-3 wrap-anywhere">
      {#if limit !== null}
        <p>The run reached its {describeLimit(limit)} and was asked to stop.</p>
      {/if}
      {#if result.status === "failure" || result.status === "error"}
        <Markdown content={result.reason} />
      {/if}
      <!-- Folded into the outcome rather than left in the event trail alone. A run that
           cannot install says only what its package manager said — "tunnel error:
           unsuccessful" — and the one fact that explains it is which host was refused,
           so it belongs beside the reason and not three sections below it. -->
      {#if egressNote}
        <Markdown content={egressNote} />
      {/if}
      {#if "summary" in result && result.summary}
        <!-- An agent's sign-off runs to whatever length it ran to, and a long one pushed
             everything under it off the screen. -->
        <ExpandableText {expanded} {ontoggle}>
          <!-- The images the agent put in it are drawn where it wrote them. -->
          <Markdown
            content={result.summary}
            images={runId === null ? undefined : { runId, refs: result.images }}
          />
        </ExpandableText>
      {/if}
      <div class="text-muted-foreground flex flex-col gap-1">
        <!-- One entry per line of work in each repo: a repo can carry several, and two repos can
             push the same branch name. -->
        {#each result.branches as branch (`${branch.path}\0${branch.line ?? DEFAULT_LINE}`)}
          <p>
            Pushed <span class="text-foreground font-mono">{branch.path}/</span>
            {#if branch.line !== undefined && branch.line !== DEFAULT_LINE}
              line <span class="text-foreground font-mono">{branch.line}</span>
            {/if}
            on <span class="text-foreground font-mono">{branch.name}</span>
            ({branch.commits.length}
            {branch.commits.length === 1 ? "commit" : "commits"})
          </p>
        {:else}
          {#if result.status === "success"}
            <p>No code changes were needed.</p>
          {/if}
        {/each}
      </div>
    </div>
  </Alert.Description>
</Alert.Root>
