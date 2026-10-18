import { test, assert } from '../harness.js';
import { buildPacket, parsePacket } from '../../src/frame/packet.js';
import { PRNG } from '../../src/core/prng.js';

test('packet: build and parse round-trip', () => {
  const rng = new PRNG(4242);
  for (let trial = 0; trial < 20; trial++) {
    const header = {
      ver: 1,
      stripeIdx: trial % 4,
      phase: trial % 3,
      seed: rng.nextBelow(1000000),
      K: rng.nextBelow(5000) + 1,
      sessionId: rng.nextBelow(65536)
    };

    const payloadU32 = new Uint32Array(112);
    for (let w = 0; w < 112; w++) payloadU32[w] = rng.nextU32();

    const packet = buildPacket(header, payloadU32);
    assert.strictEqual(packet.length, 542);

    const parsed = parsePacket(packet, header.stripeIdx);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.corrected, 0);
    assert.strictEqual(parsed.header.stripeIdx, header.stripeIdx);
    assert.strictEqual(parsed.header.phase, header.phase);
    assert.strictEqual(parsed.header.seed, header.seed);
    assert.strictEqual(parsed.header.K, header.K);
    assert.strictEqual(parsed.header.sessionId, header.sessionId);
    assert.deepStrictEqual(parsed.payloadU32, payloadU32);
  }
});

test('packet: single-bit flips anywhere in packet are corrected', () => {
  const rng = new PRNG(8888);
  const header = { ver: 1, stripeIdx: 2, phase: 0, seed: 123, K: 10, sessionId: 99 };
  const payloadU32 = new Uint32Array(112);
  for (let w = 0; w < 112; w++) payloadU32[w] = rng.nextU32();

  const cleanPacket = buildPacket(header, payloadU32);

  // Test bit flips across various offsets
  for (const pos of [0, 5, 11, 12, 100, 300, 459, 460, 500, 541]) {
    const corrupted = new Uint8Array(cleanPacket);
    corrupted[pos] ^= 0x01; // flip 1 bit

    const res = parsePacket(corrupted, header.stripeIdx);
    assert.strictEqual(res.ok, true, `Failed to correct flip at byte ${pos}`);
    assert.ok(res.corrected >= 1);
    assert.deepStrictEqual(res.payloadU32, payloadU32);
  }
});

test('packet: recovers from 16 byte corruptions in codeword with soft byteMargins', () => {
  const rng = new PRNG(12345);
  const header = { ver: 1, stripeIdx: 0, phase: 1, seed: 999, K: 50, sessionId: 100 };
  const payloadU32 = new Uint32Array(112);
  for (let w = 0; w < 112; w++) payloadU32[w] = rng.nextU32();

  const cleanPacket = buildPacket(header, payloadU32);
  const corrupted = new Uint8Array(cleanPacket);
  const byteMargins = new Float32Array(542).fill(100.0);

  // Introduce 16 byte corruptions in codeword 0: 8 low-margin erasures and 8 unknown errors
  const cw0DataIndices = [];
  for (let i = 0; i < 460; i += 3) cw0DataIndices.push(i);

  const erasures = cw0DataIndices.slice(0, 8);
  const errors = cw0DataIndices.slice(8, 16);

  for (const pos of erasures) {
    corrupted[pos] ^= 0x55;
    byteMargins[pos] = 2.0; // low margin marks as erasure
  }
  for (const pos of errors) {
    corrupted[pos] ^= 0xAA;
  }

  // Without byteMargins, standard RS fails (16 errors > 14 budget)
  const failedWithoutMargins = parsePacket(corrupted, 0);
  assert.strictEqual(failedWithoutMargins.ok, false);

  // With byteMargins, soft erasures allow recovery of all 16 corruptions
  const res = parsePacket(corrupted, 0, byteMargins);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.corrected, 16);
  assert.deepStrictEqual(res.payloadU32, payloadU32);
});
