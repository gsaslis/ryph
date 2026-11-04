// How a skill presents itself on the skills page: a display name, a line about it, a colour and
// an icon. The one convention in use is OpenAI Codex's `agents/openai.yaml`, read here the way
// Codex reads it, with the SKILL.md frontmatter's `metadata` filling in what it leaves out:
//
//   interface:
//     display_name: "Release"               # whitespace collapsed; over 64 characters, left out
//     short_description: "Cut a release."   # over 1024 characters, left out
//     icon_small: "./assets/small.svg"      # a file under assets/ in the skill, at most 16 KiB
//     icon_large: "./assets/large.png"      # at most 64 KiB
//     brand_color: "#3B82F6"                # exactly #RRGGBB
//     default_prompt: "Cut a release of …"  # over 1024 characters, left out
//   policy:
//     allow_implicit_invocation: true       # true unless set to false
//
// Invariants:
// - presentation never decides whether a skill is valid: a missing file means none, and a file
//   or a field that does not fit is left out with a warning while the skill stays
// - `agents/openai.yaml` is read, as Codex reads it, and `agents/openai.yml` too when there is no
//   `.yaml`: Codex reads only the first, but skills in the wild ship the second (shadcn-svelte's,
//   for one), and a skill's own page should not lose its name and icon over a file extension. The
//   `agents` directory is matched in any case, as Codex matches it
// - an icon's type is decided by its bytes and never by its name, so a page that renders it as
//   an image renders what the bytes are
// - every string kept fits jsonb: the text is stored in `skill_sync_entries.presentation`, the
//   icons once per digest in `skill_bundles.icons`, and every warning lands in
//   `skill_syncs.warnings`, so a warning never repeats a value from the file that was not first
//   held to a grammar jsonb can store
// - icons live apart from the text, never one copied into the other's place: a run start reads
//   the entries and never an icon, and the overview carries only small ones
// - pure: no I/O, no clock, no port

import { parseSkillYaml } from "../helpers/skill_file.ts";
import { isMapping } from "../helpers/services.ts";
import { pathRefusal } from "./skills.ts";
import { sniffImage } from "./attachments.ts";

export const MAX_DISPLAY_NAME_CHARS = 64;
export const MAX_SHORT_DESCRIPTION_CHARS = 1024;
export const MAX_DEFAULT_PROMPT_CHARS = 1024;
/** Characters of `metadata.author` or `metadata.version` kept, after collapsing whitespace. */
export const MAX_ATTRIBUTION_CHARS = 128;
/** Bytes of `icon_large`. Only a skill's own page carries it. */
export const MAX_ICON_BYTES = 64 * 1024;
/** Bytes of `icon_small`, the one the skills overview carries, base64, for every skill. */
export const MAX_SMALL_ICON_BYTES = 16 * 1024;
/** Bytes of `agents/openai.yaml` itself: a few short fields, never a document. */
export const MAX_PRESENTATION_FILE_BYTES = 16 * 1024;
export const BRAND_COLOR = /^#[0-9A-Fa-f]{6}$/;

export type SkillIconMime = "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";

export interface SkillIcon {
  /** Sniffed from the bytes. */
  mime: SkillIconMime;
  /** The file's bytes, base64. */
  data: string;
}

/** What a skill says about how it is shown, in text. Null fields are not set; none of it is
 * enforced. */
export interface SkillPresentation {
  displayName: string | null;
  shortDescription: string | null;
  /** `#RRGGBB`, as written. */
  brandColor: string | null;
  defaultPrompt: string | null;
  /** Codex's `policy.allow_implicit_invocation`. Shown, not enforced: every listed skill is
   * listed to the model. */
  implicitInvocation: boolean;
  author: string | null;
  version: string | null;
}

/** A skill's icons as its files hold them, each null when not usable. Stored once per digest,
 * and neither stands in for the other until a route answers. */
export interface SkillIcons {
  small: SkillIcon | null;
  large: SkillIcon | null;
}

/** The presentation as the API answers it: the text with the icons beside it. */
export interface SkillPresentationView extends SkillPresentation {
  iconSmall: SkillIcon | null;
  iconLarge: SkillIcon | null;
}

/**
 * The presentation a route answers with, or null when the skill sets nothing at all. An
 * `overview` carries only the small icon, the large one standing in only when it fits the small
 * one's cap, so a page of every skill stays small; a `detail` carries both, each standing in for
 * the other.
 */
export function presentationView(
  presentation: SkillPresentation | null,
  icons: SkillIcons | null,
  shape: "overview" | "detail",
): SkillPresentationView | null {
  const small = icons?.small ?? null;
  const large = icons?.large ?? null;
  if (presentation === null && small === null && large === null) return null;
  const largeFitsSmall = large !== null && base64Bytes(large.data) <= MAX_SMALL_ICON_BYTES;
  return {
    ...(presentation ?? NO_PRESENTATION),
    iconSmall: small ?? (shape === "detail" || largeFitsSmall ? large : null),
    iconLarge: shape === "detail" ? large ?? small : null,
  };
}

