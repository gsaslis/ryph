import { ENV_PREFIX } from "../core/brand.ts";

// The runner's private configuration: the run's contract from the bootstrap exchange, and every
// credential fetched or minted after it. Never written to process.env — a process environment is
// not secret storage, and every child would inherit it.
//
// A brand-scoped name resolves from here alone. The launch environment carries only the one-shot
// bootstrap bearer and routing, so a brand-scoped credential found there is a launch on some
// other contract, and it is not honoured. Any other name (a provider key for a hand-run work
// item, PATH) falls back to the process environment.
const credentials = new Map<string, string>();

const brandScoped = (name: string) => name.startsWith(`${ENV_PREFIX}_`);

export const runtimeCredentials = {
  get(name: string): string | undefined {
    return brandScoped(name) ? credentials.get(name) : credentials.get(name) ?? process.env[name];
  },
  set(name: string, value: string): void {
    credentials.set(name, value);
  },
  delete(name: string): void {
    credentials.delete(name);
  },
  toObject(): Record<string, string> {
    const ambient = Object.entries({ ...process.env } as Record<string, string>).filter(([name]) =>
      !brandScoped(name)
    );
    return { ...Object.fromEntries(ambient), ...Object.fromEntries(credentials) };
  },
};
