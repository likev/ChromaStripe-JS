/**
 * Packet framing, serialization, RS interleaving, CRC32, and scrambling.
 */

import {
  PACKET_TOTAL_BYTES,
  HEADER_BYTES,
  PAYLOAD_BYTES,
  RS_PARITY_BYTES,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_V2,
  RS_RATE_MODES,
  V2_RS_PARITY_HIGH_RATE,
  V2_RS_PARITY_STANDARD,
  V2_PACKET_BYTES_HIGH_RATE,
  V2_PACKET_BYTES_STANDARD,
  V2_PAYLOAD_BYTES,
  V2_TURBO_PAYLOAD_WORDS,
  V2_TURBO_PAYLOAD_BYTES,
  V2_TURBO_PACKET_BYTES_HIGH_RATE,
  V2_TURBO_PACKET_BYTES_STANDARD
} from './constants.js';
import { crc32 } from '../core/crc.js';
import { rsEncode, rsDecode, fastDecodeCodeword } from '../core/reedsolomon.js';
import { scramblePacket } from './scrambler.js';

/**
 * Builds a 542-byte scrambled packet.
 *
 * @param {object} header - { stripeIdx, phase, seed, K, sessionId, ver? }
 * @param {Uint32Array} payloadU32 - 112 words (448 bytes)
 * @param {Uint8Array} [outPacket] - Optional preallocated buffer of 542 bytes
 * @returns {Uint8Array} 542-byte scrambled packet
 */
/**
 * Builds a v2 single-codeword scrambled micro-stripe packet (N <= 255).
 *
 * @param {object} header - { stripeIdx, phase, seed, K, sessionId, rateMode? }
 * @param {Uint32Array} payloadU32 - 56 words (224 bytes) or custom
 * @param {Uint8Array} [outPacket] - Optional preallocated buffer
 * @param {object} [options]
 * @returns {Uint8Array} Scrambled v2 packet
 */
export function buildPacketV2(header, payloadU32, outPacket, options = {}) {
  const ver = 2;
  const stripeIdx = (header.stripeIdx ?? 0) & 0x07;
  const phase = (header.phase ?? 0) & 0x03;
  const rateMode = (header.rateMode ?? RS_RATE_MODES.HIGH_RATE) & 0x01;
  const words = payloadU32.length;
  const payloadBytes = words * 4;
  const parityLen = rateMode === RS_RATE_MODES.HIGH_RATE ? V2_RS_PARITY_HIGH_RATE : V2_RS_PARITY_STANDARD;

  const isDual = words > 56;
  const totalParity = isDual ? parityLen * 2 : parityLen;
  const totalLen = HEADER_BYTES + payloadBytes + totalParity;

  const packet = outPacket || new Uint8Array(totalLen);

  // Byte 0: [ver(2b: 10) | stripeIdx(3b: 0..7) | phase(2b: 0..3) | rateMode(1b)]
  packet[0] = ((ver & 3) << 6) | (stripeIdx << 3) | (phase << 1) | rateMode;

  const seed = (header.seed ?? 0) >>> 0;
  packet[1] = (seed >>> 16) & 0xFF;
  packet[2] = (seed >>> 8) & 0xFF;
  packet[3] = seed & 0xFF;

  const K = (header.K ?? 1) & 0xFFFF;
  packet[4] = (K >>> 8) & 0xFF;
  packet[5] = K & 0xFF;

  const sessionId = (header.sessionId ?? 0) & 0xFFFF;
  packet[6] = (sessionId >>> 8) & 0xFF;
  packet[7] = sessionId & 0xFF;

  // Copy payload into offset 12
  const payloadBytesView = new Uint8Array(payloadU32.buffer, payloadU32.byteOffset, payloadBytes);
  packet.set(payloadBytesView, HEADER_BYTES);

  // CRC32 over header 0..7 + payload
  const c = crc32(payloadBytesView, crc32(packet.subarray(0, 8)));
  packet[8] = (c >>> 24) & 0xFF;
  packet[9] = (c >>> 16) & 0xFF;
  packet[10] = (c >>> 8) & 0xFF;
  packet[11] = c & 0xFF;

  const dataLen = HEADER_BYTES + payloadBytes;

  if (!isDual) {
    // Single RS codeword over 12 header + payloadBytes (total data length <= 255)
    const parity = rsEncode(packet.subarray(0, dataLen), parityLen);
    packet.set(parity, dataLen);
  } else {
    // 2-way interleaved RS codewords (each codeword length = 230 data + parityLen <= 255)
    const halfData = dataLen >>> 1;
    const d0 = new Uint8Array(halfData);
    const d1 = new Uint8Array(halfData);
    for (let i = 0; i < halfData; i++) {
      d0[i] = packet[i << 1];
      d1[i] = packet[(i << 1) + 1];
    }
    const p0 = rsEncode(d0, parityLen);
    const p1 = rsEncode(d1, parityLen);
    packet.set(p0, dataLen);
    packet.set(p1, dataLen + parityLen);
  }

  // Scramble with ver=2
  scramblePacket(packet, stripeIdx, 2);

  return packet;
}

