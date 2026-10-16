/**
 * Degree distributions for LT fountain codes.
 */

import { PRNG } from '../core/prng.js';

/**
 * Tuned degree distribution for systematic LT codes with post-systematic residual.
 * Designed to quickly cover residual 10-20% missing blocks and provide high rank for GE.
 *
 * @param {PRNG} rng
 * @param {number} K - Total number of source blocks
 * @returns {number} degree in [1, K]
 */
export function sampleResidualDegree(rng, K) {
  if (K <= 1) return 1;
  if (K <= 3) return rng.nextBelow(K) + 1;

  const r = rng.nextFloat();
  let d;
  if (r < 0.05) {
    d = 1;
  } else if (r < 0.25) {
    d = 2;
  } else if (r < 0.50) {
    d = 3;
  } else if (r < 0.70) {
    d = 5;
  } else if (r < 0.85) {
    d = 8;
  } else if (r < 0.95) {
    d = 12;
  } else {
    d = Math.min(K, 20);
  }

  return Math.min(K, Math.max(1, d));
}

/**
 * Ideal / Robust Soliton-inspired distribution.
 * @param {PRNG} rng
 * @param {number} K
 * @returns {number}
 */
export function sampleSolitonDegree(rng, K) {
  if (K <= 1) return 1;
  const r = rng.nextFloat();
  if (r < 1.0 / K) return 1;
  // CDF for Ideal Soliton: P(D <= d) = 1 - 1/d
  // 1 - 1/d = r => 1/d = 1 - r => d = 1 / (1 - r)
  let d = Math.floor(1.0 / (1.0 - r + 1e-12));
  return Math.min(K, Math.max(1, d));
}
