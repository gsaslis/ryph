<script lang="ts">
import "./layout.css";
import "./h4x0r.css";
// The brand's faces, all three open (SIL OFL): Inter for text, Host Grotesk for headings and
// JetBrains Mono for code. Vite bundles their woff2 files like any other asset.
import "@fontsource-variable/inter";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource-variable/host-grotesk";
import "@fontsource-variable/jetbrains-mono";
import staticFavicon from "$lib/assets/favicon.svg";
import { faviconUri } from "$lib/brand/favicon";
import { afterNavigate, onNavigate } from "$app/navigation";
import { NavProgress } from "$lib/components/nav-progress";
import { Toaster } from "$lib/components/ui/sonner";
import { ModeWatcher } from "mode-watcher";
import { trackViewTransition, viewTransitionsEnabled } from "$lib/utils/view-transition";
import { noteSessionExpiry } from "$lib/utils/auth/auth";
import { toastPosition } from "$lib/utils/toast-position.svelte";

let { children, data } = $props();

// A different blob in the tab on every page, as on the landing page ($lib/brand/favicon). The
// server renders the plain mark, so hydration agrees; once the page is up, and on every move after,
// the browser draws a new one.
let favicon = $state(staticFavicon);
afterNavigate(() => {
  favicon = faviconUri();
});

// The session clock artifact frames are placed by (`ensureFreshSession`), set each time the server
// says how long the access token lasts.
$effect.pre(() => noteSessionExpiry(data.sessionExpiresIn));

// Cross-fade between pages via the View Transitions API (no-op in
// browsers that don't support it). Elements with a view-transition-name
// (sidebar, tasks pane) are isolated and stay put.
//
// What kind of move this is decides what moves (`data-navigation` on
// <html> for the transition's duration; see layout.css and the app layout):
// - the same path with another query — a page re-asking for itself with
//   another window, filter or cursor — is not a change of page, and the
//   page container, its title and its controls sliding away and back read
//   as one. The root animation is switched off and only what the page has
//   named for itself moves: the usage report, for one.
// - a path within the same section (the first segment unchanged: deeper
//   into it, back up, or across to a sibling) keeps the panel's top edge
//   and the breadcrumb bar still, and flies only the crumb that changed
//   along with the page.
// - a different section is a different page, and all of it moves.
onNavigate((navigation) => {
  if (!viewTransitionsEnabled()) return;

  const from = navigation.from?.url.pathname ?? "";
  const to = navigation.to?.url.pathname ?? "";
  const section = (path: string) => path.split("/")[1] ?? "";
  const kind = from === to ? "same-page" : section(from) === section(to) ? "within-section" : null;
  if (kind !== null) document.documentElement.dataset.navigation = kind;

  return new Promise((resolve) => {
    const transition = document.startViewTransition(async () => {
      resolve();
      await navigation.complete;
    });
    trackViewTransition(transition);
    void transition.finished.finally(() => {
      delete document.documentElement.dataset.navigation;
    });
  });
});
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>
<ModeWatcher />
<NavProgress />
<Toaster richColors position={toastPosition.current} />
{@render children()}
