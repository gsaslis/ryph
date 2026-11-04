const labels: Record<string, string> = { github: "GitHub", gitlab: "GitLab" };

/** How a provider is named to people: the brand's own casing, or the id capitalized. */
export function providerLabel(provider: string): string {
  return labels[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}
