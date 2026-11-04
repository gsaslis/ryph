// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    interface Error {
      message: string;
      /**
       * The status the failure really had, when it differs from the page's: a control-plane
       * refusal reaches SvelteKit as an unexpected error and the page says 500 whatever the
       * control plane said. See `$lib/utils/page-error.ts`.
       */
      status?: number;
    }
    interface Locals {
      accessToken?: string;
      refreshToken?: string;
    }
    interface PageData {
      /**
       * A detail page's own crumb, appended after its section in the app header — the page
       * knows its title, the layout only knows the route. Omit it and the header shows the
       * section alone.
       */
      breadcrumb?: string;
    }
    /**
     * Shallow-routing state (`pushState` from `$app/navigation`), which the browser's back and
     * forward buttons walk without a navigation — a stepped flow keeps the step on screen here.
     */
    interface PageState {
      step?: string;
    }
    // interface Platform {}
  }
}

export {};
