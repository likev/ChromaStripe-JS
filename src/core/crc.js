/**
 * CRC module: Table-driven CRC32 (IEEE 802.3) and CRC16-CCITT.
 */

// Precompute CRC32 table (polynomial 0xEDB88320)
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i >>> 0;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) >>> 0 : (c >>> 1) >>> 0;
  }
  CRC32_TABLE[i] = c >>> 0;
}

// Precompute CRC16-CCITT table (polynomial 0x1021, normal)
const CRC16_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = (i << 8) & 0xFFFF;
  for (let j = 0; j < 8; j++) {
    c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  CRC16_TABLE[i] = c & 0xFFFF;
}

/**
 * Computes or continues CRC32 over Uint8Array.
 * @param {Uint8Array} bytes
 * @param {number} [prevCrc=0] - Optional previous CRC32 result for incremental computation
 * @returns {number} 32-bit unsigned CRC
 */
export function crc32(bytes, prevCrc = 0) {
  let c = (prevCrc ^ 0xFFFFFFFF) >>> 0;
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export const crc32Incremental = crc32;

/**
 * Computes or continues CRC16-CCITT (init 0xFFFF, poly 0x1021).
 * "123456789" -> 0x29B1
 * @param {Uint8Array} bytes
 * @param {number} [prevCrc=0xFFFF]
 * @returns {number} 16-bit unsigned CRC
 */
export function crc16(bytes, prevCrc = 0xFFFF) {
  let c = prevCrc & 0xFFFF;
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    c = (CRC16_TABLE[((c >>> 8) ^ bytes[i]) & 0xFF] ^ (c << 8)) & 0xFFFF;
  }
  return c & 0xFFFF;
}
