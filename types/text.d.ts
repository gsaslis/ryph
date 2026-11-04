// Shell scripts imported as text: `import script from "./sh/check.sh" with { type: "text" }`.
// Bun inlines the file's contents as a string, under `bun test`, `bun run` and `bun build
// --compile` alike, so a compiled binary carries the script and reads no file at run time.

declare module "*.sh" {
  const text: string;
  export default text;
}
