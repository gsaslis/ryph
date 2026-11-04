import type { LayoutLoad } from "./$types";
import { getTasks } from "$lib/api/tasks";

// The whole section's list, not just the index page's: on a wide screen every task route shows it
// in the pane beside the page panel. `page.data.tasks` is how the app shell — which is what renders
// that pane, since a child layout can only render inside the panel — gets hold of it.
//
// ONE PAGE of it. The list is unbounded and this used to read all of it; deeper pages are the
// client's to ask for, and rows that move arrive over the stream the shell holds open.
export const load: LayoutLoad = async ({ fetch, depends }) => {
  depends("app:tasks");
  return { tasks: await getTasks(fetch) };
};
