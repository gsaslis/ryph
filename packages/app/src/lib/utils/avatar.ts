import { blobBounds, blobPath, randomBlob, type Wave } from "$lib/brand/blob";

/** An agent's face, and the colour it is drawn in. */
export interface AgentAvatar {
  uri: string;
  /** The blob's main colour as `#rrggbb`: the one hue that is the agent's own. */
  color: string;
}

// A run's timeline asks for the same agent's face over and over — once per assistant block.
// Keyed by id, bounded by the roster, which is small.
const cache = new Map<string, AgentAvatar>();

/**
 * An agent's face: a blob like the one in Ryph's logo, in a pair of the brand's colours, with a
 * face on it. Everything about it is picked by a generator seeded with the agent's **id**, so it
 * is fixed for the agent's lifetime and a rename never changes who you are looking at.
 *
 * Drawn here rather than fetched from anywhere: Ryph self-hosts, and an avatar is not worth
 * handing agent ids to a third party, going blank behind a firewall, or a request per face.
 */
export function agentAvatar(agentId: string): AgentAvatar {
  let avatar = cache.get(agentId);
  if (avatar === undefined) {
    const { svg, color } = drawFace(seeded(agentId));
    avatar = { uri: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, color };
    cache.set(agentId, avatar);
  }
  return avatar;
}

/** What a face is made of, so an animated one can redraw its features and keep the rest. */
export interface FaceParts {
  /** Gradient defs (ids `s` and `g`), as SVG markup. */
  defs: string;
  /** The still blob's waves: radius 40 round the origin, 32 points. */
  waves: Wave[];
  /** The transform that puts the face's own coordinate space on the blob. */
  transform: string;
  ink: string;
  tongue: string;
  gap: number;
  eyeY: number;
  mouthY: number;
  blush: string;
  color: string;
}

export function agentFaceParts(agentId: string): FaceParts {
  return drawFace(seeded(agentId)).parts;
}

export function agentAvatarUri(agentId: string): string {
  return agentAvatar(agentId).uri;
}

/**
 * Hues the blobs are drawn in: the logo's blue, violet, orchid, teal and amber, and the coral,
 * green and deep blue of the landing page's product hues. Each blob runs from one into the hue
 * 50° on.
 */
const HUES = [223, 285, 340, 190, 80, 25, 155, 255];

type Random = () => number;

