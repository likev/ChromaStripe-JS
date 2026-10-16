/**
 * Galois Field GF(2^8) arithmetic with primitive polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1).
 */

export const GF_POLY = 0x11D;
export const EXP = new Uint8Array(512);
export const LOG = new Uint8Array(256);

// Initialize tables with generator alpha = 2
(function initGFTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= GF_POLY;
    }
  }
  for (let i = 255; i < 512; i++) {
    EXP[i] = EXP[i - 255];
  }
  LOG[0] = 0; // Convention: log(0) = 0
})();

/**
 * GF(256) multiplication
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/**
 * GF(256) division
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function gfDiv(a, b) {
  if (b === 0) throw new Error('Division by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[(LOG[a] - LOG[b] + 255) % 255];
}

/**
 * GF(256) multiplicative inverse
 * @param {number} a
 * @returns {number}
 */
export function gfInv(a) {
  if (a === 0) throw new Error('Zero has no inverse in GF(256)');
  return EXP[255 - LOG[a]];
}

/**
 * GF(256) addition (XOR)
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function gfAdd(a, b) {
  return (a ^ b) & 0xFF;
}
