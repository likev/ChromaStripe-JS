import { test, assert } from '../harness.js';
import { getCorpusFile } from '../../sim/corpus.js';
import { TxSession } from '../../src/session/txSession.js';
import { RxSession } from '../../src/session/rxSession.js';
import { FrameDecoder } from '../../src/vision/frameDecoder.js';

test('integration: e2e oracle transfer across corpus files C0-C5', async () => {
  const corpusIds = [
    'C0:0B',
    'C0:1B',
    'C0:448B',
    'C0:449B',
    'C1:64KB',
    'C2:text',
    'C3:zeros',
    'C5:unicode'
  ];

  for (const id of corpusIds) {
    const file = getCorpusFile(id);
    const tx = new TxSession(file.data, {
      fileName: file.name,
      mimeType: file.mime,
      scale: 1
    });
    await tx.init();

    const rx = new RxSession();
    const decoder = new FrameDecoder();

    let frameCount = 0;
    const maxFrames = Math.max(30, tx.K * 3);

    while (!rx.isComplete && frameCount < maxFrames) {
      const frame = tx.getNextFrame();
      const decRes = decoder.decode(frame.rgba, frame.width, frame.height);
      assert.strictEqual(decRes.ok, true, `Vision decode failed on frame ${frameCount}`);

      for (const stripe of decRes.stripes) {
        if (stripe.ok) {
          await rx.ingestPacket(stripe.header, stripe.payloadU32);
        }
      }
      frameCount++;
    }

    assert.strictEqual(rx.isComplete, true, `File ${id} failed to complete in ${frameCount} frames`);
    assert.strictEqual(rx.result.sha256Verified, true, `SHA-256 verification failed on ${id}`);
    assert.strictEqual(rx.result.data.length, file.data.length, `Length mismatch on ${id}`);
    assert.deepStrictEqual(rx.result.data, file.data, `Data mismatch on ${id}`);
  }
});
