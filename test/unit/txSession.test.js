import { test, assert } from '../harness.js';
import { TxSession } from '../../src/session/txSession.js';

test('txSession: initializes and yields frames with 4 valid packets', async () => {
  const dummyData = new TextEncoder().encode('Hello ChromaStripe!'.repeat(50));
  const tx = new TxSession(dummyData, { fileName: 'hello.txt' });

  await tx.init();
  assert.strictEqual(tx.isInitialized, true);
  assert.ok(tx.K >= 1);
  assert.ok(tx.sessionId > 0);

  const frame0 = tx.getNextFrame();
  assert.strictEqual(frame0.frameNo, 0);
  assert.deepStrictEqual(frame0.seeds, [0, 1, 2, 3]);
  assert.strictEqual(frame0.packets.length, 4);
  assert.strictEqual(frame0.width, 800);
  assert.strictEqual(frame0.height, 800);
  assert.strictEqual(frame0.rgba.length, 800 * 800 * 4);

  const frame1 = tx.getNextFrame();
  assert.strictEqual(frame1.frameNo, 1);
  assert.deepStrictEqual(frame1.seeds, [4, 5, 6, 7]);
});

test('txSession: supports configurable corePx and guardPx', async () => {
  const dummyData = new TextEncoder().encode('Configurable corePx test data'.repeat(10));
  
  // Test corePx = 5, guardPx = 1 -> cellPx = 7 -> 560x560
  const tx5 = new TxSession(dummyData, { corePx: 5, guardPx: 1 });
  await tx5.init();
  const f5 = tx5.getNextFrame();
  assert.strictEqual(f5.width, 560);
  assert.strictEqual(f5.height, 560);
  assert.strictEqual(f5.cellPx, 7);
  assert.strictEqual(f5.corePx, 5);
  assert.strictEqual(f5.guardPx, 1);
  assert.strictEqual(f5.rgba.length, 560 * 560 * 4);

  // Test corePx = 6, default guardPx = 1 -> cellPx = 8 -> 640x640
  const tx6 = new TxSession(dummyData, { corePx: 6 });
  await tx6.init();
  const f6 = tx6.getNextFrame();
  assert.strictEqual(f6.width, 640);
  assert.strictEqual(f6.height, 640);
  assert.strictEqual(f6.cellPx, 8);
  assert.strictEqual(f6.corePx, 6);
  assert.strictEqual(f6.guardPx, 1);
  assert.strictEqual(f6.rgba.length, 640 * 640 * 4);

  // Test corePx = 7 -> cellPx = 9 -> 720x720 (fits 768p in fullscreen)
  const tx7 = new TxSession(dummyData, { corePx: 7 });
  await tx7.init();
  const f7 = tx7.getNextFrame();
  assert.strictEqual(f7.width, 720);
  assert.strictEqual(f7.height, 720);
  assert.strictEqual(f7.cellPx, 9);
  assert.strictEqual(f7.corePx, 7);
  assert.strictEqual(f7.rgba.length, 720 * 720 * 4);

  // Test dynamic corePx update mid-stream
  tx7.corePx = 4;
  const f4 = tx7.getNextFrame();
  assert.strictEqual(f4.width, 480);
  assert.strictEqual(f4.height, 480);
  assert.strictEqual(f4.cellPx, 6);
  assert.strictEqual(f4.corePx, 4);
  assert.strictEqual(f4.rgba.length, 480 * 480 * 4);
});
