/**
 * End-to-end throughput and frame processing benchmark.
 */

import { TxSession } from '../src/session/txSession.js';
import { RxSession } from '../src/session/rxSession.js';
import { FrameDecoder } from '../src/vision/frameDecoder.js';
import { getCorpusFile } from '../sim/corpus.js';

async function runE2EBenchmark() {
  console.log('\n=============================================');
  console.log('--- ChromaStripe-JS: E2E Throughput Bench ---');
  console.log('=============================================\n');

  const file = getCorpusFile('C1:64KB');
  const tx = new TxSession(file.data, { fileName: file.name, scale: 1 });
  await tx.init();

  const rx = new RxSession();
  const decoder = new FrameDecoder();

  const tStart = performance.now();
  let framesCount = 0;
  let totalDecodeMs = 0;

  while (!rx.isComplete && framesCount < 100) {
    const frame = tx.getNextFrame();

    const t0 = performance.now();
    const decRes = decoder.decode(frame.rgba, frame.width, frame.height);
    totalDecodeMs += (performance.now() - t0);

    if (decRes.ok) {
      for (const stripe of decRes.stripes) {
        if (stripe.ok) {
          await rx.ingestPacket(stripe.header, stripe.payloadU32);
        }
      }
    }
    framesCount++;
  }

  const elapsedSec = (performance.now() - tStart) / 1000.0;
  const netKB = file.data.length / 1024.0;
  const throughputKBps = netKB / elapsedSec;
  const meanFrameMs = totalDecodeMs / framesCount;

  console.log(`Transferred ${netKB.toFixed(1)} KB in ${framesCount} frames (${elapsedSec.toFixed(2)}s)`);
  console.log(`Mean Vision Decode per frame: ${meanFrameMs.toFixed(2)} ms (Budget: <= 1.5 ms)`);
  console.log(`Simulated Incompressible Throughput: ${throughputKBps.toFixed(1)} KB/s`);
  console.log(`SHA-256 Verified: ${rx.result.sha256Verified}`);
}

runE2EBenchmark().catch(err => {
  console.error(err);
  process.exit(1);
});