function drawFace(random: Random): { svg: string; color: string; parts: FaceParts } {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const between = (a: number, b: number) => a + random() * (b - a);
  const f = (v: number) => Math.round(v * 10) / 10;

  // The blob, in a 100-unit square: radius 40, so its largest bulge (120%) still fits.
  const waves = randomBlob(random);
  const edge = blobPath(waves, 0, 0, 40, 32, 1);
  const [left, top, right, bottom] = blobBounds(waves, 0, 0, 40);

  const hue = pick(HUES);
  const main = { l: 0.86, c: 0.1, h: hue };
  const next = { l: 0.87, c: 0.09, h: (hue + 50) % 360 };
  const glow = { l: 0.93, c: 0.08, h: (hue + 300) % 360 };
  // Features in a deep shade of the blob's own hue rather than black: softer, and still clear.
  const ink = hex({ l: 0.24, c: 0.06, h: hue });
  const sweep = between(0, 360);

  // The face sits in the middle of the blob, nudged a little, and leans a little: a character,
  // not a stamp. Its features are drawn small and scaled up by 1.4, to read at 24px.
  const cx = (left + right) / 2 + between(-3, 3);
  const cy = (top + bottom) / 2 + between(-3, 2);
  const tilt = between(-10, 10);
  const gap = between(8, 12);
  const eyeY = between(-7, -3);
  const mouthY = eyeY + between(12, 15);
  const stroke =
    `fill="none" stroke="${ink}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"`;

  const eye = (x: number, kind: string): string => {
    const y = eyeY;
    switch (kind) {
      case "tall":
        return `<ellipse cx="${f(x)}" cy="${f(y)}" rx="2.6" ry="4.2" fill="${ink}"/>`;
      case "happy":
        return `<path d="M${f(x - 3.6)} ${f(y + 1.6)}Q${f(x)} ${f(y - 3.8)} ${f(x + 3.6)} ${
          f(y + 1.6)
        }" ${stroke}/>`;
      case "sleepy":
        return `<path d="M${f(x - 3.6)} ${f(y - 0.8)}Q${f(x)} ${f(y + 3.2)} ${f(x + 3.6)} ${
          f(y - 0.8)
        }" ${stroke}/>`;
      case "sparkle":
        return `<circle cx="${f(x)}" cy="${f(y)}" r="3.8" fill="${ink}"/><circle cx="${
          f(x + 1.3)
        }" cy="${f(y - 1.4)}" r="1.3" fill="#fff"/>`;
      default:
        return `<circle cx="${f(x)}" cy="${f(y)}" r="3.2" fill="${ink}"/>`;
    }
  };
  const eyeKind = pick(["dot", "dot", "tall", "happy", "sleepy", "sparkle", "wink"]);
  const eyes = eyeKind === "wink"
    ? eye(-gap, "dot") + eye(gap, "happy")
    : eye(-gap, eyeKind) + eye(gap, eyeKind);

  const y = mouthY;
  const tongue = hex({ l: 0.72, c: 0.14, h: 10 });
  const mouth = pick([
    // A smile, a grin, a grin with its tongue out, an "o", a straight face, a smirk, a cat's.
    `<path d="M-6 ${f(y - 1.5)}Q0 ${f(y + 4.5)} 6 ${f(y - 1.5)}" ${stroke}/>`,
    `<path d="M-6.5 ${f(y - 2)}Q0 ${f(y + 8)} 6.5 ${f(y - 2)}Z" fill="${ink}"/>`,
    `<path d="M-6.5 ${f(y - 2)}Q0 ${f(y + 8)} 6.5 ${
      f(y - 2)
    }Z" fill="${ink}"/><ellipse cx="0" cy="${f(y + 2.4)}" rx="3" ry="1.8" fill="${tongue}"/>`,
    `<circle cx="0" cy="${f(y)}" r="2.6" fill="${ink}"/>`,
    `<path d="M-4 ${f(y)}H4" ${stroke}/>`,
    `<path d="M-5 ${f(y)}Q1 ${f(y + 3.5)} 6 ${f(y - 2)}" ${stroke}/>`,
    `<path d="M-5.5 ${f(y - 1)}Q-2.75 ${f(y + 3)} 0 ${f(y - 1)}Q2.75 ${f(y + 3)} 5.5 ${
      f(y - 1)
    }" ${stroke}/>`,
  ]);

  const cheek = hex({ l: 0.76, c: 0.12, h: 12 });
  const blush = random() < 0.4
    ? [-1, 1].map((side) =>
      `<ellipse cx="${f(side * (gap + 5))}" cy="${
        f(eyeY + 7)
      }" rx="3.6" ry="2.2" fill="${cheek}" opacity=".5"/>`
    ).join("")
    : "";

  const transform = `translate(${f(cx)} ${f(cy)}) rotate(${f(tilt)}) scale(1.4)`;
  const base = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100">`,
    `<defs>`,
    `<linearGradient id="s" gradientUnits="userSpaceOnUse" x1="-40" y1="0" x2="40" y2="0" gradientTransform="rotate(${
      f(sweep)
    })">`,
    `<stop offset="0" stop-color="${hex(main)}"/><stop offset="1" stop-color="${hex(next)}"/>`,
    `</linearGradient>`,
    `<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="-14" cy="16" r="36">`,
    `<stop offset="0" stop-color="${hex(glow)}" stop-opacity=".85"/><stop offset="1" stop-color="${
      hex(glow)
    }" stop-opacity="0"/>`,
    `</radialGradient>`,
    `</defs>`,
  ].join("").replace(/^<svg[^>]*>/, "");
  const paint = `<path d="${edge}" fill="url(#s)"/><path d="${edge}" fill="url(#g)"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100">${base}${paint}<g transform="${transform}">${blush}${eyes}${mouth}</g></svg>`;

  return {
    svg,
    color: hex(main),
    parts: {
      defs: base,
      waves,
      transform,
      ink,
      tongue,
      gap,
      eyeY,
      mouthY,
      blush,
      color: hex(main),
    },
  };
}

/** Numbers in [0, 1), the same run for the same text every time (cyrb53 into mulberry32). */
function seeded(text: string): Random {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  let state = h1 >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An oklch colour as the nearest sRGB `#rrggbb`, which any SVG renderer takes. */
function hex({ l, c, h }: { l: number; c: number; h: number }): string {
  const angle = (h * Math.PI) / 180;
  const a = c * Math.cos(angle);
  const b = c * Math.sin(angle);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ];
  const linear = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ];
  return "#" + linear.map((v) => {
    v = Math.min(1, Math.max(0, v));
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(s * 255).toString(16).padStart(2, "0");
  }).join("");
}

/**
 * A person's face where there is no picture of them: the first letters of their first two
 * names, as the sidebar's user menu draws its owner. Empty for a name of nothing but spaces.
 */
export function personInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => [...part][0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
