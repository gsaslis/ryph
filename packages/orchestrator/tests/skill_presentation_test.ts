// How a skill presents itself (core/skill_presentation.ts): Codex's `agents/openai.yaml` read the
// way Codex reads it, the frontmatter's metadata beside it, and icons typed by their bytes. Pure,
// so tested as cases; how a judged skill carries it is tested through `judgeSkill`.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  iconPath,
  MAX_DISPLAY_NAME_CHARS,
  MAX_ICON_BYTES,
  MAX_SHORT_DESCRIPTION_CHARS,
  MAX_SMALL_ICON_BYTES,
  presentationView,
  type SkillIcons,
  type SkillPresentation,
  skillPresentation,
  sniffSkillIcon,
} from "../src/core/skill_presentation.ts";
import { judgeSkill, type SkillTreeEntry } from "../src/core/skills.ts";

const text = (s: string) => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = text("RIFF\x10\0\0\0WEBPVP8 ");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="9"/></svg>';

type File = { path: string; bytes: Uint8Array };

function present(
  files: File[],
  metadata?: Record<string, string>,
): {
  presentation: SkillPresentation | null;
  icons: SkillIcons | null;
  warnings: Array<{ path: string; message: string }>;
} {
  const warnings: Array<{ path: string; message: string }> = [];
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : 1);
  const { presentation, icons } = skillPresentation({
    files: sorted,
    metadata,
    warn: (path, message) => warnings.push({ path, message }),
  });
  return { presentation, icons, warnings };
}

const yaml = (body: string, path = "agents/openai.yaml"): File => ({ path, bytes: text(body) });

const NONE: SkillPresentation = {
  displayName: null,
  shortDescription: null,
  brandColor: null,
  defaultPrompt: null,
  implicitInvocation: true,
  author: null,
  version: null,
};

test("presentation: a skill that sets nothing has none, and no warning", () => {
  const nothing = { presentation: null, icons: null, warnings: [] };
  assertEquals(present([]), nothing);
  assertEquals(present([yaml("")]), nothing);
  assertEquals(present([yaml("interface: {}\n")]), nothing);
});

test("presentation: every field of openai.yaml is read", () => {
  const { presentation, icons, warnings } = present([
    yaml(
      [
        "interface:",
        '  display_name: "  Release \n  Train "',
        "  short_description: Cut   a release.",
        '  brand_color: "#3b82F6"',
        "  default_prompt: |",
        "    Cut a release.",
        "    Tag it.",
        "  icon_small: ./assets/small.svg",
        "  icon_large: assets/./large.png",
        "policy:",
        "  allow_implicit_invocation: false",
      ].join("\n"),
    ),
    { path: "assets/small.svg", bytes: text(SVG) },
    { path: "assets/large.png", bytes: PNG },
  ]);
  assertEquals(warnings, []);
  assertEquals(presentation, {
    displayName: "Release Train",
    shortDescription: "Cut a release.",
    brandColor: "#3b82F6",
    defaultPrompt: "Cut a release.\nTag it.",
    implicitInvocation: false,
    author: null,
    version: null,
  });
  assertEquals(icons, {
    small: { mime: "image/svg+xml", data: text(SVG).toBase64() },
    large: { mime: "image/png", data: PNG.toBase64() },
  });
});

test("presentation: implicit invocation alone set to false is a presentation", () => {
  const { presentation } = present([yaml("policy:\n  allow_implicit_invocation: false\n")]);
  assertEquals(presentation, { ...NONE, implicitInvocation: false });
});

test("presentation: the frontmatter's metadata fills in author, version and the line", () => {
  const metadata = { "short-description": " From  metadata. ", author: "Acme", version: "1.2" };
  assertEquals(present([], metadata).presentation, {
    ...NONE,
    shortDescription: "From metadata.",
    author: "Acme",
    version: "1.2",
  });
  // openai.yaml's own line wins over the metadata's.
  const both = present([yaml("interface:\n  short_description: From yaml.\n")], metadata);
  assertEquals(both.presentation?.shortDescription, "From yaml.");
});

