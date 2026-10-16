import { test, assert } from '../harness.js';
import { TxSession } from '../../src/session/txSession.js';
import { RxSession } from '../../src/session/rxSession.js';
import { FrameDecoder } from '../../src/vision/frameDecoder.js';

test('rxSession: end-to-end transmit, vision decode, and exact SHA-256 reconstruction', async () => {
  const originalStr = 'The quick brown fox jumps over the lazy dog! '.repeat(30);
  const originalBytes = new TextEncoder().encode(originalStr);

  const tx = new TxSession(originalBytes, {
    fileName: 'fox.txt',
    mimeType: 'text/plain',
    scale: 1
  });
  await tx.init();

  const rx = new RxSession();
  const frameDecoder = new FrameDecoder();

  let framesProcessed = 0;
  while (!rx.isComplete && framesProcessed < 50) {
    const frame = tx.getNextFrame();
    const decRes = frameDecoder.decode(frame.rgba, frame.width, frame.height);
    assert.strictEqual(decRes.ok, true);

    for (const stripe of decRes.stripes) {
      if (stripe.ok) {
        await rx.ingestPacket(stripe.header, stripe.payloadU32);
      }
    }
    framesProcessed++;
  }

  assert.strictEqual(rx.isComplete, true);
  assert.ok(rx.result !== null);
  assert.strictEqual(rx.result.fileName, 'fox.txt');
  assert.strictEqual(rx.result.mimeType, 'text/plain');
  assert.strictEqual(rx.result.sha256Verified, true);

  const decodedStr = new TextDecoder().decode(rx.result.data);
  assert.strictEqual(decodedStr, originalStr);
});