const NO_PRESENTATION: SkillPresentation = {
  displayName: null,
  shortDescription: null,
  brandColor: null,
  defaultPrompt: null,
  implicitInvocation: true,
  author: null,
  version: null,
};

/** The decoded size of a base64 string, without decoding it. */
function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * A skill's presentation and icons from its files and validated frontmatter, each null when it
 * sets none. `warn` hears about everything left out, with the path inside the skill it is about.
 */
export function skillPresentation(input: {
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
  metadata: Record<string, string> | undefined;
  warn: (path: string, message: string) => void;
}): { presentation: SkillPresentation | null; icons: SkillIcons | null } {
  const { files } = input;
  const metadata = input.metadata ?? {};
  // Sorted input, so `Agents/` and `agents/` side by side resolve the same way every time.
  const named = (wanted: string) =>
    files.find((f) => {
      const [dir, name, ...rest] = f.path.split("/");
      return rest.length === 0 && name === wanted && dir.toLowerCase() === "agents";
    });
  const file = named("openai.yaml") ?? named("openai.yml");
  const at = file?.path ?? "";
  const warn = (message: string) => input.warn(at, message);
  const doc = file === undefined ? {} : readFile(file.bytes, warn);

  const iface = section(doc, "interface", warn);
  const policy = section(doc, "policy", warn);
  const text = (key: string, max: number, collapse: boolean): string | null => {
    const value = iface[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      warn(`\`interface.${key}\` must be a string; it is left out`);
      return null;
    }
    const cleaned = collapse ? collapseWhitespace(value) : value.trim();
    if (cleaned.length > max) {
      warn(
        `\`interface.${key}\` is ${cleaned.length} characters, over the ${max} limit; it is left out`,
      );
      return null;
    }
    if (!clean(cleaned)) {
      warn(
        `\`interface.${key}\` holds control characters or an unpaired surrogate; it is left out`,
      );
      return null;
    }
    return cleaned === "" ? null : cleaned;
  };

  const displayName = text("display_name", MAX_DISPLAY_NAME_CHARS, true);
  // Codex's own fallback: a skill without the file can still carry its line in the frontmatter.
  const shortDescription = text("short_description", MAX_SHORT_DESCRIPTION_CHARS, true) ??
    attribution(metadata["short-description"], MAX_SHORT_DESCRIPTION_CHARS);
  // A prompt may be several lines, so only its ends are trimmed.
  const defaultPrompt = text("default_prompt", MAX_DEFAULT_PROMPT_CHARS, false);
  let brandColor: string | null = null;
  if (iface.brand_color !== undefined && iface.brand_color !== null) {
    if (typeof iface.brand_color === "string" && BRAND_COLOR.test(iface.brand_color)) {
      brandColor = iface.brand_color;
    } else {
      warn("`interface.brand_color` must be a colour written #RRGGBB; it is left out");
    }
  }
  let implicitInvocation = true;
  const allow = policy.allow_implicit_invocation;
  if (allow !== undefined && allow !== null) {
    if (typeof allow === "boolean") implicitInvocation = allow;
    else warn("`policy.allow_implicit_invocation` must be true or false; it is left out");
  }
  const small = icon(files, iface, "icon_small", MAX_SMALL_ICON_BYTES, warn);
  const large = icon(files, iface, "icon_large", MAX_ICON_BYTES, warn);

  const presentation: SkillPresentation = {
    displayName,
    shortDescription,
    brandColor,
    defaultPrompt,
    implicitInvocation,
    author: attribution(metadata.author, MAX_ATTRIBUTION_CHARS),
    version: attribution(metadata.version, MAX_ATTRIBUTION_CHARS),
  };
  const empty = implicitInvocation &&
    Object.entries(presentation).every(([key, value]) =>
      key === "implicitInvocation" || value === null
    );
  return {
    presentation: empty ? null : presentation,
    icons: small === null && large === null ? null : { small, large },
  };
}

/** The file's document, or nothing when it cannot be read; never throws. */
function readFile(bytes: Uint8Array, warn: (message: string) => void): Record<string, unknown> {
  if (bytes.length > MAX_PRESENTATION_FILE_BYTES) {
    warn(
      `${bytes.length} bytes, over the ${MAX_PRESENTATION_FILE_BYTES}-byte limit; it is not read`,
    );
    return {};
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    warn("not valid UTF-8; it is not read");
    return {};
  }
  let doc: unknown;
  try {
    doc = parseSkillYaml(text);
  } catch (err) {
    warn(`${err instanceof Error ? err.message : err}; it is not read`);
    return {};
  }
  // An empty file is a file that sets nothing.
  if (doc === null || doc === undefined) return {};
  if (!isMapping(doc)) {
    warn("the file must be a mapping; it is not read");
    return {};
  }
  return doc;
}