test("presentation: a field over its cap or of the wrong shape is left out with a warning", () => {
  const { presentation, warnings } = present([
    yaml(
      [
        "interface:",
        `  display_name: "${"n".repeat(MAX_DISPLAY_NAME_CHARS + 1)}"`,
        `  short_description: "${"d".repeat(MAX_SHORT_DESCRIPTION_CHARS + 1)}"`,
        "  brand_color: '#3B82F'",
        "  default_prompt: 7",
        "policy:",
        "  allow_implicit_invocation: 'no'",
      ].join("\n"),
    ),
  ]);
  assertEquals(presentation, null);
  assertEquals(warnings.length, 5);
  assert(warnings.every((w) => w.path === "agents/openai.yaml"));
  assertStringIncludes(warnings[0].message, "display_name");
  assert(warnings.some((w) => w.message.includes("#RRGGBB")));
  // A cap is on the collapsed text: 64 characters spread over runs of spaces still fit.
  const spaced = present([yaml(`interface:\n  display_name: "${"a   ".repeat(32)}"\n`)]);
  assertEquals(spaced.presentation?.displayName, Array(32).fill("a").join(" "));
});

test("presentation: a file that is not YAML warns and the skill still has the rest", () => {
  const { presentation, warnings } = present(
    [yaml("interface: [unclosed\n")],
    { author: "Acme" },
  );
  assertEquals(presentation, { ...NONE, author: "Acme" });
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0].message, "not valid YAML");
  assertEquals(present([yaml("- a list\n")]).warnings.length, 1);
  assertEquals(present([yaml("interface: 3\n")]).warnings.length, 1);
});

test("presentation: agents/openai.yaml is read, or openai.yml without one, its directory in any case", () => {
  const body = "interface:\n  display_name: Release\n";
  assertEquals(present([yaml(body, "agents/openai.yml")]).presentation?.displayName, "Release");
  // With both, the .yaml Codex reads wins.
  assertEquals(
    present([
      yaml("interface:\n  display_name: Other\n", "agents/openai.yml"),
      yaml(body, "agents/openai.yaml"),
    ]).presentation?.displayName,
    "Release",
  );
  assertEquals(present([yaml(body, "openai.yaml")]).presentation, null);
  assertEquals(present([yaml(body, "agents/nested/openai.yaml")]).presentation, null);
  assertEquals(present([yaml(body, "agents/OpenAI.yaml")]).presentation, null);
  const upper = present([yaml(body, "Agents/openai.yaml")]);
  assertEquals(upper.presentation?.displayName, "Release");
  // Warnings name the file as the skill holds it.
  assertEquals(
    present([yaml("x: [", "AGENTS/openai.yaml")]).warnings[0].path,
    "AGENTS/openai.yaml",
  );
});

test("presentation: icon paths resolve as Codex resolves them", () => {
  assertEquals(iconPath("./assets/x.svg"), "assets/x.svg");
  assertEquals(iconPath("assets/./icons/x.png"), "assets/icons/x.png");
  assertEquals(iconPath("assets//x.png"), "assets/x.png");
  assertEquals(iconPath("../assets/x.png"), null);
  assertEquals(iconPath("assets/../SKILL.md"), null);
  assertEquals(iconPath("/assets/x.png"), null);
  assertEquals(iconPath("C:/assets/x.png"), null);
  assertEquals(iconPath("assets\\x.png"), null);
  assertEquals(iconPath("icons/x.png"), null);
  assertEquals(iconPath("assets"), null);
  assertEquals(iconPath(""), null);
});

