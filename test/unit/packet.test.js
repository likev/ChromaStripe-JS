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
