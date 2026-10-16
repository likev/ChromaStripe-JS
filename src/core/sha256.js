/**
 * SHA-256 utility: Uses Web Crypto crypto.subtle.digest when available,
 * with pure-JS fallback for synchronous/offline contexts.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(n, x) {
  return (x >>> n) | (x << (32 - n));
}

/**
 * Pure-JS synchronous SHA-256.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} 32-byte digest
 */
export function sha256Sync(bytes) {
  const byteLen = bytes.length;
  const bitLen = byteLen * 8;
  const paddedLen = ((byteLen + 8) >>> 6) + 1 << 4;
  const w = new Uint32Array(64);
  const m = new Uint32Array(paddedLen);

  for (let i = 0; i < byteLen; i++) {
    m[i >>> 2] |= bytes[i] << (24 - ((i & 3) << 3));
  }
  m[byteLen >>> 2] |= 0x80 << (24 - ((byteLen & 3) << 3));
  m[paddedLen - 1] = bitLen & 0xFFFFFFFF;
  m[paddedLen - 2] = Math.floor(bitLen / 4294967296);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  for (let i = 0; i < paddedLen; i += 16) {
    for (let j = 0; j < 16; j++) w[j] = m[i + j];
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(7, w[j - 15]) ^ rotr(18, w[j - 15]) ^ (w[j - 15] >>> 3);
      const s1 = rotr(17, w[j - 2]) ^ rotr(19, w[j - 2]) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (let j = 0; j < 64; j++) {
      const s1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ ((~e) & g);
      const temp1 = (h + s1 + ch + K[j] + w[j]) >>> 0;
      const s0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const result = new Uint8Array(32);
  const state = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    result[i * 4] = (state[i] >>> 24) & 0xFF;
    result[i * 4 + 1] = (state[i] >>> 16) & 0xFF;
    result[i * 4 + 2] = (state[i] >>> 8) & 0xFF;
    result[i * 4 + 3] = state[i] & 0xFF;
  }
  return result;
}

/**
 * Computes SHA-256 digest asynchronously (preferring WebCrypto if available).
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function digestSha256(bytes) {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle?.digest) {
    try {
      const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return new Uint8Array(buf);
    } catch (_) {
      // Fallback
    }
  }
  return sha256Sync(bytes);
}

/**
 * Formats a 32-byte digest as a hex string.
 * @param {Uint8Array} digest
 * @returns {string}
 */
export function toHex(digest) {
  return Array.from(digest).map(b => b.toString(16).padStart(2, '0')).join('');
}
