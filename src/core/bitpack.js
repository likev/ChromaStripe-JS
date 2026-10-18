/**
 * Bitpack module: Converts byte buffers to/from 3-bit symbols (MSB-first).
 */

/**
 * Converts a byte array into an array of 3-bit symbols (0..7).
 * Each 3-bit symbol has bits [b2, b1, b0] corresponding to stream bits.
 *
 * @param {Uint8Array} bytes
 * @param {number} [targetSymbolCount] - Expected number of symbols (defaults to ceil(bytes.length * 8 / 3))
 * @param {Uint8Array} [outSymbols] - Optional preallocated output buffer
 * @returns {Uint8Array} Array of 3-bit symbols
 */
export function bytesToSymbols(bytes, targetSymbolCount, outSymbols) {
  const totalBits = bytes.length * 8;
  const numSymbols = targetSymbolCount || Math.ceil(totalBits / 3);
  const out = outSymbols || new Uint8Array(numSymbols);

  let bitPos = 0;
  for (let s = 0; s < numSymbols; s++) {
    let sym = 0;
    for (let b = 2; b >= 0; b--) {
      if (bitPos < totalBits) {
        const byteIdx = bitPos >>> 3;
        const bitOffset = 7 - (bitPos & 7);
        const bit = (bytes[byteIdx] >>> bitOffset) & 1;
        sym |= (bit << b);
        bitPos++;
      } else {
        // Trailing bits beyond source stream are 0
        bitPos++;
      }
    }
    out[s] = sym;
  }
  return out;
}

/**
 * Converts an array of 3-bit symbols back into bytes.
 *
 * @param {Uint8Array} symbols
 * @param {number} targetByteCount - Number of bytes to extract
 * @param {Uint8Array} [outBytes] - Optional preallocated output buffer
 * @returns {Uint8Array} Reconstructed bytes
 */
export function symbolsToBytes(symbols, targetByteCount, outBytes) {
  const out = outBytes || new Uint8Array(targetByteCount);
  const totalBits = targetByteCount * 8;
  out.fill(0);

  let bitPos = 0;
  const numSymbols = symbols.length;
  for (let s = 0; s < numSymbols && bitPos < totalBits; s++) {
    const sym = symbols[s] & 7;
    for (let b = 2; b >= 0 && bitPos < totalBits; b--) {
      const bit = (sym >>> b) & 1;
      const byteIdx = bitPos >>> 3;
      const bitOffset = 7 - (bitPos & 7);
      out[byteIdx] |= (bit << bitOffset);
      bitPos++;
    }
  }
  return out;
}

/**
 * Maps cell/symbol margins to byte-level confidence scores.
 *
 * @param {Float32Array|number[]} cellMargins - Margin per 3-bit symbol
 * @param {number} targetByteCount - Number of bytes to extract
 * @param {Float32Array} [outMargins] - Optional preallocated buffer
 * @returns {Float32Array}
 */
export function symbolsMarginsToByteMargins(cellMargins, targetByteCount, outMargins) {
  const out = outMargins || new Float32Array(targetByteCount);
  out.fill(Infinity);
  const totalBits = targetByteCount * 8;

  let bitPos = 0;
  const numSymbols = cellMargins.length;
  for (let s = 0; s < numSymbols && bitPos < totalBits; s++) {
    const m = cellMargins[s];
    for (let b = 2; b >= 0 && bitPos < totalBits; b--) {
      const byteIdx = bitPos >>> 3;
      if (m < out[byteIdx]) {
        out[byteIdx] = m;
      }
      bitPos++;
    }
  }
  return out;
}
