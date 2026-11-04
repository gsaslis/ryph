<script lang="ts">
import ErrorState from "$lib/components/error-state/error-state.svelte";

// Its own boundary, not the app's, so the section's layout — and with it the list its load
// returned — stays: the shell draws the task pane off `page.data.tasks`, and an error caught
// above this level renders without it. A task that fails to open then fails in the panel where it
// would have appeared, with its siblings still listed beside it. Centred on the same terms as the
// "No task selected" state the index page shows there, since on xl the header is gone.
</script>

<ErrorState
  noun="task"
  back={{ href: "/tasks", label: "All tasks" }}
  class="xl:min-h-[calc(100svh-5rem)]"
/>
