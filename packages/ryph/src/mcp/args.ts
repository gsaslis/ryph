// Reading a tool's arguments. A client is meant to hold them to the tool's schema, but nothing
// makes it, so every read checks the type and says which argument was wrong.

import { UsageError } from "../api/client.ts";

export { seg } from "../api/client.ts";

export type Args = Record<string, unknown>;

export function optString(args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new UsageError(`${name}: expected a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function needString(args: Args, name: string, what = "required"): string {
  const value = optString(args, name);
  if (value === undefined) throw new UsageError(`${name}: ${what}`);
  return value;
}

export function optInt(args: Args, name: string, min: number, max: number): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`${name}: a whole number from ${min} to ${max}`);
  }
  return value;
}

export function optBool(args: Args, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new UsageError(`${name}: true or false`);
  return value;
}

export function optStrings(args: Args, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new UsageError(`${name}: a list of strings`);
  }
  return value.map((v) => v.trim()).filter(Boolean);
}

export function optEnum<T extends string>(
  args: Args,
  name: string,
  values: readonly T[],
): T | undefined {
  const value = optString(args, name);
  if (value === undefined) return undefined;
  if (!(values as readonly string[]).includes(value)) {
    throw new UsageError(`${name}: one of ${values.join(", ")}`);
  }
  return value as T;
}

export function optObject(args: Args, name: string): Record<string, unknown> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${name}: a JSON object`);
  }
  return value as Record<string, unknown>;
}
