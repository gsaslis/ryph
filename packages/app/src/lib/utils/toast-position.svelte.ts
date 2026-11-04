import { untrack } from "svelte";
import type { ToasterProps } from "svelte-sonner";

type Position = NonNullable<ToasterProps["position"]>;

// Where the root Toaster puts toasts: bottom right, unless a view on screen keeps its own controls
// there and asked for elsewhere. The latest request wins; releasing it goes back to the one before.
const requests = $state<{ id: symbol; position: Position }[]>([]);

export const toastPosition = {
  get current(): Position {
    return requests.at(-1)?.position ?? "bottom-right";
  },
};

/** Moves toasts to `position` until the returned release is called — an `$effect`'s cleanup.
 * Untracked, so an effect that asks does not depend on the list it writes and rerun forever. */
export function requestToastPosition(position: Position): () => void {
  const id = Symbol();
  untrack(() => requests.push({ id, position }));
  return () =>
    untrack(() => {
      const at = requests.findIndex((request) => request.id === id);
      if (at !== -1) requests.splice(at, 1);
    });
}
