// A refusal the REST layer answers as is, thrown from anywhere below it.

/** `body` is GitLab's envelope for the refusal: `{message}` or Grape's `{error}`. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(`${status} ${JSON.stringify(body)}`);
  }
}
