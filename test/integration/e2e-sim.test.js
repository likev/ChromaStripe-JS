import { test, assert } from '../harness.js';
import { getCorpusFile } from '../../sim/corpus.js';
import { TxSession } from '../../src/session/txSession.js';
import { RxSession } from '../../src/session/rxSession.js';
import { ErasureChannel } from '../../sim/channels/erasure.js';
import { SymbolChannel } from '../../sim/channels/symbol.js';
import { parsePacket } from '../../src/frame/packet.js';

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
