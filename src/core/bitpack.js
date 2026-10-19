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

  const fullTriplets = Math.floor(bytes.length / 3);
  let bIdx = 0;
  let sIdx = 0;
  const maxS = numSymbols - 8;

  // Ultra-fast 24-bit word chunking: 3 bytes produce exactly 8 3-bit symbols without loops
  while (bIdx < fullTriplets * 3 && sIdx <= maxS) {
    const w = (bytes[bIdx] << 16) | (bytes[bIdx + 1] << 8) | bytes[bIdx + 2];
    out[sIdx] = (w >>> 21) & 7;
    out[sIdx + 1] = (w >>> 18) & 7;
    out[sIdx + 2] = (w >>> 15) & 7;
    out[sIdx + 3] = (w >>> 12) & 7;
    out[sIdx + 4] = (w >>> 9) & 7;
    out[sIdx + 5] = (w >>> 6) & 7;
    out[sIdx + 6] = (w >>> 3) & 7;
    out[sIdx + 7] = w & 7;
    bIdx += 3;
    sIdx += 8;
  }

  // Handle trailing symbols beyond full 3-byte blocks
  let bitPos = bIdx * 8;
  for (let s = sIdx; s < numSymbols; s++) {
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

  const fullOctets = Math.min(Math.floor(symbols.length / 8), Math.floor(targetByteCount / 3));
  let sIdx = 0;
  let bIdx = 0;

  // Fast 24-bit word chunking: 8 3-bit symbols combine into 3 bytes without bit loops
  while (sIdx < fullOctets * 8) {
    const w = ((symbols[sIdx] & 7) << 21) |
              ((symbols[sIdx + 1] & 7) << 18) |
              ((symbols[sIdx + 2] & 7) << 15) |
              ((symbols[sIdx + 3] & 7) << 12) |
              ((symbols[sIdx + 4] & 7) << 9) |
              ((symbols[sIdx + 5] & 7) << 6) |
              ((symbols[sIdx + 6] & 7) << 3) |
              (symbols[sIdx + 7] & 7);
    out[bIdx] = (w >>> 16) & 0xFF;
    out[bIdx + 1] = (w >>> 8) & 0xFF;
    out[bIdx + 2] = w & 0xFF;
    sIdx += 8;
    bIdx += 3;
  }

  // Handle trailing bytes/bits
  let bitPos = bIdx * 8;
  const numSymbols = symbols.length;
  for (let s = sIdx; s < numSymbols && bitPos < totalBits; s++) {
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
 * Converts a byte array into an array of multi-bit symbols (3-bit, 5-bit, or 6-bit MSB-first).
 *
 * @param {Uint8Array} bytes
 * @param {number} [bitsPerCell=3] - Bits per cell (3, 5, or 6)
 * @param {number} [targetSymbolCount] - Expected number of symbols
 * @param {Uint8Array} [outSymbols] - Optional preallocated output buffer
 * @returns {Uint8Array} Array of symbols
 */
export function bytesToSymbolsMultiBit(bytes, bitsPerCell = 3, targetSymbolCount, outSymbols) {
  const totalBits = bytes.length * 8;
  const numSymbols = targetSymbolCount || Math.ceil(totalBits / bitsPerCell);
  const out = outSymbols || new Uint8Array(numSymbols);

  if (bitsPerCell === 3) {
    return bytesToSymbols(bytes, numSymbols, out);
  }

  if (bitsPerCell === 6) {
    // Ultra-fast 24-bit chunking: 3 bytes produce exactly 4 6-bit symbols
    const fullTriplets = Math.floor(bytes.length / 3);
    let bIdx = 0;
    let sIdx = 0;
    const maxS = numSymbols - 4;

    while (bIdx < fullTriplets * 3 && sIdx <= maxS) {
      const w = (bytes[bIdx] << 16) | (bytes[bIdx + 1] << 8) | bytes[bIdx + 2];
      out[sIdx] = (w >>> 18) & 63;
      out[sIdx + 1] = (w >>> 12) & 63;
      out[sIdx + 2] = (w >>> 6) & 63;
      out[sIdx + 3] = w & 63;
      bIdx += 3;
      sIdx += 4;
    }

    let bitPos = bIdx * 8;
    for (let s = sIdx; s < numSymbols; s++) {
      let sym = 0;
      for (let b = 5; b >= 0; b--) {
        if (bitPos < totalBits) {
          const byteIdx = bitPos >>> 3;
          const bitOffset = 7 - (bitPos & 7);
          const bit = (bytes[byteIdx] >>> bitOffset) & 1;
          sym |= (bit << b);
          bitPos++;
        } else {
          bitPos++;
        }
      }
      out[s] = sym;
    }
    return out;
  }

  // General bit-by-bit packing (e.g. 5-bit)
  let bitPos = 0;
  for (let s = 0; s < numSymbols; s++) {
    let sym = 0;
    for (let b = bitsPerCell - 1; b >= 0; b--) {
      if (bitPos < totalBits) {
        const byteIdx = bitPos >>> 3;
        const bitOffset = 7 - (bitPos & 7);
        const bit = (bytes[byteIdx] >>> bitOffset) & 1;
        sym |= (bit << b);
        bitPos++;
      } else {
        bitPos++;
      }
    }
    out[s] = sym;
  }
  return out;
}

/**
 * Converts an array of multi-bit symbols back into bytes.
 *
 * @param {Uint8Array} symbols
 * @param {number} [bitsPerCell=3] - Bits per cell (3, 5, or 6)
 * @param {number} targetByteCount - Number of bytes to extract
 * @param {Uint8Array} [outBytes] - Optional preallocated output buffer
 * @returns {Uint8Array} Reconstructed bytes
 */
export function symbolsToBytesMultiBit(symbols, bitsPerCell = 3, targetByteCount, outBytes) {
  if (bitsPerCell === 3) {
    return symbolsToBytes(symbols, targetByteCount, outBytes);
  }

  const out = outBytes || new Uint8Array(targetByteCount);
  const totalBits = targetByteCount * 8;
  out.fill(0);

  if (bitsPerCell === 6) {
    // Fast 24-bit word chunking: 4 6-bit symbols combine into 3 bytes
    const fullQuartets = Math.min(Math.floor(symbols.length / 4), Math.floor(targetByteCount / 3));
    let sIdx = 0;
    let bIdx = 0;

    while (sIdx < fullQuartets * 4) {
      const w = ((symbols[sIdx] & 63) << 18) |
                ((symbols[sIdx + 1] & 63) << 12) |
                ((symbols[sIdx + 2] & 63) << 6) |
                (symbols[sIdx + 3] & 63);
      out[bIdx] = (w >>> 16) & 0xFF;
      out[bIdx + 1] = (w >>> 8) & 0xFF;
      out[bIdx + 2] = w & 0xFF;
      sIdx += 4;
      bIdx += 3;
    }

    let bitPos = bIdx * 8;
    const numSymbols = symbols.length;
    for (let s = sIdx; s < numSymbols && bitPos < totalBits; s++) {
      const sym = symbols[s] & 63;
      for (let b = 5; b >= 0 && bitPos < totalBits; b--) {
        const bit = (sym >>> b) & 1;
        const byteIdx = bitPos >>> 3;
        const bitOffset = 7 - (bitPos & 7);
        out[byteIdx] |= (bit << bitOffset);
        bitPos++;
      }
    }
    return out;
  }

  // General bit-by-bit unpacking (e.g. 5-bit)
  let bitPos = 0;
  const numSymbols = symbols.length;
  const mask = (1 << bitsPerCell) - 1;
  for (let s = 0; s < numSymbols && bitPos < totalBits; s++) {
    const sym = symbols[s] & mask;
    for (let b = bitsPerCell - 1; b >= 0 && bitPos < totalBits; b--) {
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
 * Maps cell/symbol margins to byte-level confidence scores (3-bit).
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
    const rawM = cellMargins[s];
    const isStraddle = (bitPos & 7) >= 6;
    const m = isStraddle ? rawM * 0.82 : rawM;
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

/**
 * Maps multi-bit cell/symbol margins to byte-level confidence scores.
 *
 * @param {Float32Array|number[]} cellMargins
 * @param {number} [bitsPerCell=3]
 * @param {number} targetByteCount
 * @param {Float32Array} [outMargins]
 * @returns {Float32Array}
 */
export function symbolsMarginsToByteMarginsMultiBit(cellMargins, bitsPerCell = 3, targetByteCount, outMargins) {
  if (bitsPerCell === 3) {
    return symbolsMarginsToByteMargins(cellMargins, targetByteCount, outMargins);
  }

  const out = outMargins || new Float32Array(targetByteCount);
  out.fill(Infinity);
  const totalBits = targetByteCount * 8;

  let bitPos = 0;
  const numSymbols = cellMargins.length;
  for (let s = 0; s < numSymbols && bitPos < totalBits; s++) {
    const rawM = cellMargins[s];
    const bitStart = bitPos;
    const bitEnd = bitPos + bitsPerCell;
    const isStraddle = (bitStart >>> 3) !== ((bitEnd - 1) >>> 3);
    const m = isStraddle ? rawM * 0.85 : rawM;

    for (let b = bitsPerCell - 1; b >= 0 && bitPos < totalBits; b--) {
      const byteIdx = bitPos >>> 3;
      if (m < out[byteIdx]) {
        out[byteIdx] = m;
      }
      bitPos++;
    }
  }
  return out;
}

