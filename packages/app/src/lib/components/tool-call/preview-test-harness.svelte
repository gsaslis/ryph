<script lang="ts">
import { untrack } from "svelte";
import type { ToolCall } from "$lib/api/tools";
import type { RunPreview } from "$lib/api/previews";
import ToolCallView from "./tool-call.svelte";
import { PreviewsState, setPreviewsContext } from "./previews-context.svelte";

let { call, previews, ended = false, available = true }: {
  call: ToolCall;
  previews: RunPreview[];
  ended?: boolean;
  available?: boolean;
} = $props();
const state = new PreviewsState();
setPreviewsContext(state);
untrack(() => {
  // An ended run's connection opens nothing; it only tells the state which run it is.
  state.connect("r-0123456789", () => "proof", true, "t-1");
  state.previews = previews;
  state.status = ended ? "ended" : available ? "ready" : "unavailable";
});
</script>

<ToolCallView {call} />
