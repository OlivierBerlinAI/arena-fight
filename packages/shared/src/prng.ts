/**
 * Deterministic seeded PRNG (mulberry32). The entire simulation draws its
 * randomness from one instance so that seed + inputs fully determine a match.
 */
export class PRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Current internal state, included in the state hash. */
  getState(): number {
    return this.state;
  }

  setState(s: number): void {
    this.state = s >>> 0;
  }
}
