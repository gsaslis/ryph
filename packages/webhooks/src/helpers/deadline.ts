// A bound on a call that may never answer — the sweep's database calls (`deadlineStore`).

/** `work`, or a rejection naming `what` once `ms` have passed without an answer. The call is
 * abandoned, not cancelled: whatever it does later, nobody is waiting for it. */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