export function buildPacket(header, payloadU32, outPacket, options = {}) {
  const ver = header.ver ?? options?.version ?? PROTOCOL_VERSION;
  if (ver === 2) {
    return buildPacketV2(header, payloadU32, outPacket, options);
  }

  const packet = outPacket || new Uint8Array(PACKET_TOTAL_BYTES);
  const stripeIdx = header.stripeIdx & 0x03;
  const phase = header.phase & 0x03;

  // Header byte 0: [ver(2b) | stripeIdx(2b) | phase(2b) | reserved(2b)]
  packet[0] = ((ver & 0x03) << 6) | (stripeIdx << 4) | (phase << 2);

  // Bytes 1..3: seed (uint24, big-endian)
  const seed = header.seed >>> 0;
  packet[1] = (seed >>> 16) & 0xFF;
  packet[2] = (seed >>> 8) & 0xFF;
  packet[3] = seed & 0xFF;

  // Bytes 4..5: K (uint16, big-endian)
  const K = header.K & 0xFFFF;
  packet[4] = (K >>> 8) & 0xFF;
  packet[5] = K & 0xFF;

  // Bytes 6..7: sessionId (uint16, big-endian)
  const sessionId = header.sessionId & 0xFFFF;
  packet[6] = (sessionId >>> 8) & 0xFF;
  packet[7] = sessionId & 0xFF;

  // Copy 448 bytes payload into packet (offset 12)
  const payloadBytes = new Uint8Array(payloadU32.buffer, payloadU32.byteOffset, PAYLOAD_BYTES);
  packet.set(payloadBytes, HEADER_BYTES);

  // CRC32 over header 0..7 + 448 B payload
  const crcHeaderPart = packet.subarray(0, 8);
  const c = crc32(payloadBytes, crc32(crcHeaderPart));

  // Bytes 8..11: CRC32 (uint32, big-endian)
  packet[8] = (c >>> 24) & 0xFF;
  packet[9] = (c >>> 16) & 0xFF;
  packet[10] = (c >>> 8) & 0xFF;
  packet[11] = c & 0xFF;

  // RS parity: 3 interleaved codewords over 460 data bytes (12 header + 448 payload)
  // Split: 154 / 153 / 153
  const d0 = new Uint8Array(154);
  const d1 = new Uint8Array(153);
  const d2 = new Uint8Array(153);

  for (let i = 0; i < 460; i++) {
    const mod = i % 3;
    const div = Math.floor(i / 3);
    if (mod === 0) d0[div] = packet[i];
    else if (mod === 1) d1[div] = packet[i];
    else d2[div] = packet[i];
  }

  // Parities: 28, 27, 27 bytes
  const p0 = rsEncode(d0, 28);
  const p1 = rsEncode(d1, 27);
  const p2 = rsEncode(d2, 27);

  // Store parity in packet: offset 460..541
  packet.set(p0, 460);       // 460..487 (28 bytes)
  packet.set(p1, 460 + 28);  // 488..514 (27 bytes)
  packet.set(p2, 460 + 55);  // 515..541 (27 bytes)

  // Scramble the entire 542 bytes
  scramblePacket(packet, stripeIdx, ver);

  return packet;
}

/**
 * Parses and verifies a received 542-byte packet.
 *
 * @param {Uint8Array} rawBytes - 542 bytes
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   header?: object,
 *   payloadU32?: Uint32Array,
 *   corrected?: number
 * }}
 */
// Preallocated scratch pool for zero-allocation packet parsing
const SCRATCH_BUF = new Uint8Array(PACKET_TOTAL_BYTES);
const SCRATCH_CW0 = new Uint8Array(182);
const SCRATCH_CW1 = new Uint8Array(180);
const SCRATCH_CW2 = new Uint8Array(180);
const SCRATCH_M0 = new Float32Array(182);
const SCRATCH_M1 = new Float32Array(180);
const SCRATCH_M2 = new Float32Array(180);
const SCRATCH_DATA460 = new Uint8Array(460);

