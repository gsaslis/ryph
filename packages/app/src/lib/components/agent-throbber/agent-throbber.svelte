<script lang="ts">
import { blobPath } from "$lib/brand/blob";
import { BlobMotion } from "$lib/brand/blob-motion";
import { agentFaceParts } from "$lib/utils/avatar";
import { cn } from "$lib/utils";
import { onMount } from "svelte";

export type ThrobberMood = "sleepy" | "working" | "thinking" | "happy" | "evil";

let {
  agentId,
  mood = "sleepy",
  size = 40,
  blinkRate = 1,
  mouthRate = 1,
  bob = 1,
  class: className,
}: {
  agentId: string;
  mood?: ThrobberMood;
  /** Pixels. */
  size?: number;
  /** Multiplier on how often it blinks. */
  blinkRate?: number;
  /** Multiplier on how fast the mouth changes. */
  mouthRate?: number;
  /** Multiplier on the body's bob/squish. */
  bob?: number;
  class?: string;
} = $props();

// The drawing is a little bigger than the box it takes up, so the wobble and the hop (which reach
// past the blob's resting edge) have room, and may spill past it without being clipped.
const drawn = $derived((size * 120) / 108);
const uid = Math.random().toString(36).slice(2, 8);
const parts = $derived(agentFaceParts(agentId));

let blinking = $state(false);
let mouthStep = $state(0);
let lookStep = $state(0);

const reduced = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Blink: sleepy ones blink slowly and rarely, busy ones quickly and often.
$effect(() => {
  if (reduced()) return;
  const gap = { sleepy: 3800, working: 900, thinking: 1800, happy: 2600, evil: 2200 }[mood] /
    blinkRate;
  const hold = mood === "sleepy" ? 260 : 110;
  let t: ReturnType<typeof setTimeout>;
  const loop = () => {
    t = setTimeout(() => {
      blinking = true;
      t = setTimeout(() => {
        blinking = false;
        loop();
      }, hold);
    }, gap * (0.6 + Math.random() * 0.8));
  };
  loop();
  return () => {
    clearTimeout(t);
    blinking = false;
  };
});

// Mouth and gaze: every tick only has a chance of changing the mouth, and a change picks a
// different shape, so it doesn't read as a loop. Only a busy face fidgets much.
$effect(() => {
  if (reduced()) return;
  const { every, chance } = {
    sleepy: { every: 900, chance: 0.2 },
    working: { every: 220, chance: 0.3 },
    thinking: { every: 450, chance: 0.25 },
    happy: { every: 700, chance: 0.2 },
    evil: { every: 450, chance: 0.25 },
  }[mood];
  const id = setInterval(() => {
    if (Math.random() < chance * mouthRate) mouthStep = 1 + Math.floor(Math.random() * 1000);
    if (Math.random() < chance) lookStep = Math.floor(Math.random() * 3) - 1;
  }, every);
  return () => clearInterval(id);
});

// The blob's wobble: the logo throbber's motion, added to this agent's own shape.
const AGITATION = {
  sleepy: { hum: 0, roll: 0.1 },
  working: { hum: 0.05, roll: 1.2 },
  thinking: { hum: 0.012, roll: 0.3 },
  happy: { hum: 0.025, roll: 0.6 },
  evil: { hum: 0.03, roll: 0.5 },
} as const;
// The body's bob, hop and sway are driven here rather than by CSS keyframes, so that a change of
// mood eases every number over instead of snapping from wherever the old animation was.
const BODY = {
  sleepy: { f: 0.24, hop: 0, sx: 0.03, sy: 0.04, sway: 0 },
  working: { f: 1.43, hop: 6, sx: 0.035, sy: 0.05, sway: 0 },
  thinking: { f: 0.42, hop: 0, sx: 0, sy: 0, sway: 4 },
  happy: { f: 0.9, hop: 5, sx: 0.03, sy: 0.04, sway: 0 },
  evil: { f: 1.43, hop: 6, sx: 0.035, sy: 0.05, sway: 0 },
} as const;
const body: Record<"f" | "hop" | "sx" | "sy" | "sway", number> = { ...BODY.sleepy };
let bodyPhase = 0;
let bodyTransform = $state("");
const motion = new BlobMotion();
let edge = $state("");
let hum = 0;
let roll = 0.1;
let element = $state<SVGSVGElement>();

