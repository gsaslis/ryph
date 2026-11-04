export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Just the clock. A run's timeline is one sitting under a heading that already carries the date,
 * so repeating it on every row is noise — the time is the only part that moves.
 */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { timeStyle: "short" });
}

const dollars = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

/**
 * US dollars to the cent, always: a run's cost sits beside a month's, and the two read as the same
 * kind of number only at the same precision. Below half a cent the amount is not nothing — one
 * model call is routinely worth less than a cent — so it says so rather than rounding to "$0.00".
 */
export function formatUsd(amount: number): string {
  if (amount !== 0 && Math.abs(amount) < 0.005) return `<${dollars.format(0.01)}`;
  return dollars.format(amount);
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** A count compacted for reading at a glance: 950, 12.9K, 3.4M. */
export function formatCount(n: number): string {
  return compact.format(n);
}

/** A duration at the precision a reader can use: milliseconds under a second, seconds above. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });
/** Largest first: the first unit the gap actually fills is the one it gets named in. */
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/**
 * How long ago, in one unit: "3h ago", "2d ago", "now". A dense list row has space for the age of
 * a thing but not for its date, and next to rows that are minutes apart the age is the part being
 * compared anyway. Anything wanting the actual moment uses `formatDateTime`.
 */
export function formatRelativeTime(iso: string): string {
  const delta = new Date(iso).getTime() - Date.now();
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= ms) return relative.format(Math.round(delta / ms), unit);
  }
  return relative.format(0, "second");
}

/**
 * How long something took, in the units someone would say it in: 840ms, 58s, 4m 12s, 1h 6m. The
 * unit below the leading one is kept because that is where the difference between two runs lives;
 * anything under it is noise at this scale.
 *
 * `formatDuration` is the other half of this and stays: a tool call is measured in milliseconds
 * and would be "0s" here.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/** A ref the way a person says it: `refs/heads/fix/x` is the branch `fix/x`. A tag, a sha or a
 * bare branch name already reads as itself. */
export function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}
