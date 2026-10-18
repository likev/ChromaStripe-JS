/**
 * RX Web Worker: Runs vision pipeline, RS/CRC decoding, and session reassembly.
 */

import { FrameDecoder } from '../../src/vision/frameDecoder.js';
import { RxSession } from '../../src/session/rxSession.js';

let decoder = new FrameDecoder();
let rxSession = new RxSession();

self.onmessage = async (e) => {
  try {
    const { type, rgba, width, height } = e.data;

    if (type === 'reset') {
      decoder = new FrameDecoder();
      rxSession.reset();
      self.postMessage({ type: 'reset_done' });
      return;
    }

    if (type === 'decode_frame') {
      const t0 = performance.now();
      const decRes = decoder.decode(rgba, width, height);
      const decodeMs = performance.now() - t0;

      let validCount = 0;
      if (decRes.ok) {
        for (const stripe of decRes.stripes) {
          if (stripe.ok) {
            validCount++;
            await rxSession.ingestPacket(stripe.header, stripe.payloadU32);
          }
        }
      }

      const progress = rxSession.getProgress();

      if (rxSession.isComplete) {
        self.postMessage({
          type: 'complete',
          result: rxSession.result,
          corners: decRes.corners,
          stripes: decRes.stripes,
          progress,
          decodeMs
        });
      } else {
        self.postMessage({
          type: 'frame_result',
          ok: decRes.ok,
          corners: decRes.corners,
          stripes: decRes.stripes,
          progress,
          decodeMs
        });
      }
    }
  } catch (err) {
    console.error('rx-worker error:', err);
    self.postMessage({
      type: 'error',
      error: err.message || String(err)
    });
  }
};
