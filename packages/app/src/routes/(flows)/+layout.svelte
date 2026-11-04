<script lang="ts">
import RyphLogo from "$lib/components/ryph-logo/ryph-logo.svelte";

let { children } = $props();
</script>

<div class="bg-muted/40 flex min-h-screen flex-col">
  <!-- The logo where the app's open sidebar has it: 16px in and 22px down, 28px tall (the sidebar's,
       its header's and its row's 8px paddings, less the logo's 8px nudge left; down, the same
       paddings and the 40px row centring it). The bottom padding keeps the header 64px tall. Named `ryph-logo`, as
       the app's is, so a view transition between them leaves it where it is (see layout.css). -->
  <header class="px-4 pt-5.5 pb-3.5">
    <a href="/" aria-label="Ryph"
      class="flex w-fit"><RyphLogo class="h-7 w-auto [view-transition-name:ryph-logo]" /></a>
  </header>
  <main class="flex flex-1 items-start justify-center px-4 py-12">
    <div class="w-full max-w-lg [view-transition-name:flow-content]">
      {@render children()}
    </div>
  </main>
</div>
