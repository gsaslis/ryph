// The status tones the run and check badges share: a pale wash of the colour with the colour itself
// as the text. Amber is the exception in light mode — at full strength it is too light to read on
// its own wash, so it takes its dark foreground there.
export const TONES = {
  active: "bg-primary/10 text-primary dark:bg-primary/25 dark:text-primary-foreground",
  success: "bg-success/12 text-success dark:bg-success/20",
  failure: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  warning: "bg-warning/25 text-warning-foreground dark:bg-warning/20 dark:text-warning",
  neutral: "bg-muted text-muted-foreground",
} as const;
