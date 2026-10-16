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
