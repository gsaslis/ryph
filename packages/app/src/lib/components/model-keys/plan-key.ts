import type { ChatgptPlan, ChatgptPlanStatus } from "$lib/api/types";

// How a ChatGPT plan key reads on its card: the account, the plan, and whether it works.

/** "Plus", "Pro": the plan type as OpenAI reports it, capitalised. Null when it did not say. */
export function planTypeLabel(planType: string | null): string | null {
  const t = planType?.trim() ?? "";
  if (t === "") return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** "ana@example.com · Plus", or whichever half is known, or null for neither. */
export function planAccountLine(plan: ChatgptPlan): string | null {
  const parts = [plan.email, planTypeLabel(plan.planType)].filter((p): p is string => !!p);
  return parts.length === 0 ? null : parts.join(" · ");
}

export type PlanStatusBadge = { label: string; variant: "secondary" | "destructive" | "outline" };

export function planStatusBadge(status: ChatgptPlanStatus): PlanStatusBadge {
  switch (status) {
    case "active":
      return { label: "Active", variant: "secondary" };
    case "needs_reauth":
      return { label: "Needs sign-in", variant: "destructive" };
    case "limited":
      return { label: "Usage limit reached", variant: "outline" };
  }
}

/** How often the sign-in dialog asks whether the browser came back. */
export const SIGN_IN_POLL_MS = 2000;
