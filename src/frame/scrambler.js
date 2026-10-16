/**
 * Scrambler module: Whole-packet whitening and unused-cell fill generation.
 */

import { xorshift32 } from '../core/prng.js';
import { PROTOCOL_VERSION, PACKET_TOTAL_BYTES } from './constants.js';

/**
 * Derives initial PRNG state for a stripe packet scrambler.
 * @param {number} stripeIdx - 0..3
 * @param {number} [ver=PROTOCOL_VERSION]
 * @returns {number}
 */
export function getScramblerSeed(stripeIdx, ver = PROTOCOL_VERSION) {
  return ((0xC5A00000 | ((ver & 0xFF) << 8) | (stripeIdx & 0x03)) >>> 0);
}

/**
 * Scrambles or de-scrambles a 542-byte packet in-place (involution).
 *
 * @param {Uint8Array} packetBytes - 542 bytes
 * @param {number} stripeIdx - 0..3
 * @param {number} [ver=PROTOCOL_VERSION]
 * @returns {Uint8Array} same buffer
 */
export function scramblePacket(packetBytes, stripeIdx, ver = PROTOCOL_VERSION) {
  let rng = getScramblerSeed(stripeIdx, ver);
  const len = packetBytes.length;

  for (let i = 0; i < len; i++) {
    rng = xorshift32(rng);
    packetBytes[i] ^= (rng & 0xFF);
  }
  return packetBytes;
}

/**
 * Generates fill 3-bit symbols for extra/unused cells in middle stripes.
 *
 * @param {number} stripeIdx - 0..3
 * @param {number} count - Number of fill symbols needed
 * @param {number} [ver=PROTOCOL_VERSION]
 * @returns {Uint8Array} Array of 3-bit symbols (0..7)
 */
export function getFillSymbols(stripeIdx, count, ver = PROTOCOL_VERSION) {
  let rng = getScramblerSeed(stripeIdx, ver);
  // Advance past the 542 packet bytes
  for (let i = 0; i < PACKET_TOTAL_BYTES; i++) {
    rng = xorshift32(rng);
  }

  const fill = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    rng = xorshift32(rng);
    fill[i] = (rng >>> 16) & 0x07;
  }
  return fill;
}
