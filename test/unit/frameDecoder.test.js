import { test, assert } from '../harness.js';
import { FrameDecoder } from '../../src/vision/frameDecoder.js';
import { TxSession } from '../../src/session/txSession.js';

test('frameDecoder: decodes 100% of stripes on clean TX frame', async () => {
  const dummyData = new TextEncoder().encode('Testing FrameDecoder end-to-end vision pipeline!'.repeat(20));
  const tx = new TxSession(dummyData, { scale: 1 });
  await tx.init();

  const frame = tx.getNextFrame();
  const decoder = new FrameDecoder();

  const res = decoder.decode(frame.rgba, frame.width, frame.height);
  assert.strictEqual(res.ok, true);
  assert.ok(res.corners !== undefined);
  assert.strictEqual(res.stripes.length, 4);

  for (let s = 0; s < 4; s++) {
    const stripe = res.stripes[s];
    assert.strictEqual(stripe.ok, true, `Stripe ${s} failed decode: ${stripe.error}`);
    assert.strictEqual(stripe.header.stripeIdx, s);
    assert.strictEqual(stripe.header.seed, frame.seeds[s]);
  }
});
