import { test, assert } from '../harness.js';
import { sampleStripeCells } from '../../src/vision/sampler.js';
import { renderFrame } from '../../src/frame/renderer.js';
import { solveHomography } from '../../src/vision/homography.js';
import { TimingRefiner } from '../../src/vision/timing.js';
import { PilotCalibrator } from '../../src/vision/pilots.js';
import { getLayout } from '../../src/frame/layout.js';
import { bytesToSymbols } from '../../src/core/bitpack.js';

test('sampler: exact symbol recovery from clean rendered frame', () => {
  const dummyPackets = [
    new Uint8Array(542),
    new Uint8Array(542),
    new Uint8Array(542),
    new Uint8Array(542)
  ];
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < 542; i++) {
      dummyPackets[s][i] = (s * 53 + i * 19) & 0xFF;
    }
  }

  const { width, height, rgba } = renderFrame(dummyPackets, { scale: 1 });

  const corners = [
    { x: 35, y: 35 },
    { x: 765, y: 35 },
    { x: 35, y: 765 },
    { x: 765, y: 765 }
  ];
  const H = solveHomography(corners);
  const timingRefiner = new TimingRefiner(rgba, width, height, H);
  const pilotCalibrator = new PilotCalibrator(rgba, width, height, H);
  const layout = getLayout();

  for (let s = 0; s < 4; s++) {
    const dataCells = layout.stripeDataCells[s];
    const res = sampleStripeCells(rgba, width, height, H, timingRefiner, pilotCalibrator, dataCells);
    assert.strictEqual(res.ok, true);

    const expectedSymbols = bytesToSymbols(dummyPackets[s], 1446);
    for (let i = 0; i < 1446; i++) {
      assert.strictEqual(res.symbols[i], expectedSymbols[i], `Symbol mismatch at stripe ${s}, cell ${i}`);
    }
  }
});
