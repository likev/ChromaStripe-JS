/**
 * Packet framing, serialization, RS interleaving, CRC32, and scrambling.
 */

import {
  PACKET_TOTAL_BYTES,
  HEADER_BYTES,
  PAYLOAD_BYTES,
  RS_PARITY_BYTES,
  PROTOCOL_VERSION
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
export function buildPacket(header, payloadU32, outPacket) {
  const packet = outPacket || new Uint8Array(PACKET_TOTAL_BYTES);
  const ver = header.ver ?? PROTOCOL_VERSION;
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

export function parsePacket(rawBytes, expectedStripeIdx = -1, byteMargins = null) {
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