$effect(() => {
  const waves = parts.waves;
  const draw = () => (edge = blobPath(
    [
      ...waves,
      ...motion.waves().filter((w) => w.k !== 1),
    ],
    0,
    0,
    40,
    32,
    1,
  ));
  if (!element || reduced()) {
    draw();
    return;
  }
  draw();
  let onScreen = false;
  let frame = 0;
  let last = 0;
  const step = (now: number) => {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const target = AGITATION[mood];
    const ease = Math.min(dt * (target.hum > hum ? 3 : 1.2), 1);
    hum += (target.hum - hum) * ease;
    if (target.hum === 0 && hum < 1e-4) hum = 0;
    roll += (target.roll - roll) * ease;
    motion.step(dt, { hum, roll });
    const goal = BODY[mood];
    const k = Math.min(dt * 4, 1);
    for (const key of ["f", "hop", "sx", "sy", "sway"] as const) {
      body[key] += (goal[key] - body[key]) * k;
    }
    bodyPhase += Math.PI * 2 * body.f * dt;
    const u = Math.cos(bodyPhase);
    const amount = bob;
    const lift = ((1 - u) / 2) * body.hop * amount;
    const sx = 1 + body.sx * amount * u;
    const sy = 1 - body.sy * amount * u;
    const turn = body.sway * amount * Math.sin(bodyPhase);
    bodyTransform = `translate(0 ${-lift.toFixed(2)}) translate(0 36) rotate(${
      turn.toFixed(2)
    }) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(0 -36)`;
    draw();
    frame = onScreen ? requestAnimationFrame(step) : 0;
  };
  const watcher = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    if (onScreen && !frame) {
      last = performance.now();
      frame = requestAnimationFrame(step);
    }
  });
  watcher.observe(element);
  return () => {
    watcher.disconnect();
    onScreen = false;
    cancelAnimationFrame(frame);
  };
});

let mounted = $state(false);
onMount(() => (mounted = true));

const f = (v: number) => Math.round(v * 10) / 10;

