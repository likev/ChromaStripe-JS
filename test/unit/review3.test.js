import { test, assert } from '../harness.js';
import { TxSession } from '../../src/session/txSession.js';
import { RxSession } from '../../src/session/rxSession.js';
import { FrameDecoder } from '../../src/vision/frameDecoder.js';
import { getLayoutV2 } from '../../src/frame/layout.js';
import { unmixLinearCrosstalk, sliceCell4Pam } from '../../src/vision/sampler.js';
import { FountainDecoder } from '../../src/fountain/decoder.js';
import { getDropletIndices } from '../../src/fountain/schedule.js';

const SAMPLE = new TextEncoder().encode('ChromaStripe review3 regression payload. '.repeat(40));

test('review3 #1: v1 TxSession ignores v2-only options (bitsPerCell/gridSize/numStripes)', () => {
  const tx = new TxSession(SAMPLE, { version: 1, bitsPerCell: 6, gridSize: 96, numStripes: 8 });
  assert.strictEqual(tx.bitsPerCell, 3);
  assert.strictEqual(tx.gridSize, 80);
  assert.strictEqual(tx.numStripes, 4);
});

test('review3 #1: v1 sent with stale 6-bit option still decodes in auto mode', async () => {
  const tx = new TxSession(SAMPLE, { version: 1, bitsPerCell: 6, gridSize: 96 });
  await tx.init();
  const dec = new FrameDecoder({ version: 'auto', gridSize: 'auto' });
  const frame = tx.getNextFrame();
  const res = dec.decode(frame.rgba, frame.width, frame.height);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.stats.version, 1);
  assert.strictEqual(res.stats.validStripesCount, 4);
});

test('review3 #2: linear crosstalk unmix is identity on gray and default slicing is unchanged', () => {
  for (const v of [0, 40, 112, 184, 255]) {
    const [r, g, b] = unmixLinearCrosstalk(v, v, v, 0.08);
    assert.ok(Math.abs(r - v) < 1e-6 && Math.abs(g - v) < 1e-6 && Math.abs(b - v) < 1e-6);
  }
  const t = [76, 148, 220, 76, 148, 220, 76, 148, 220];
  // R=L0 bleeding to 150 when G is bright: only unmixing pulls it back below Tr01.
  const noUnmix = sliceCell4Pam(150, 255, 40, t);
  const withUnmix = sliceCell4Pam(110, 255, 40, t, 0.14);
  assert.notStrictEqual((noUnmix.sym >> 4) & 3, 0, 'bleed reads as a higher level without unmixing');
  assert.strictEqual((withUnmix.sym >> 4) & 3, 0, 'unmixing restores R=L0');
});

test('review3 #4: v2 stripes are data-balanced and every stripe fits a 254B packet at 3 bits/cell (80x80)', () => {
  for (const g of [80, 96, 112]) {
    const layout = getLayoutV2({ gridSize: g, numStripes: 8 });
    const counts = layout.stripeDataCells.map(c => c.length);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    assert.ok(max - min <= Math.ceil(0.2 * max), `grid ${g} stripes balanced: ${counts}`);
    if (g === 80) assert.ok(min * 3 >= 254 * 8, `80x80 stripes hold a 254B packet at 3 bpc (min cells ${min})`);
    // every data cell is assigned exactly once and stripes cover contiguous rows
    let prevEnd = -1;
    for (const [rs, re] of layout.stripeRows) {
      assert.strictEqual(rs, prevEnd + 1);
      prevEnd = re;
    }
    assert.strictEqual(prevEnd, g - 1);
  }
});

test('review3 #4: auto-Turbo picks dual codewords only when every stripe fits one', () => {
  const t6 = new TxSession(SAMPLE, { version: 2, gridSize: 80, bitsPerCell: 6 });
  assert.strictEqual(t6.payloadBytes, 448);
  const t3 = new TxSession(SAMPLE, { version: 2, gridSize: 80, bitsPerCell: 3 });
  assert.strictEqual(t3.payloadBytes, 224);
  const off = new TxSession(SAMPLE, { version: 2, gridSize: 80, bitsPerCell: 6, turbo: false });
  assert.strictEqual(off.payloadBytes, 224);
});

test('review3 #4/#5: v2 3-bit (2-PAM) mode round-trips on 80x80 through auto-detect', async () => {
  const tx = new TxSession(SAMPLE, { version: 2, gridSize: 80, bitsPerCell: 3 });
  await tx.init();
  const rx = new RxSession();
  const dec = new FrameDecoder({ version: 'auto', gridSize: 'auto' });
  let n = 0;
  while (!rx.isComplete && n < 40) {
    const frame = tx.getNextFrame();
    const res = dec.decode(frame.rgba, frame.width, frame.height);
    assert.strictEqual(res.ok, true, `frame ${n} decodes`);
    assert.strictEqual(res.stats.version, 2);
    for (const s of res.stripes) if (s && s.ok) await rx.ingestPacket(s.header, s.payloadU32);
    n++;
  }
  assert.strictEqual(rx.isComplete, true);
  assert.strictEqual(new TextDecoder().decode(rx.result.data), new TextDecoder().decode(SAMPLE));
});

test('review3 #5: v2 6-bit 4-PAM frames are never mistaken for v1 in auto mode', async () => {
  const tx = new TxSession(SAMPLE, { version: 2, gridSize: 80, bitsPerCell: 6 });
  await tx.init();
  const dec = new FrameDecoder({ version: 'auto', gridSize: 'auto' });
  const frame = tx.getNextFrame();
  const res = dec.decode(frame.rgba, frame.width, frame.height);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.stats.version, 2);
  assert.strictEqual(res.stats.validStripesCount, 8);
});

test('review3 #9: legacy Phase-3 degree distribution is still decodable via legacyDegree', () => {
  const K = 40;
  const words = 4;
  const blocks = Array.from({ length: K }, (_, i) => Uint32Array.from({ length: words }, (_, w) => (i * 2654435761 + w * 97) >>> 0));
  const encodeLegacy = (seed) => {
    const out = new Uint32Array(words);
    for (const idx of getDropletIndices(seed, K, 0.15, true)) for (let w = 0; w < words; w++) out[w] ^= blocks[idx][w];
    return out;
  };
  const dec = new FountainDecoder(K, { legacyDegree: true });
  for (let seed = 0; seed < K * 4 && !dec.isComplete(); seed++) dec.addDroplet(seed, encodeLegacy(seed));
  assert.strictEqual(dec.isComplete(), true);
  const bytes = dec.getReconstructedBytes();
  assert.strictEqual(bytes.length, K * words * 4);
});
