import { test, assert } from '../harness.js';
import { PRNG } from '../../src/core/prng.js';
import { crc32, crc16 } from '../../src/core/crc.js';
import { rsEncode } from '../../src/core/reedsolomon.js';
import { sha256Sync, toHex } from '../../src/core/sha256.js';
import { buildPacket } from '../../src/frame/packet.js';
import { renderFrame } from '../../src/frame/renderer.js';
import fs from 'node:fs';
import path from 'node:path';

test('golden: vectors match stored constants exactly', () => {
  const vectorsPath = path.resolve('test/golden/vectors.json');
  const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

  // 1. PRNG sequence hash
  const rng = new PRNG(12345);
  const prngBytes = new Uint8Array(100);
  for (let i = 0; i < 100; i++) prngBytes[i] = rng.nextBelow(256);
  const prngHash = toHex(sha256Sync(prngBytes));
  assert.strictEqual(prngHash, vectors.prngHash);

  // 2. CRCs
  const testData = new TextEncoder().encode('ChromaStripe-JS-Golden-Test');
  assert.strictEqual(crc32(testData), vectors.c32);
  assert.strictEqual(crc16(testData), vectors.c16);

  // 3. RS Parity
  const rsData = new Uint8Array(154);
  for (let i = 0; i < 154; i++) rsData[i] = i;
  const parity = Array.from(rsEncode(rsData, 28));
  assert.deepStrictEqual(parity, vectors.rsParity28);

  // 4. Packet Hash
  const payloadU32 = new Uint32Array(112);
  for (let i = 0; i < 112; i++) payloadU32[i] = i * 0x1020304 + 7;
  const pkt = buildPacket({ ver: 1, stripeIdx: 0, phase: 0, seed: 10, K: 50, sessionId: 0xABCD }, payloadU32);
  assert.strictEqual(toHex(sha256Sync(pkt)), vectors.pktHash);

  // 5. Frame Hash
  const pkts = [pkt, pkt, pkt, pkt];
  const { rgba } = renderFrame(pkts, { scale: 1, rotation: 0 });
  const frameHash = toHex(sha256Sync(new Uint8Array(rgba.buffer)));
  assert.strictEqual(frameHash, vectors.frameHash);
});
