import { test, assert } from '../harness.js';
import { getCorpusFile } from '../../sim/corpus.js';
import { TxSession } from '../../src/session/txSession.js';
import { RxSession } from '../../src/session/rxSession.js';
import { ErasureChannel } from '../../sim/channels/erasure.js';
import { SymbolChannel } from '../../sim/channels/symbol.js';
import { parsePacket } from '../../src/frame/packet.js';
import { SyntheticCamera } from '../../sim/camera/index.js';
import { FrameDecoder } from '../../src/vision/frameDecoder.js';
import fs from 'node:fs';
import path from 'node:path';

test('integration: L0 erasure channels (Bernoulli, Gilbert-Elliott, Stuck-Tear) recover bit-exact', async () => {
  const file = getCorpusFile('C1:64KB');

  for (const model of ['bernoulli', 'gilbert-elliott', 'stuck-tear']) {
    const channel = new ErasureChannel({ model, lossProb: 0.20, seed: 101 });
    const tx = new TxSession(file.data, { fileName: file.name });
    await tx.init();

    const rx = new RxSession();
    let frameNo = 0;

    while (!rx.isComplete && frameNo < 250) {
      const frame = tx.getNextFrame();
      for (let s = 0; s < 4; s++) {
        if (channel.transmit(s, frameNo)) {
          const parsed = parsePacket(frame.packets[s], s);
          if (parsed.ok) {
            await rx.ingestPacket(parsed.header, parsed.payloadU32);
          }
        }
      }
      frameNo++;
    }

    assert.strictEqual(rx.isComplete, true, `L0 model ${model} failed to complete`);
    assert.strictEqual(rx.result.sha256Verified, true);
    assert.deepStrictEqual(rx.result.data, file.data);
  }
});

test('integration: L1 symbol channel with bit errors recovers via RS', async () => {
  const file = getCorpusFile('C0:448B');
  const channel = new SymbolChannel({ ber: 0.005, seed: 202 });
  const tx = new TxSession(file.data, { fileName: file.name });
  await tx.init();

  const rx = new RxSession();
  let frameNo = 0;

  while (!rx.isComplete && frameNo < 30) {
    const frame = tx.getNextFrame();
    for (let s = 0; s < 4; s++) {
      const noisyPacket = channel.corruptPacket(frame.packets[s]);
      const parsed = parsePacket(noisyPacket, s);
      if (parsed.ok) {
        await rx.ingestPacket(parsed.header, parsed.payloadU32);
      }
    }
    frameNo++;
  }

  assert.strictEqual(rx.isComplete, true);
  assert.strictEqual(rx.result.sha256Verified, true);
  assert.deepStrictEqual(rx.result.data, file.data);
});

test('integration: L2 synthetic camera e2e transfer completes bit-exact across presets', async () => {
  const file = getCorpusFile('C0:448B');
  const presets = ['ideal', 'indoor-typical', 'indoor-handheld', 'outdoor-glare', 'portrait-hold'];

  for (const preset of presets) {
    const scPath = path.resolve(`sim/scenarios/${preset}.json`);
    const sc = JSON.parse(fs.readFileSync(scPath, 'utf8'));
    const cam = new SyntheticCamera(sc);
    const tx = new TxSession(file.data, { fileName: file.name, scale: 1 });
    await tx.init();

    const rx = new RxSession();
    const frameDecoder = new FrameDecoder();
    const txFrames = new Map();

    let f = 0;
    while (!rx.isComplete && f < 25) {
      if (!txFrames.has(f)) txFrames.set(f, tx.getNextFrame());
      const tC = f * (1000 / cam.fps);
      const camFrame = cam.captureFrame(tC, txFrames);
      const decRes = frameDecoder.decode(camFrame.rgba, camFrame.width, camFrame.height);
      if (decRes.ok) {
        for (const stripe of decRes.stripes) {
          if (stripe.ok) {
            await rx.ingestPacket(stripe.header, stripe.payloadU32);
          }
        }
      }
      f++;
    }

    assert.strictEqual(rx.isComplete, true, `Preset ${preset} failed to complete`);
    assert.strictEqual(rx.result.sha256Verified, true, `SHA-256 verification failed on ${preset}`);
    assert.deepStrictEqual(rx.result.data, file.data, `Data mismatch on ${preset}`);
  }
});

