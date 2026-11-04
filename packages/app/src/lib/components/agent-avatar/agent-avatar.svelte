<script lang="ts">
import { agentAvatarUri } from "$lib/utils/avatar";
import { cn } from "$lib/utils";

let {
  agentId,
  size = "default",
  class: className,
}: {
  agentId: string;
  size?: "sm" | "default" | "lg";
  class?: string;
} = $props();
</script>

<!--
  A plain img of the face: the src is a data URI built a line ago, so there is no load to wait on
  and no failure to fall back from. Not in Avatar.Root, the sidebar's user avatar's frame: that
  crops to a circle and rings it, and this face is a blob, drawn with room for its bulges. The
  sizes are Avatar.Root's.
-->
<img
  src={agentAvatarUri(agentId)}
  alt=""
  data-size={size}
  class={cn(
    "size-8 shrink-0 select-none data-[size=lg]:size-10 data-[size=sm]:size-6",
    className,
  )}
/>
