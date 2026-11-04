/**
 * Adopt completed reads in request order, not arrival order. Starting another read does not
 * cancel its predecessor: a slow read can still help until a newer one actually answers.
 * The caller owns the lifetime check (for example, whether this is still the current run).
 */
export function deferredResults<T>() {
  let requested = 0;
  let applied = 0;
  return (pending: Promise<T>, adopt: (value: T) => void) => {
    const sequence = ++requested;
    return pending.then((value) => {
      if (sequence <= applied) return;
      applied = sequence;
      adopt(value);
    });
  };
}