/**
 * Parses and verifies a received v2 single-codeword micro-stripe packet (N <= 255).
 *
 * @param {Uint8Array} rawBytes
 * @param {number} [expectedStripeIdx=-1]
 * @param {Float32Array} [byteMargins=null]
 * @param {object} [options]
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   header?: object,
 *   payloadU32?: Uint32Array,
 *   corrected?: number
 * }}
 */
export function parsePacketV2(rawBytes, expectedStripeIdx = -1, byteMargins = null, options = {}) {
  const N = rawBytes.length;
  if (N < HEADER_BYTES + 4) {
    return { ok: false, error: 'INVALID_PACKET_LENGTH' };
  }

  // Dual codeword mode: N === 488 (High-Rate) or 496 (Standard)
  if (
    N === V2_TURBO_PACKET_BYTES_HIGH_RATE ||
    N === V2_TURBO_PACKET_BYTES_STANDARD ||
    N === 488 ||
    N === 496
  ) {
    const parityLen = (N === V2_TURBO_PACKET_BYTES_HIGH_RATE || N === 488)
      ? V2_RS_PARITY_HIGH_RATE
      : V2_RS_PARITY_STANDARD;
    const startStripe = expectedStripeIdx >= 0 ? expectedStripeIdx : 0;
    const endStripe = expectedStripeIdx >= 0 ? expectedStripeIdx : 7;
    const testBuf = new Uint8Array(N);

    for (let candStripe = startStripe; candStripe <= endStripe; candStripe++) {
      testBuf.set(rawBytes);
      scramblePacket(testBuf, candStripe, 2);

      const dataLen = 460;
      const halfData = dataLen >>> 1; // 230
      const cwLen = halfData + parityLen; // 244 or 248

      const cw0 = new Uint8Array(cwLen);
      const cw1 = new Uint8Array(cwLen);
      for (let i = 0; i < halfData; i++) {
        cw0[i] = testBuf[i << 1];
        cw1[i] = testBuf[(i << 1) + 1];
      }
      cw0.set(testBuf.subarray(dataLen, dataLen + parityLen), halfData);
      cw1.set(testBuf.subarray(dataLen + parityLen, dataLen + 2 * parityLen), halfData);

      let m0 = null, m1 = null;
      if (byteMargins && byteMargins.length >= N) {
        m0 = new Float32Array(cwLen);
        m1 = new Float32Array(cwLen);
        for (let i = 0; i < halfData; i++) {
          m0[i] = byteMargins[i << 1];
          m1[i] = byteMargins[(i << 1) + 1];
        }
        m0.set(byteMargins.subarray(dataLen, dataLen + parityLen), halfData);
        m1.set(byteMargins.subarray(dataLen + parityLen, dataLen + 2 * parityLen), halfData);
      }

      const r0 = fastDecodeCodeword(cw0, parityLen, m0);
      if (!r0.ok) continue;
      const r1 = fastDecodeCodeword(cw1, parityLen, m1);
      if (!r1.ok) continue;

      for (let i = 0; i < halfData; i++) {
        testBuf[i << 1] = cw0[i];
        testBuf[(i << 1) + 1] = cw1[i];
      }

      const b0 = testBuf[0];
      const ver = (b0 >>> 6) & 3;
      const stripeIdx = (b0 >>> 3) & 7;
      const phase = (b0 >>> 1) & 3;
      const rateMode = b0 & 1;

      if (ver !== 2 || stripeIdx !== candStripe) continue;

      const seed = ((testBuf[1] << 16) | (testBuf[2] << 8) | testBuf[3]) >>> 0;
      const K = ((testBuf[4] << 8) | testBuf[5]) >>> 0;
      const sessionId = ((testBuf[6] << 8) | testBuf[7]) >>> 0;
      const storedCrc = (((testBuf[8] << 24) | (testBuf[9] << 16) | (testBuf[10] << 8) | testBuf[11]) >>> 0);

      const payloadBytes = testBuf.subarray(HEADER_BYTES, dataLen);
      const computedCrc = crc32(payloadBytes, crc32(testBuf.subarray(0, 8)));

      if (computedCrc !== storedCrc) continue;

      const words = payloadBytes.length >>> 2;
      const payloadU32 = new Uint32Array(words);
      new Uint8Array(payloadU32.buffer).set(payloadBytes);

      return {
        ok: true,
        header: { ver, stripeIdx, phase, rateMode, seed, K, sessionId },
        payloadU32,
        corrected: r0.corrected + r1.corrected
      };
    }
    return { ok: false, error: 'RS_OR_CRC_FAILED' };
  }

  let candParities;
  if (N === V2_PACKET_BYTES_HIGH_RATE) {
    candParities = [V2_RS_PARITY_HIGH_RATE];
  } else if (N === V2_PACKET_BYTES_STANDARD) {
    candParities = [V2_RS_PARITY_STANDARD];
  } else if (N > HEADER_BYTES + V2_PAYLOAD_BYTES) {
    candParities = [N - (HEADER_BYTES + V2_PAYLOAD_BYTES)];
  } else {
    candParities = [V2_RS_PARITY_HIGH_RATE, V2_RS_PARITY_STANDARD];
  }

  const startStripe = expectedStripeIdx >= 0 ? expectedStripeIdx : 0;
  const endStripe = expectedStripeIdx >= 0 ? expectedStripeIdx : 7;
  const testBuf = new Uint8Array(N);

  for (let candStripe = startStripe; candStripe <= endStripe; candStripe++) {
    for (const parityLen of candParities) {
      if (parityLen <= 0 || parityLen >= N - HEADER_BYTES) continue;
      testBuf.set(rawBytes);
      scramblePacket(testBuf, candStripe, 2);

      const r = fastDecodeCodeword(testBuf, parityLen, byteMargins);
      if (!r.ok) continue;

      const b0 = testBuf[0];
      const ver = (b0 >>> 6) & 3;
      const stripeIdx = (b0 >>> 3) & 7;
      const phase = (b0 >>> 1) & 3;
      const rateMode = b0 & 1;

      if (ver !== 2 || stripeIdx !== candStripe) continue;

      const seed = ((testBuf[1] << 16) | (testBuf[2] << 8) | testBuf[3]) >>> 0;
      const K = ((testBuf[4] << 8) | testBuf[5]) >>> 0;
      const sessionId = ((testBuf[6] << 8) | testBuf[7]) >>> 0;
      const storedCrc = (((testBuf[8] << 24) | (testBuf[9] << 16) | (testBuf[10] << 8) | testBuf[11]) >>> 0);

      const dataLen = N - parityLen;
      const payloadBytes = testBuf.subarray(HEADER_BYTES, dataLen);
      const computedCrc = crc32(payloadBytes, crc32(testBuf.subarray(0, 8)));

      if (computedCrc !== storedCrc) continue;

      const words = payloadBytes.length >>> 2;
      const payloadU32 = new Uint32Array(words);
      new Uint8Array(payloadU32.buffer).set(payloadBytes);

      return {
        ok: true,
        header: { ver, stripeIdx, phase, rateMode, seed, K, sessionId },
        payloadU32,
        corrected: r.corrected
      };
    }
  }

  return { ok: false, error: 'RS_OR_CRC_FAILED' };
}