test("presentation: an icon path YAML escapes into something no file could be named is refused, and never repeated", async () => {
  // YAML decodes `\uD800` and `\u0000` after the UTF-8 check: neither may reach a warning, which
  // is stored in jsonb.
  assertEquals(iconPath("assets/\uD800.svg"), null);
  assertEquals(iconPath("assets/\u0000.svg"), null);
  assertEquals(iconPath("assets/a b.svg"), null);
  assertEquals(iconPath(`assets/${"a".repeat(129)}`), null);
  const judged = await judgeSkill({
    dir: "release",
    allowReserved: false,
    entries: [
      {
        path: "SKILL.md",
        type: "file",
        executable: false,
        bytes: text("---\nname: release\ndescription: Cut a release.\n---\n"),
      },
      {
        path: "agents/openai.yaml",
        type: "file",
        executable: false,
        bytes: text(
          'interface:\n  icon_small: "assets/\\uD800.svg"\n  icon_large: "assets/\\u0000"\n' +
            '  display_name: "\\u0000"\n',
        ),
      },
    ],
  });
  assert(judged.kind === "valid");
  assertEquals(judged.warnings.length, 3);
  for (const w of judged.warnings) {
    assert(w.message.isWellFormed() && !w.message.includes("\0"), w.message);
  }
  assertStringIncludes(judged.warnings[1].message, "must be a relative path under assets/");
  assertEquals(judged.skill.presentation, null);
  // A parser error quotes the line it stopped at; a NUL there is not repeated either.
  const nul = present([yaml("interface:\n  display_name: [a\0b\n")]);
  assertEquals(nul.warnings.length, 1);
  assert(!nul.warnings[0].message.includes("\0"));
});

test("presentation: an icon's type is sniffed from its bytes, never its name", () => {
  assertEquals(sniffSkillIcon(PNG), "image/png");
  assertEquals(sniffSkillIcon(JPEG), "image/jpeg");
  assertEquals(sniffSkillIcon(WEBP), "image/webp");
  assertEquals(sniffSkillIcon(text("RIFF\x10\0\0\0WAVEfmt ")), null);
  assertEquals(sniffSkillIcon(text(SVG)), "image/svg+xml");
  assertEquals(
    sniffSkillIcon(text(
      '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- drawn by hand -->\n' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n' + SVG,
    )),
    "image/svg+xml",
  );
  // An internal subset is the entity-expansion shape: refused.
  assertEquals(sniffSkillIcon(text(`<!DOCTYPE svg [<!ENTITY a "a">]>${SVG}`)), null);
  assertEquals(sniffSkillIcon(text("<html><svg></svg></html>")), null);
  assertEquals(sniffSkillIcon(text("<svgx/>")), null);
  assertEquals(sniffSkillIcon(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20, 0xff])), null);
  assertEquals(sniffSkillIcon(text("GIF89a")), null);

  // A PNG named .svg is a PNG.
  const { icons } = present([
    yaml("interface:\n  icon_small: ./assets/icon.svg\n"),
    { path: "assets/icon.svg", bytes: PNG },
  ]);
  assertEquals(icons?.small?.mime, "image/png");
});

test("presentation: an unusable icon is left out with a warning, and the other is kept alone", () => {
  const { presentation, icons, warnings } = present([
    yaml(
      [
        "interface:",
        "  icon_small: ./assets/big.png",
        "  icon_large: ./assets/large.webp",
      ].join("\n"),
    ),
    { path: "assets/big.png", bytes: new Uint8Array(MAX_SMALL_ICON_BYTES + 1).fill(0x89, 0, 1) },
    { path: "assets/large.webp", bytes: WEBP },
  ]);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0].message, "over the 16384-byte limit");
  assertEquals(presentation, null);
  // Stored once: the small one is not a copy of the large one.
  assertEquals(icons, { small: null, large: { mime: "image/webp", data: WEBP.toBase64() } });

  // The large one may be four times the small one's size, and no more.
  const sized = (n: number) => {
    const bytes = new Uint8Array(n);
    bytes.set(PNG);
    return bytes;
  };
  const big = present([
    yaml("interface:\n  icon_small: ./assets/s.png\n  icon_large: ./assets/l.png\n"),
    { path: "assets/s.png", bytes: sized(MAX_SMALL_ICON_BYTES) },
    { path: "assets/l.png", bytes: sized(MAX_ICON_BYTES) },
  ]);
  assertEquals(big.warnings, []);
  assertEquals(big.icons?.large?.data.length, sized(MAX_ICON_BYTES).toBase64().length);
  const over = present([
    yaml("interface:\n  icon_large: ./assets/l.png\n"),
    { path: "assets/l.png", bytes: sized(MAX_ICON_BYTES + 1) },
  ]);
  assertStringIncludes(over.warnings[0].message, "over the 65536-byte limit");

  for (
    const [path, files, says] of [
      ["../icon.png", [], "under assets/"],
      ["./SKILL.md", [], "under assets/"],
      ["/etc/icon.png", [], "under assets/"],
      ["./assets/missing.png", [], "does not hold"],
      ["./assets/note.svg", [{ path: "assets/note.svg", bytes: text("hello") }], "not a PNG"],
    ] as Array<[string, File[], string]>
  ) {
    const out = present([yaml(`interface:\n  icon_large: "${path}"\n`), ...files]);
    assertEquals(out.presentation, null, path);
    assertEquals(out.icons, null, path);
    assertEquals(out.warnings.length, 1, path);
    assertStringIncludes(out.warnings[0].message, says);
  }
});

