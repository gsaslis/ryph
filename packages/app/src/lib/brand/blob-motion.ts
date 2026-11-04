import type { Wave } from "./blob";

/**
 * How the logo's blob moves. Its edge is the circle with waves running round it: mode 0 swells
 * the whole thing, mode 1 nudges it off centre, mode k puts k bulges on it. Each has two parts:
 * - an idle drift, slow and never repeating quite the same, like wax in a lava lamp;
 * - a damped spring on top, which a jolt sets ringing and which settles back to the drift.
 * Low modes ring slower, the way a real blob would.
 *
 * Shared by `RyphLogo` and `RyphBlob`, so the two are the same blob: left alone, they drift alike.
 */
export class BlobMotion {
  readonly #modes = [0, 1, 2, 3, 4, 5].map((k) => ({
    k,
    /** How far the idle drift reaches, and how fast it goes (Hz). */
    drift: [0.025, 0.035, 0.1, 0.065, 0.04, 0.02][k],
    rate: 0.05 + Math.random() * 0.07,
    seed: Math.random() * Math.PI * 2,
    amplitude: 0,
    velocity: 0,
    /** Where round the edge its bulges sit; it wanders, so the shape also rolls. */
    phase: Math.random() * Math.PI * 2,
    spin: (Math.random() < 0.5 ? -1 : 1) * (0.08 + Math.random() * 0.14),
    /** Angular frequency: about 2 Hz for the swell, rising with the number of bulges. */
    omega: 2 * Math.PI * (k < 2 ? 2 : 1.3 + 0.4 * k),
    damping: k === 0 ? 0.14 : 0.1,
    /** Where its sustained wobble is in its cycle; each starts apart so they don't pulse as one. */
    humPhase: Math.random() * Math.PI * 2,
  }));
  #time = 0;

  /** Sets it wobbling like jelly, harder the higher `strength` (1 is a good jolt). */
  jolt(strength: number): void {
    for (const mode of this.#modes) {
      if (mode.k === 1) continue;
      const push = mode.k === 0 ? 0.07 : 0.14 / Math.sqrt(mode.k - 1);
      // The swell always pushes out first, like something jumping; the bulges go either way.
      const direction = mode.k === 0 ? 1 : Math.random() < 0.5 ? -1 : 1;
      mode.velocity += direction * strength * push * mode.omega * (0.6 + Math.random() * 0.4);
      // And it spins up a little, then slows back down.
      mode.spin += (Math.random() - 0.5) * strength * 1.5;
    }
  }

  /**
   * Moves it on by `dt` seconds. `quiver` keeps it trembling for as long as it is passed (0.03 is
   * the logo being pointed at); `roll` is the fastest it settles back to turning, or while it
   * hums, how fast it turns.
   *
   * `hum` keeps it wobbling steadily, the way a jolt does for a moment: each wave is driven a
   * little under the speed it rings at, and the rhythm wanders, so the shape never visibly loops.
   * One rhythm per wave, not two: two beat against each other, and the wobble swelled and died
   * away every few seconds, which read as being nudged. Unlike a jolt there is no kick, only a
   * wobble that is always going.
   */
  step(
    dt: number,
    { quiver = 0, roll = 0.22, hum = 0 }: { quiver?: number; roll?: number; hum?: number } = {},
  ): void {
    // A frame's timestamp can come in a hair before the moment the loop was started from, so the
    // first step of a run can be negative — and the wandering rhythm below takes its square root.
    // One NaN there and the whole edge is NaN, which draws nothing at all.
    if (!(dt > 0)) return;
    this.#time += dt;
    for (const mode of this.#modes) {
      let drive = quiver === 0 ? 0 : (Math.random() - 0.5) * mode.omega * mode.omega * quiver;
      mode.humPhase += 0.92 * mode.omega * dt + (Math.random() - 0.5) * 0.6 * Math.sqrt(dt);
      if (hum !== 0 && mode.k !== 1) {
        // The swell is held back; the more bulges, the less each one is pushed.
        const reach = hum * (mode.k === 0 ? 0.4 : 1 / Math.sqrt(mode.k - 1));
        drive += reach * mode.omega * mode.omega * Math.sin(mode.humPhase);
      }
      // Humming, it is damped harder, so the wobble comes up (and dies down) in half a second
      // rather than two: a lightly damped spring driven steadily takes that long to build.
      const damping = mode.damping + 0.15 * Math.min(hum / 0.03, 1);
      const force = -mode.omega * mode.omega * mode.amplitude -
        2 * damping * mode.omega * mode.velocity +
        drive;
      mode.velocity += force * dt;
      mode.amplitude += mode.velocity * dt;
      // Spin eases back to a lazy roll — or, while it hums, up to `roll` itself.
      const rest = Math.sign(mode.spin) * (hum !== 0 ? roll : Math.min(Math.abs(mode.spin), roll));
      mode.spin += (rest - mode.spin) * Math.min(dt * 1.5, 1);
      mode.phase += mode.spin * dt;
    }
  }

  /** The edge's waves now — or at time `t`, for a still blob caught at a nicely lopsided moment. */
  waves(t = this.#time): Wave[] {
    return this.#modes.map((mode) => ({
      k: mode.k,
      phase: mode.phase,
      // Two slow sines at unrelated speeds, so the drift doesn't visibly loop.
      size: mode.drift *
          (0.6 * Math.sin(2 * Math.PI * mode.rate * t + mode.seed) +
            0.4 * Math.sin(2 * Math.PI * mode.rate * 1.618 * t + 2 * mode.seed)) +
        mode.amplitude,
    }));
  }
}
