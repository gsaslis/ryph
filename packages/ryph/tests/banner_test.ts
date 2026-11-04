import { test } from "bun:test";
import { assertEquals, assertMatch } from "@std/assert";
import { banner } from "../src/banner.ts";

function withLocale(locale: string, ascii: string, test: () => void): void {
  const env = { LC_ALL: locale, RYPH_ASCII: ascii, NO_COLOR: "1" };
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    test();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("banner uses conventional Ryph lettering and aligns the version", () => {
  withLocale("en_US.UTF-8", "", () => {
    const lines = banner("0.0.1").split("\n");
    const art = lines.slice(1, -2);
    assertEquals(
      art.join("\n"),
      String.raw` ____              _
|  _ \ _   _ _ __ | |__
| |_) | | | | '_ \| '_ \
|  _ <| |_| | |_) | | | |
|_| \_\\__, | .__/|_| |_|
       |___/|_|`,
    );
    assertEquals(lines.at(-2)?.trim(), "v0.0.1");
    assertEquals(lines.at(-2)?.length, Math.max(...art.map((line) => line.length)));
    assertEquals(lines[0], "");
    assertEquals(lines.at(-1), "");
  });
});

test("banner is plain ASCII in every locale, including forced ASCII mode", () => {
  let utf8 = "";
  withLocale("en_US.UTF-8", "", () => utf8 = banner("1.2.3"));
  for (const [locale, ascii] of [["en_US.UTF-8", "1"], ["C", ""]]) {
    withLocale(locale, ascii, () => {
      const text = banner("1.2.3");
      assertMatch(text, /^[\x20-\x7e\n]+$/);
      assertEquals(text, utf8);
    });
  }
});

test("a long version never asks for negative padding", () => {
  withLocale("en_US.UTF-8", "", () => {
    const version = `0.1.0-${"development-".repeat(8)}`;
    assertEquals(banner(version).split("\n").at(-2), `v${version}`);
  });
});

test("an edge build's and a source run's version print without a v", () => {
  withLocale("en_US.UTF-8", "", () => {
    assertEquals(banner("sha-0123456789ab").split("\n").at(-2)?.trim(), "sha-0123456789ab");
    assertEquals(banner("dev").split("\n").at(-2)?.trim(), "dev");
  });
});