test("presentation: a judged skill carries it, and a bad openai.yaml never drops the skill", async () => {
  const entries = (openai: string): SkillTreeEntry[] => [
    {
      path: "SKILL.md",
      type: "file",
      executable: false,
      bytes: text(
        "---\nname: release\ndescription: Cut a release.\nmetadata:\n  author: Acme\n---\n",
      ),
    },
    { path: "agents/openai.yaml", type: "file", executable: false, bytes: text(openai) },
    { path: "assets/icon.svg", type: "file", executable: false, bytes: text(SVG) },
  ];
  const good = await judgeSkill({
    dir: "release",
    entries: entries("interface:\n  display_name: Release\n  icon_small: ./assets/icon.svg\n"),
    allowReserved: false,
  });
  assert(good.kind === "valid");
  assertEquals(good.warnings, []);
  assertEquals(good.skill.presentation?.displayName, "Release");
  assertEquals(good.skill.presentation?.author, "Acme");
  assertEquals(good.skill.icons, {
    small: { mime: "image/svg+xml", data: text(SVG).toBase64() },
    large: null,
  });

  const bad = await judgeSkill({
    dir: "release",
    entries: entries("interface: [\n"),
    allowReserved: false,
  });
  assert(bad.kind === "valid");
  assertEquals(bad.warnings.map((w) => w.path), ["release/agents/openai.yaml"]);
  assertEquals(bad.skill.presentation, { ...NONE, author: "Acme" });
});

test("presentation: the overview carries the small icon only, a skill's page both", () => {
  const small = { mime: "image/svg+xml" as const, data: text(SVG).toBase64() };
  const large = { mime: "image/png" as const, data: PNG.toBase64() };
  const tooBigForSmall = {
    mime: "image/png" as const,
    data: new Uint8Array(MAX_SMALL_ICON_BYTES + 1).toBase64(),
  };
  const text_ = { ...NONE, displayName: "Release" };

  assertEquals(presentationView(null, null, "overview"), null);
  assertEquals(presentationView(null, null, "detail"), null);
  assertEquals(presentationView(text_, null, "detail"), {
    ...text_,
    iconSmall: null,
    iconLarge: null,
  });
  // Icons alone are a presentation, with the text's defaults.
  assertEquals(presentationView(null, { small, large: null }, "overview"), {
    ...NONE,
    iconSmall: small,
    iconLarge: null,
  });

  const both = { small, large };
  assertEquals(presentationView(text_, both, "overview")?.iconSmall, small);
  assertEquals(presentationView(text_, both, "overview")?.iconLarge, null);
  assertEquals(presentationView(text_, both, "detail")?.iconSmall, small);
  assertEquals(presentationView(text_, both, "detail")?.iconLarge, large);

  // Only one: each stands in for the other on a skill's page.
  assertEquals(presentationView(text_, { small, large: null }, "detail")?.iconLarge, small);
  assertEquals(presentationView(text_, { small: null, large }, "detail")?.iconSmall, large);
  // In the overview, a large one stands in only when it fits the small one's cap.
  assertEquals(presentationView(text_, { small: null, large }, "overview")?.iconSmall, large);
  assertEquals(
    presentationView(text_, { small: null, large: tooBigForSmall }, "overview")?.iconSmall,
    null,
  );
  assertEquals(
    presentationView(text_, { small: null, large: tooBigForSmall }, "detail")?.iconSmall,
    tooBigForSmall,
  );
});
