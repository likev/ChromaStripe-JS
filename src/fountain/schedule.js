/**
 * Transmission schedule and droplet index generation for LT fountain codes.
 */

import { PRNG, seedMix } from '../core/prng.js';
import { sampleResidualDegree } from './degree.js';

function gcd(a, b) {
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

const COPRIME_CACHE = new Map();

/**
 * Computes an integer step coprime to K for pseudo-random block permutation.
 * @param {number} K
 * @returns {number}
 */
export function getCoprimeStep(K) {
  if (K <= 2) return 1;
  if (COPRIME_CACHE.has(K)) return COPRIME_CACHE.get(K);

  let step = Math.floor(K * 0.6180339887) | 1;
  while (gcd(step, K) !== 1) {
    step += 2;
  }
  COPRIME_CACHE.set(K, step);
  return step;
}

/**
 * Phase 1 block permutation: maps seed in [0, K-1] bijectively to block index in [0, K-1].
 * @param {number} seed
 * @param {number} K
 * @returns {number}
 */
export function permuteBlock(seed, K) {
  if (K <= 1) return 0;
  const step = getCoprimeStep(K);
  return (Math.imul(seed, step) >>> 0) % K;
}

/**
 * Returns phase: 0 = Systematic, 1 = Strided Parity, 2 = Fountain
 * @param {number} seed
 * @param {number} K
 * @param {number} [alpha=0.15]
 * @returns {number}
 */
export function getDropletPhase(seed, K, alpha = 0.15) {
  if (seed < K) return 0;
  const parityCount = Math.ceil(alpha * K);
  if (seed < K + parityCount) return 1;
  return 2;
}

/**
 * Computes the source block indices mixed into droplet for given seed and K.
 *
 * @param {number} seed
 * @param {number} K
 * @param {number} [alpha=0.15]
 * @returns {number[]} Array of unique block indices
 */
export function getDropletIndices(seed, K, alpha = 0.15) {
  if (K <= 1) return [0];

  // Phase 1: Systematic (1-to-1 block mapping via permutation)
  if (seed < K) {
    return [permuteBlock(seed, K)];
  }

  const parityCount = Math.ceil(alpha * K);

  // Phase 2: Strided parity
  if (seed < K + parityCount) {
    const j = seed - K;
    const S = Math.max(1, Math.ceil(K / 3));
    const idx0 = j % K;
    const idx1 = (j + S) % K;
    const idx2 = (j + 2 * S) % K;

    const res = [idx0];
    if (idx1 !== idx0) res.push(idx1);
    if (idx2 !== idx0 && idx2 !== idx1) res.push(idx2);
    return res;
  }

  // Phase 3: Rateless fountain
  const rng = new PRNG(seedMix(seed ^ 0x55555555));
  const degree = sampleResidualDegree(rng, K);

  const set = new Set();
  while (set.size < degree) {
    set.add(rng.nextBelow(K));
  }
  return Array.from(set);
}