function section(
  doc: Record<string, unknown>,
  key: string,
  warn: (message: string) => void,
): Record<string, unknown> {
  const value = doc[key];
  if (value === undefined || value === null) return {};
  if (isMapping(value)) return value;
  warn(`\`${key}\` must be a mapping; it is left out`);
  return {};
}

/** A metadata value as shown: whitespace collapsed, left out when blank or overlong. The
 * frontmatter rules already held it to a storable string, so nothing is warned here. */
function attribution(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const collapsed = collapseWhitespace(value);
  return collapsed === "" || collapsed.length > max || !clean(collapsed) ? null : collapsed;
}

function collapseWhitespace(value: string): string {
  return value.split(/\s+/).filter((s) => s !== "").join(" ");
}

/** Whether a kept string is plain text jsonb can hold: no control characters but `\n` and `\t`
 * (a default prompt may hold lines), no NUL, no unpaired surrogate. YAML decodes its escapes
 * after the UTF-8 check, so a `"\uD800"` reaches here. */
function clean(value: string): boolean {
  // oxlint-disable-next-line no-control-regex
  return value.isWellFormed() && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
}

/** One icon, when its field names a usable file. */
function icon(
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  iface: Record<string, unknown>,
  key: "icon_small" | "icon_large",
  max: number,
  warn: (message: string) => void,
): SkillIcon | null {
  const value = iface[key];
  if (value === undefined || value === null) return null;
  const path = typeof value === "string" ? iconPath(value) : null;
  if (path === null) {
    warn(
      `\`interface.${key}\` must be a relative path under assets/ of letters, digits, '.', '_' ` +
        "and '-', with no '..'; it is left out",
    );
    return null;
  }
  const file = files.find((f) => f.path === path);
  if (file === undefined) {
    warn(`\`interface.${key}\` names ${path}, which the skill does not hold; it is left out`);
    return null;
  }
  if (file.bytes.length > max) {
    warn(
      `\`interface.${key}\`: ${path} is ${file.bytes.length} bytes, over the ${max}-byte limit; it is left out`,
    );
    return null;
  }
  const mime = sniffSkillIcon(file.bytes);
  if (mime === null) {
    warn(`\`interface.${key}\`: ${path} is not a PNG, JPEG, WebP or SVG image; it is left out`);
    return null;
  }
  return { mime, data: file.bytes.toBase64() };
}

/**
 * An icon path as Codex resolves it, relative to the skill: `./` and `.` segments dropped, and
 * refused when it is absolute, uses a backslash, climbs with `..`, ends up outside `assets/`, or
 * holds a segment no skill file could have (`pathRefusal`). What it returns is held to that
 * grammar, so a warning may name it.
 */
export function iconPath(raw: string): string | null {
  if (raw === "" || raw.startsWith("/") || raw.includes("\\") || /^[A-Za-z]:/.test(raw)) {
    return null;
  }
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length < 2 || segments[0] !== "assets") return null;
  const path = segments.join("/");
  return pathRefusal(path) === null ? path : null;
}

/**
 * The image type the bytes are, or null when they are none ryph shows as a skill icon. The
 * raster formats are the attachment door's own sniff (core/attachments.ts `sniffImage`), one
 * set of signatures for both; an icon takes PNG, JPEG and WebP of those, never GIF, and adds an
 * SVG, which an attachment never is.
 */
export function sniffSkillIcon(bytes: Uint8Array): SkillIconMime | null {
  const raster = sniffImage(bytes);
  if (raster !== null) return raster === "image/gif" ? null : raster;
  return isSvg(bytes) ? "image/svg+xml" : null;
}

/**
 * Whether the bytes are UTF-8 text whose first element is `<svg`, past an optional BOM, an XML
 * declaration, comments and a doctype. A doctype with an internal subset is refused: it is the
 * entity-expansion shape, and no icon needs one.
 */
function isSvg(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return false;
  }
  let rest = text;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith("<?xml")) {
      const end = rest.indexOf("?>");
      if (end < 0) return false;
      rest = rest.slice(end + 2);
    } else if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->");
      if (end < 0) return false;
      rest = rest.slice(end + 3);
    } else if (/^<!doctype/i.test(rest)) {
      const end = rest.indexOf(">");
      if (end < 0 || rest.slice(0, end).includes("[")) return false;
      rest = rest.slice(end + 1);
    } else {
      return /^<svg[\s>/]/.test(rest);
    }
  }
}
