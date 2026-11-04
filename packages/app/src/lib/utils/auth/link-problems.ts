// Why a single-user login link signed nobody in: the login-link action names one in
// `/login?link=`, and the login page reads it back and says what to do. Single-user, the way in
// is the link printed at boot; `ryph login` mints a fresh one only from the binary (`ryph up`),
// and a restart prints one too.
export const LINK_PROBLEMS = {
  expired:
    "That sign-in link has expired or was already used. Run ryph login or restart ryph for a new one.",
  failed: "That sign-in link did not work. Try again.",
  "multi-user": "Sign-in links only work while you're the only user. Sign in with your password.",
} as const;

export type LinkProblem = keyof typeof LINK_PROBLEMS;

/** The problem a `?link=` value names, or null for anything else. */
export function linkProblemOf(value: string | null): LinkProblem | null {
  return value !== null && Object.hasOwn(LINK_PROBLEMS, value) ? value as LinkProblem : null;
}