export function parsePacket(rawBytes, expectedStripeIdx = -1, byteMargins = null, options = {}) {
  if (
    rawBytes.length === V2_PACKET_BYTES_HIGH_RATE ||
    rawBytes.length === V2_PACKET_BYTES_STANDARD ||
    rawBytes.length === V2_TURBO_PACKET_BYTES_HIGH_RATE ||
    rawBytes.length === V2_TURBO_PACKET_BYTES_STANDARD ||
    rawBytes.length === 488 ||
    rawBytes.length === 496 ||
    options?.version === 2 ||
    (rawBytes.length <= 500 && rawBytes.length !== PACKET_TOTAL_BYTES)
  ) {
    return parsePacketV2(rawBytes, expectedStripeIdx, byteMargins, options);
  }

  if (rawBytes.length !== PACKET_TOTAL_BYTES) {
    return { ok: false, error: 'INVALID_PACKET_LENGTH' };
  }

  let decodedData = null;
  let totalCorrected = 0;
  let matchedHeader = null;

  const startStripe = expectedStripeIdx >= 0 ? expectedStripeIdx : 0;
  const endStripe = expectedStripeIdx >= 0 ? expectedStripeIdx : 3;

  for (let candStripe = startStripe; candStripe <= endStripe; candStripe++) {
    const testBuf = SCRATCH_BUF;
    testBuf.set(rawBytes);
    scramblePacket(testBuf, candStripe, PROTOCOL_VERSION);

    // Try RS decode on 3 interleaved codewords
    const cw0 = SCRATCH_CW0;
    const cw1 = SCRATCH_CW1;
    const cw2 = SCRATCH_CW2;

    for (let i = 0; i < 460; i++) {
      const mod = i % 3;
      const div = Math.floor(i / 3);
      if (mod === 0) cw0[div] = testBuf[i];
      else if (mod === 1) cw1[div] = testBuf[i];
      else cw2[div] = testBuf[i];
    }

    cw0.set(testBuf.subarray(460, 488), 154);
    cw1.set(testBuf.subarray(488, 515), 153);
    cw2.set(testBuf.subarray(515, 542), 153);

    // Interleaved byte margins for each codeword
    let m0 = null, m1 = null, m2 = null;
    if (byteMargins && byteMargins.length === PACKET_TOTAL_BYTES) {
      m0 = SCRATCH_M0;
      m1 = SCRATCH_M1;
      m2 = SCRATCH_M2;
      for (let i = 0; i < 460; i++) {
        const mod = i % 3;
        const div = Math.floor(i / 3);
        if (mod === 0) m0[div] = byteMargins[i];
        else if (mod === 1) m1[div] = byteMargins[i];
        else m2[div] = byteMargins[i];
      }
      for (let i = 0; i < 28; i++) m0[154 + i] = byteMargins[460 + i];
      for (let i = 0; i < 27; i++) m1[153 + i] = byteMargins[488 + i];
      for (let i = 0; i < 27; i++) m2[153 + i] = byteMargins[515 + i];
    }

    const r0 = fastDecodeCodeword(cw0, 28, m0);
    if (!r0.ok) continue;

    // Early check cw0[0] header before decoding cw1 and cw2
    const hdr0 = cw0[0];
    if (((hdr0 >>> 6) & 0x03) !== PROTOCOL_VERSION ||
        ((hdr0 >>> 4) & 0x03) !== candStripe ||
        (hdr0 & 0x03) !== 0) {
      continue; // Reject bogus cw0 before decoding cw1 and cw2!
    }

    const r1 = fastDecodeCodeword(cw1, 27, m1);
    if (!r1.ok) continue;

    const r2 = fastDecodeCodeword(cw2, 27, m2);
    if (!r2.ok) continue;

    // RS succeeded on all 3 codewords! Reconstruct the 460 data bytes
    const data460 = SCRATCH_DATA460;
    for (let i = 0; i < 460; i++) {
      const mod = i % 3;
      const div = Math.floor(i / 3);
      if (mod === 0) data460[i] = cw0[div];
      else if (mod === 1) data460[i] = cw1[div];
      else data460[i] = cw2[div];
    }

    // Parse header fields
    const b0 = data460[0];
    const ver = (b0 >>> 6) & 0x03;
    const stripeIdx = (b0 >>> 4) & 0x03;
    const phase = (b0 >>> 2) & 0x03;

    if (stripeIdx !== candStripe) {
      continue; // Stripe index mismatch
    }

    const seed = ((data460[1] << 16) | (data460[2] << 8) | data460[3]) >>> 0;
    const K = ((data460[4] << 8) | data460[5]) >>> 0;
    const sessionId = ((data460[6] << 8) | data460[7]) >>> 0;
    const storedCrc = (((data460[8] << 24) | (data460[9] << 16) | (data460[10] << 8) | data460[11]) >>> 0);

    // Verify CRC32
    const payloadPart = data460.subarray(12, 460);
    const computedCrc = crc32(payloadPart, crc32(data460.subarray(0, 8)));

    if (computedCrc !== storedCrc) {
      continue; // CRC mismatch
    }

    // Everything matches and CRC verified!
    matchedHeader = { ver, stripeIdx, phase, seed, K, sessionId };
    decodedData = data460;
    totalCorrected = r0.corrected + r1.corrected + r2.corrected;
    break;
  }

  if (!matchedHeader || !decodedData) {
    return { ok: false, error: 'RS_OR_CRC_FAILED' };
  }

  // Convert payload to Uint32Array(112)
  const payloadBytes = decodedData.subarray(12, 460);
  const payloadU32 = new Uint32Array(112);
  new Uint8Array(payloadU32.buffer).set(payloadBytes);

  return {
    ok: true,
    header: matchedHeader,
    payloadU32,
    corrected: totalCorrected
  };
}
