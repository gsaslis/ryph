// What every stepped flow shares beyond the shell: which step a history entry names.

/** The id of the step to show: the one the history entry names, else the one the address asks
 * for (`?step=`, how another page links straight to a step), else the first. An id no step of
 * this flow has — a stale entry, a mistyped address — falls through the same way. */
export function stepOf<S extends { id: string }>(
  state: { step?: string },
  steps: readonly S[],
  fallback: string | null = null,
): S["id"] {
  const named = steps.find((s) => s.id === state.step) ?? steps.find((s) => s.id === fallback);
  return named?.id ?? steps[0].id;
}
