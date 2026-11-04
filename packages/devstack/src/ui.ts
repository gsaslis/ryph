/** Terminal output helpers: colors, glyphs, tables, confirmation. */

const colorsOn = process.stdout.isTTY === true && !process.env.NO_COLOR;

const paint = (code: number) => (s: string) => colorsOn ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);
export const magenta = paint(35);

export const LIVE = green("●");
export const DOWN = dim("○");
export const DEAD = red("✗");
export const NONE = dim("–");

const unitColors = [cyan, magenta, yellow, green];

/** Picks a stable color for a unit name, for log prefixes. */
export function unitColor(_name: string, index: number): (s: string) => string {
  return unitColors[index % unitColors.length];
}

/** Picks a stable color for a run id, hashed so it survives across invocations. */
export function runColor(runId: string): (s: string) => string {
  let h = 0;
  for (const c of runId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return unitColors[h % unitColors.length];
}

// oxlint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Prints rows as a left-aligned table; the first row is dimmed as the header. */
export function table(rows: string[][]): void {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length);
    });
  }
  rows.forEach((row, r) => {
    const line = row
      .map((cell, i) => cell + " ".repeat(widths[i] - stripAnsi(cell).length))
      .join("  ")
      .trimEnd();
    console.log(r === 0 ? dim(line) : line);
  });
}

/** Asks a yes/no question on the terminal; anything but y/yes declines. */
export function confirm(question: string): boolean {
  const answer = prompt(`${question} [y/N]`);
  return answer !== null && ["y", "yes"].includes(answer.trim().toLowerCase());
}
