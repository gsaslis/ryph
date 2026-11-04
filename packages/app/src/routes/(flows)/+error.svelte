<script lang="ts">
import { page } from "$app/state";
import ErrorState from "$lib/components/error-state/error-state.svelte";
import { scopeFor } from "$lib/utils/page-error";

const scope = $derived(scopeFor(page.route.id));
</script>

<!-- The flow column is short and centred on its own; the shell's viewport-tall minimum would
     push the message below the fold. -->
<ErrorState noun={scope.noun} back={scope.back} class="min-h-0" />
