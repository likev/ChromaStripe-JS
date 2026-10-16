/**
 * Level 1 Simulation: Symbol and bit-level error channel models.
 */

import { PRNG } from '../../src/core/prng.js';
import { PACKET_TOTAL_BYTES } from '../../src/frame/constants.js';

export class SymbolChannel {
  /**
   * @param {object} options
   * @param {number} [options.ber=0.01] - Bit error rate
   * @param {number} [options.burstProb=0.0] - Probability of spatial burst corruption
   * @param {number} [options.seed=456]
   */
  constructor(options = {}) {
    this.ber = options.ber ?? 0.01;
    this.burstProb = options.burstProb ?? 0.0;
    this.rng = new PRNG(options.seed || 456);
  }

  /**
   * Corrupts a 542-byte packet with bit flips and burst noise.
   *
   * @param {Uint8Array} packet - 542 bytes
   * @returns {Uint8Array} Corrupted copy
   */
  corruptPacket(packet) {
    const out = new Uint8Array(packet);

    // 1. Independent bit flips
    if (this.ber > 0) {
      for (let i = 0; i < PACKET_TOTAL_BYTES; i++) {
        for (let b = 0; b < 8; b++) {
          if (this.rng.nextFloat() < this.ber) {
            out[i] ^= (1 << b);
          }
        }
      }
    }

    // 2. Burst error (e.g., partial tear or glare streak)
    if (this.burstProb > 0 && this.rng.nextFloat() < this.burstProb) {
      const start = this.rng.nextBelow(PACKET_TOTAL_BYTES - 20);
      const len = this.rng.nextBelow(30) + 5;
      const end = Math.min(PACKET_TOTAL_BYTES, start + len);
      for (let i = start; i < end; i++) {
        out[i] = this.rng.nextBelow(256);
      }
    }

    return out;
  }
}
