/**
 * Fountain droplet encoder.
 */

import { getDropletIndices } from './schedule.js';

/**
 * Encodes one droplet payload (112 x Uint32 = 448 bytes) for given seed.
 *
 * @param {number} seed
 * @param {Uint32Array[]} sourceBlocks - Array of K source blocks, each Uint32Array(112)
 * @param {Uint32Array} [outU32] - Optional preallocated buffer
 * @returns {Uint32Array} 112-word droplet payload
 */
export function encodeDroplet(seed, sourceBlocks, outU32) {
  const K = sourceBlocks.length;
  const words = sourceBlocks[0]?.length || 112;
  const indices = getDropletIndices(seed, K);
  const out = outU32 || new Uint32Array(words);
  out.fill(0);

  const numIndices = indices.length;
  for (let i = 0; i < numIndices; i++) {
    const block = sourceBlocks[indices[i]];
    for (let w = 0; w < words; w++) {
      out[w] ^= block[w];
    }
  }

  return out;
}
