/**
 * PRNG module: xorshift32 with Murmur3 fmix32 seeding and rejection sampling.
 */

const NONZERO_GUARD = 0x6a09e667 >>> 0;

/**
 * Single step of xorshift32 algorithm.
 * @param {number} state - 32-bit integer state
 * @returns {number} next 32-bit state (unsigned)
 */
export function xorshift32(state) {
  let s = (state >>> 0) || NONZERO_GUARD;
  s ^= (s << 13) >>> 0;
  s ^= (s >>> 17) >>> 0;
  s ^= (s << 5) >>> 0;
  return s >>> 0;
}

/**
 * Murmur3 32-bit finalizer (fmix32) using Math.imul.
 * Maps any 32-bit seed to an avalanche-mixed non-zero uint32.
 * @param {number} seed
 * @returns {number} mixed non-zero uint32
 */
export function seedMix(seed) {
  let h = seed >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h === 0 ? NONZERO_GUARD : h) >>> 0;
}

/**
 * Rejection sampling for uniform integer in [0, n - 1] without modulo bias.
 * @param {PRNG|{nextU32: () => number}} rng
 * @param {number} n - Upper bound (exclusive)
 * @returns {number}
 */
export function nextBelow(rng, n) {
  if (n <= 1) return 0;
  const limit = ((-n >>> 0) % n) >>> 0;
  while (true) {
    const raw = rng.nextU32();
    if (raw >= limit) {
      return (raw % n) >>> 0;
    }
  }
}

/**
 * Lightweight stateful PRNG wrapper.
 */
export class PRNG {
  /**
   * @param {number} seed
   */
  constructor(seed = 1) {
    this.state = seedMix(seed);
  }

  /**
   * @returns {number} uint32
   */
  nextU32() {
    this.state = xorshift32(this.state);
    return this.state;
  }

  /**
   * @returns {number} float in [0, 1)
   */
  nextFloat() {
    return this.nextU32() / 4294967296.0;
  }

  /**
   * @param {number} n
   * @returns {number} integer in [0, n - 1]
   */
  nextBelow(n) {
    return nextBelow(this, n);
  }
}