const features = $derived.by(() => {
  const { ink, tongue, gap, eyeY: y, mouthY: m } = parts;
  const stroke =
    `fill="none" stroke="${ink}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"`;
  const look = mood === "thinking" ? lookStep * 1.6 : mood === "working" ? lookStep * 0.8 : 0;
  const line = (x: number, dy = 0) =>
    `<path d="M${f(x - 3.4)} ${f(y + dy)}H${f(x + 3.4)}" ${stroke}/>`;
  const droop = (x: number) =>
    `<path d="M${f(x - 3.6)} ${f(y - 0.8)}Q${f(x)} ${f(y + 3.2)} ${f(x + 3.6)} ${
      f(y - 0.8)
    }" ${stroke}/>`;
  const dot = (x: number, r = 3.2) =>
    `<circle cx="${f(x + look)}" cy="${f(y)}" r="${r}" fill="${ink}"/>`;
  const arc = (x: number) =>
    `<path d="M${f(x - 3.6)} ${f(y + 1.6)}Q${f(x)} ${f(y - 3.8)} ${f(x + 3.6)} ${
      f(y + 1.6)
    }" ${stroke}/>`;

  const slit = (x: number) =>
    `<path d="M${f(x - 3.6)} ${f(y - 0.6)}Q${f(x)} ${f(y - 2.6)} ${f(x + 3.6)} ${
      f(y + 0.6 + (x < 0 ? 0 : -1.2))
    }L${f(x + 3)} ${f(y + 2.6)}Q${f(x)} ${f(y + 1.6)} ${f(x - 3)} ${f(y + 2.6)}Z" fill="${ink}"/>`;

  let eyes: string;
  if (mood === "evil") {
    eyes = blinking ? line(-gap) + line(gap) : slit(-gap) + slit(gap);
  } else if (blinking) eyes = line(-gap) + line(gap);
  else if (mood === "sleepy") eyes = droop(-gap) + droop(gap);
  else if (mood === "happy") eyes = arc(-gap) + arc(gap);
  else if (mood === "thinking") eyes = dot(-gap) + dot(gap, 2.6);
  else eyes = dot(-gap, 3.6) + dot(gap, 3.6);

  let mouth: string;
  if (mood === "sleepy") {
    // Breathing: the little "o" swells and shrinks with each step.
    const r = mouthStep % 2 ? 2.4 : 1.6;
    mouth = `<ellipse cx="0" cy="${f(m)}" rx="${r}" ry="${f(r * 1.1)}" fill="${ink}"/>`;
  } else if (mood === "evil") {
    const fangs = `<path d="M-4 ${f(m - 1)}l1.6 3l1.6 -3M1 ${f(m - 1)}l1.6 3l1.6 -3" fill="#fff"/>`;
    mouth = [
      `<path d="M-7 ${f(m - 2)}Q0 ${f(m + 7)} 7 ${f(m - 2)}Z" fill="${ink}"/>${fangs}`,
      `<path d="M-6 ${f(m)}Q0 ${f(m + 5)} 7 ${f(m - 3)}" ${stroke}/>`,
      `<path d="M-6.5 ${f(m - 2)}Q0 ${f(m + 8)} 6.5 ${f(m - 2)}Z" fill="${ink}"/>`,
    ][mouthStep % 3];
  } else if (mood === "happy") {
    mouth = `<path d="M-6.5 ${f(m - 2)}Q0 ${f(m + 8)} 6.5 ${f(m - 2)}Z" fill="${ink}"/>`;
  } else if (mood === "thinking") {
    mouth = [
      `<path d="M-4 ${f(m)}Q-1 ${f(m - 2)} 1 ${f(m)}T5 ${f(m - 1)}" ${stroke}/>`,
      `<path d="M-4 ${f(m)}H4" ${stroke}/>`,
      `<circle cx="2" cy="${f(m)}" r="1.8" fill="${ink}"/>`,
    ][mouthStep % 3];
  } else {
    // Working: chatter through a set of shapes.
    mouth = [
      `<path d="M-6.5 ${f(m - 2)}Q0 ${f(m + 8)} 6.5 ${f(m - 2)}Z" fill="${ink}"/>`,
      `<circle cx="0" cy="${f(m)}" r="2.8" fill="${ink}"/>`,
      `<path d="M-6 ${f(m - 1.5)}Q0 ${f(m + 4.5)} 6 ${f(m - 1.5)}" ${stroke}/>`,
      `<ellipse cx="0" cy="${f(m)}" rx="4.4" ry="2" fill="${ink}"/>`,
      `<path d="M-6.5 ${f(m - 2)}Q0 ${f(m + 8)} 6.5 ${
        f(m - 2)
      }Z" fill="${ink}"/><ellipse cx="0" cy="${f(m + 2.4)}" rx="3" ry="1.8" fill="${tongue}"/>`,
    ][mouthStep % 5];
  }
  return parts.blush + eyes + mouth;
});

// Gradient ids are per instance: two throbbers share a page, with different colours.
const paint = $derived(
  parts.defs.replaceAll('id="s"', `id="s${uid}"`).replaceAll('id="g"', `id="g${uid}"`),
);
</script>

<svg
  viewBox="-60 -60 120 120"
  bind:this={element}
  width={drawn}
  height={drawn}
  style:margin="{-(drawn - size) / 2}px"
  style:overflow="visible"
  style:filter={mood === "evil" ? "hue-rotate(-35deg) saturate(1.6) brightness(0.85)" : "none"}
  style:transition="filter 0.6s"
  aria-hidden="true"
  class={cn("agent-throbber shrink-0 select-none", mounted && "on", className)}
  data-mood={mood}
>
  <g transform={bodyTransform}>
    {@html paint}
    <path d={edge} fill="url(#s{uid})" />
    <path d={edge} fill="url(#g{uid})" />
    <g transform={parts.transform}>{@html features}</g>
  </g>
</svg>
