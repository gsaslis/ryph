import type { Snippet } from "svelte";

/**
 * What a page puts in the sticky bar above it. The bar belongs to the app layout, which renders
 * the breadcrumb trail there; a page that wants a control beside it — a filter that should stay
 * in reach while the page scrolls — hands one over here, and takes it back when it leaves.
 *
 * A page sets it from an effect, so it is set on the client after hydration and never during a
 * server render, where module state would be shared between requests. The bar renders whatever is
 * here, so a page that navigates away must clear it: `pageHeader.controls = null` in the effect's
 * teardown.
 */
export const pageHeader = $state<{
  controls: Snippet | null;
  /**
   * The page's own title, as `PageTitle` renders it. While the trail is a single crumb the bar
   * would only say that title again, so it stays out of sight until the title scrolls up under
   * it, and comes in as it goes. Set and cleared by `PageTitle` itself, the same way.
   */
  title: HTMLElement | null;
}>({ controls: null, title: null });
