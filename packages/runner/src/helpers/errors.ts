/** The message of whatever was thrown: an `Error`'s own, or the value's text for anything else
 * a `catch` can receive (a string, a rejected `undefined`). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
