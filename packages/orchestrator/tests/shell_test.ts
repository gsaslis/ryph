import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import { shellBody } from "../src/helpers/shell.ts";

test("shellBody drops comment and blank lines but keeps a shebang and trailing comments", () => {
  const script = ["#!/bin/sh", "# a comment", "", "  # indented", "echo hi # stays", "exit 0"];
  assertEquals(shellBody(script.join("\n")), "#!/bin/sh\necho hi # stays\nexit 0");
});

test("shellBody keeps a heredoc's body verbatim, comment and blank lines too", () => {
  const script = [
    "cat > f <<TOML",
    "# a TOML comment",
    "",
    "[dns]",
    "TOML",
    "# gone",
    "cat <<-'EOF'",
    "\t# tab-indented",
    "\tEOF",
    'read -r x <<<"$y"',
    "# gone too",
  ];
  assertEquals(
    shellBody(script.join("\n")),
    [
      "cat > f <<TOML",
      "# a TOML comment",
      "",
      "[dns]",
      "TOML",
      "cat <<-'EOF'",
      "\t# tab-indented",
      "\tEOF",
      'read -r x <<<"$y"',
    ].join("\n"),
  );
});

test("shellBody refuses a heredoc that is never closed", () => {
  assertThrows(() => shellBody("cat <<EOF\n# body\n"), Error, "never closed");
});
