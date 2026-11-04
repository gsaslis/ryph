<svelte:options namespace="svg" />

<script lang="ts">
/**
 * The blob as the logo paints it, for inside an `<svg>`: Ryph blue into violet and orchid, with a
 * teal-to-amber glow drifting over it, the two turning against each other. Shared by `RyphLogo`
 * and `RyphBlob` so they are the same colours.
 */
let {
  edge,
  cx,
  cy,
  r,
  turning,
}: {
  /** The edge as path data; before it has one, the circle itself. */
  edge: string | undefined;
  cx: number;
  cy: number;
  r: number;
  /** Whether the colours turn: not for anyone who'd rather not have motion. */
  turning: boolean;
} = $props();

// Every copy on the page needs its own gradient ids.
const id = $props.id();

/** Where the glow sits and how far it reaches, as fractions of the radius (as first drawn). */
const GLOW = { dx: -268 / 764.8, dy: 267.2 / 764.8, r: 727 / 764.8 };
</script>

<defs>
  <linearGradient
    id="{id}-sweep"
    gradientUnits="userSpaceOnUse"
    x1={cx - r}
    y1={cy}
    x2={cx + r}
    y2={cy}
  >
    <stop offset="0" style:stop-color="var(--brand-a)" />
    <stop offset="0.55" style:stop-color="var(--brand-b)" />
    <stop offset="1" style:stop-color="var(--brand-c)" />
    {#if turning}
      <animateTransform
        attributeName="gradientTransform"
        type="rotate"
        from="0 {cx} {cy}"
        to="360 {cx} {cy}"
        dur="16s"
        repeatCount="indefinite"
      />
    {/if}
  </linearGradient>
  <radialGradient
    id="{id}-glow"
    gradientUnits="userSpaceOnUse"
    cx={cx + GLOW.dx * r}
    cy={cy + GLOW.dy * r}
    r={GLOW.r * r}
  >
    <stop offset="0" style:stop-color="var(--brand-d)" stop-opacity="0.9" />
    <stop offset="0.5" style:stop-color="var(--brand-e)" stop-opacity="0.35" />
    <stop offset="1" style:stop-color="var(--brand-e)" stop-opacity="0" />
    {#if turning}
      <animateTransform
        attributeName="gradientTransform"
        type="rotate"
        from="360 {cx} {cy}"
        to="0 {cx} {cy}"
        dur="11s"
        repeatCount="indefinite"
      />
    {/if}
  </radialGradient>
</defs>
<!-- The shape painted twice, once in each gradient. Turning a round shape shows only as its
     colours moving, so the two gradients turn against each other at different speeds.
     Painted directly rather than through a clip path: Chrome repaints a changing clip path only
     within where it was, so a bulge growing past that was cut off along a straight edge. -->
{#each ["sweep", "glow"] as layer (layer)}
  {#if edge}
    <path d={edge} fill="url(#{id}-{layer})" />
  {:else}
    <circle {cx} {cy} {r} fill="url(#{id}-{layer})" />
  {/if}
{/each}
