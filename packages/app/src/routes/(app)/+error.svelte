<script lang="ts">
import { page } from "$app/state";
import ErrorState from "$lib/components/error-state/error-state.svelte";
import { scopeFor } from "$lib/utils/page-error";

// Inside the app shell: a page that fails keeps the nav around it, and says what it could not
// show in its section's terms.
const scope = $derived(scopeFor(page.route.id));
</script>

<ErrorState noun={scope.noun} back={scope.back} />
