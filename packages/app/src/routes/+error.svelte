<script lang="ts">
import { page } from "$app/state";
import ErrorState from "$lib/components/error-state/error-state.svelte";
import RyphLogo from "$lib/components/ryph-logo/ryph-logo.svelte";
import { scopeFor } from "$lib/utils/page-error";

// Only what no group's boundary caught lands here: a path no route matches, or a failure in a
// layout above the groups. Neither has a shell to keep, so this draws the flows' bare frame.
const scope = $derived(scopeFor(page.route.id));
</script>

<div class="bg-muted/40 flex min-h-screen flex-col">
  <header class="px-6 py-4">
    <a href="/" aria-label="Ryph" class="inline-block"><RyphLogo class="h-8 w-auto" /></a>
  </header>
  <main class="flex flex-1 items-center justify-center px-4 pb-24">
    <ErrorState noun={scope.noun} back={scope.back} class="min-h-0" />
  </main>
</div>
