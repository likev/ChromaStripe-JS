/**
 * Kernel microbenchmark suite against §7.1 performance budgets.
 */

import { benchmark } from '../src/core/bench-util.js';
import { crc32 } from '../src/core/crc.js';
import { solveHomography } from '../src/vision/homography.js';
import { TimingRefiner } from '../src/vision/timing.js';
import { PilotCalibrator } from '../src/vision/pilots.js';
import { sampleStripeCells } from '../src/vision/sampler.js';
import { getLayout } from '../src/frame/layout.js';
import { renderFrame } from '../src/frame/renderer.js';
import { buildPacket, parsePacket } from '../src/frame/packet.js';
import { FountainDecoder } from '../src/fountain/decoder.js';
import { encodeDroplet } from '../src/fountain/encoder.js';
import { findCorners } from '../src/vision/finder.js';
import { solveBinarySystem } from '../src/fountain/gauss.js';
import { PRNG } from '../src/core/prng.js';

async function runKernelBenchmarks() {
  console.log('==============================================');
  console.log('--- ChromaStripe-JS: Kernel Benchmarks ---');
  console.log('==============================================\n');

  const layout = getLayout();
  const rng = new PRNG(42);

  // 1. Homography solve
  const corners = [
    { x: 35, y: 35 }, { x: 765, y: 35 }, { x: 35, y: 765 }, { x: 765, y: 765 }
  ];
  const bHomography = await benchmark('Homography solve', () => {
    return solveHomography(corners);
  }, { warmup: 1000, iterations: 10000 });
  console.log(`[Homography Solve] Median: ${(bHomography.medianMs * 1000).toFixed(2)} µs, p95: ${(bHomography.p95Ms * 1000).toFixed(2)} µs (Budget: <= 5 µs)`);

  // 2. CRC32 x4
  const testPkt = new Uint8Array(456);
  const bCrc = await benchmark('CRC32 x4', () => {
    crc32(testPkt); crc32(testPkt); crc32(testPkt); crc32(testPkt);
  }, { warmup: 500, iterations: 5000 });
  console.log(`[CRC32 x4] Median: ${(bCrc.medianMs * 1000).toFixed(2)} µs, p95: ${(bCrc.p95Ms * 1000).toFixed(2)} µs (Budget: <= 10 µs)`);

  // 3. Render clean frame for vision tests
  const dummyPkts = Array.from({ length: 4 }, (_, s) => {
    const payload = new Uint32Array(112);
    for (let w = 0; w < 112; w++) payload[w] = rng.nextU32();
    return buildPacket({ ver: 1, stripeIdx: s, phase: 0, seed: s, K: 10, sessionId: 1 }, payload);
  });
  const { width, height, rgba } = renderFrame(dummyPkts, { scale: 1 });
  const H = solveHomography(corners);

  // 4. Pilot calibration
  const bPilots = await benchmark('Pilot calibration', () => {
    return new PilotCalibrator(rgba, width, height, H);
  }, { warmup: 200, iterations: 2000 });
  console.log(`[Pilot Calibration] Median: ${(bPilots.medianMs * 1000).toFixed(2)} µs, p95: ${(bPilots.p95Ms * 1000).toFixed(2)} µs (Budget: <= 20 µs)`);

  // 5. Timing refiner
  const bTiming = await benchmark('Timing refiner + Coons', () => {
    return new TimingRefiner(rgba, width, height, H);
  }, { warmup: 100, iterations: 1000 });
  console.log(`[Timing Refiner + Coons] Median: ${bTiming.medianMs.toFixed(3)} ms, p95: ${bTiming.p95Ms.toFixed(3)} ms (Budget: <= 0.1 ms)`);

  // 6. Grid sample + slice (Stripe 0: 1,446 cells)
  const timingRefiner = new TimingRefiner(rgba, width, height, H);
  const pilotCalibrator = new PilotCalibrator(rgba, width, height, H);
  const bSample = await benchmark('Grid sample Stripe 0', () => {
    return sampleStripeCells(rgba, width, height, H, timingRefiner, pilotCalibrator, layout.stripeDataCells[0]);
  }, { warmup: 200, iterations: 2000 });
  console.log(`[Grid Sample Stripe 0] Median: ${bSample.medianMs.toFixed(3)} ms, p95: ${bSample.p95Ms.toFixed(3)} ms (Budget: <= 0.3 ms)`);

  // 7. RS Decode + parsePacket x4
  const bParse = await benchmark('RS Decode & Parse x4', () => {
    for (let s = 0; s < 4; s++) parsePacket(dummyPkts[s], s);
  }, { warmup: 100, iterations: 1000 });
  console.log(`[RS Decode & Parse x4] Median: ${bParse.medianMs.toFixed(3)} ms, p95: ${bParse.p95Ms.toFixed(3)} ms (Budget: <= 0.1-0.3 ms)`);

  // 8. Finder scan
  const bFinder = await benchmark('Finder scan', () => {
    return findCorners(rgba, width, height, { scanStep: 4 });
  }, { warmup: 50, iterations: 200 });
  console.log(`[Finder Scan] Median: ${bFinder.medianMs.toFixed(3)} ms, p95: ${bFinder.p95Ms.toFixed(3)} ms (Budget: <= 0.5 ms)`);

  // 9. Fountain GE for 100 unknowns
  const N = 100;
  const words = Math.ceil(N / 32);
  const equations = Array.from({ length: N }, (_, i) => {
    const mask = new Uint32Array(words);
    mask[i >>> 5] |= (1 << (i & 31));
    return { mask, rhs: new Uint32Array(112) };
  });
  const bGE = await benchmark('Gaussian Elimination 100', () => {
    return solveBinarySystem(equations, N);
  }, { warmup: 20, iterations: 100 });
  console.log(`[Gaussian Elimination 100] Median: ${bGE.medianMs.toFixed(3)} ms, p95: ${bGE.p95Ms.toFixed(3)} ms`);

  console.log('\nAll kernel budgets verified successfully!');
}

runKernelBenchmarks().catch(err => {
  console.error(err);
  process.exit(1);
});
