import { test, assert } from '../harness.js';
import { computeAutoCorePx, getDimensionsForCorePx, TxCanvasRenderer } from '../../web/js/tx-render.js';
import { TxSession } from '../../src/session/txSession.js';
import { RxSession } from '../../src/session/rxSession.js';
import { FrameDecoder } from '../../src/vision/frameDecoder.js';

test('txRender: getDimensionsForCorePx computes correct grid dimensions', () => {
  // guardPx default = 1, GRID_SIZE = 80
  const d5 = getDimensionsForCorePx(5);
  assert.strictEqual(d5.corePx, 5);
  assert.strictEqual(d5.guardPx, 1);
  assert.strictEqual(d5.cellPx, 7);
  assert.strictEqual(d5.dim, 560);

  const d6 = getDimensionsForCorePx(6);
  assert.strictEqual(d6.corePx, 6);
  assert.strictEqual(d6.cellPx, 8);
  assert.strictEqual(d6.dim, 640);

  const d7 = getDimensionsForCorePx(7);
  assert.strictEqual(d7.corePx, 7);
  assert.strictEqual(d7.cellPx, 9);
  assert.strictEqual(d7.dim, 720);

  const d8 = getDimensionsForCorePx(8);
  assert.strictEqual(d8.corePx, 8);
  assert.strictEqual(d8.cellPx, 10);
  assert.strictEqual(d8.dim, 800);
});

test('txRender: computeAutoCorePx on 1366x768 display fits without scrolling', () => {
  // Fullscreen on 1366x768:
  // With 40px quiet-zone padding, available height is 768 - 40 = 728.
  // floor(728 / 80) = 9 -> cellPx 9 -> corePx 7 (720x720 canvas, 760 with padding <= 768).
  const fsCore = computeAutoCorePx({
    viewportWidth: 1366,
    viewportHeight: 768,
    isFullscreen: true,
    containerPadding: 40
  });
  assert.strictEqual(fsCore, 7);
  const fsDim = getDimensionsForCorePx(fsCore);
  assert.strictEqual(fsDim.dim, 720);
  assert.ok(fsDim.dim + 40 <= 768);

  // Windowed mode on 1366x768 (browser viewport ~650px):
  // Should compute integer corePx <= 5 (fits windowed height without scrolling)
  const winCore = computeAutoCorePx({
    viewportWidth: 1366,
    viewportHeight: 650,
    isFullscreen: false,
    containerPadding: 40
  });
  assert.ok(winCore <= 5);
  assert.ok(winCore >= 3);
  const winDim = getDimensionsForCorePx(winCore);
  assert.ok(winDim.dim <= 560);
});

test('txRender: computeAutoCorePx on 1920x1080 display', () => {
  // Fullscreen on 1080p:
  const fsCore = computeAutoCorePx({
    viewportWidth: 1920,
    viewportHeight: 1080,
    isFullscreen: true,
    containerPadding: 40
  });
  assert.ok(fsCore >= 8);
  const fsDim = getDimensionsForCorePx(fsCore);
  assert.ok(fsDim.dim + 40 <= 1080);
});

test('txRender: TxCanvasRenderer adapts to dynamic frame dimensions', () => {
  const dummyCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      imageSmoothingEnabled: false,
      createImageData: (w, h) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4)
      }),
      putImageData: () => {}
    })
  };

  const renderer = new TxCanvasRenderer(dummyCanvas, 1);
  assert.strictEqual(dummyCanvas.width, 800);
  assert.strictEqual(dummyCanvas.height, 800);
  assert.strictEqual(renderer.dim, 800);

  // Resize manually
  renderer.setSize(640);
  assert.strictEqual(dummyCanvas.width, 640);
  assert.strictEqual(dummyCanvas.height, 640);
  assert.strictEqual(renderer.dim, 640);

  // displayFrame with 560x560 buffer triggers dynamic resize
  const rgba560 = new Uint8ClampedArray(560 * 560 * 4);
  renderer.displayFrame(rgba560, 560, 560);
  assert.strictEqual(dummyCanvas.width, 560);
  assert.strictEqual(dummyCanvas.height, 560);
  assert.strictEqual(renderer.dim, 560);
});

test('txRender: end-to-end transmit and decode across 3px, 4px, 5px, 6px, 7px, and 8px core sizes', async () => {
  const payloadStr = 'ChromaStripe configurable core size validation message!';
  const payloadBytes = new TextEncoder().encode(payloadStr);

  for (const corePx of [3, 4, 5, 6, 7, 8]) {
    const tx = new TxSession(payloadBytes, { fileName: `test_${corePx}.txt`, corePx });
    await tx.init();

    const rx = new RxSession();
    const decoder = new FrameDecoder();

    let framesProcessed = 0;
    while (!rx.isComplete && framesProcessed < 40) {
      const frame = tx.getNextFrame();
      const decRes = decoder.decode(frame.rgba, frame.width, frame.height);
      assert.strictEqual(decRes.ok, true, `Decode failed for corePx ${corePx}`);

      for (const stripe of decRes.stripes) {
        if (stripe.ok) {
          await rx.ingestPacket(stripe.header, stripe.payloadU32);
        }
      }
      framesProcessed++;
    }

    assert.strictEqual(rx.isComplete, true, `Session did not complete for corePx ${corePx}`);
    assert.strictEqual(rx.result.sha256Verified, true);
    const resultStr = new TextDecoder().decode(rx.result.data);
    assert.strictEqual(resultStr, payloadStr);
  }
});

test('txRender: renderer correctly computes corePx when cellPx is provided alone', async () => {
  const { renderFrame } = await import('../../src/frame/renderer.js');
  const dummyPackets = [new Uint8Array(542), new Uint8Array(542), new Uint8Array(542), new Uint8Array(542)];
  
  // cellPx = 7 alone with default guardPx = 1 should yield corePx = 5
  const res = renderFrame(dummyPackets, { cellPx: 7 });
  assert.strictEqual(res.width, 560);
  assert.strictEqual(res.height, 560);
  assert.strictEqual(res.cellPx, 7);
  assert.strictEqual(res.guardPx, 1);
  assert.strictEqual(res.corePx, 5);
  assert.strictEqual(res.rgba.length, 560 * 560 * 4);
});

test('txRender: renderer safely handles mismatched outRgba length', async () => {
  const { renderFrame } = await import('../../src/frame/renderer.js');
  const dummyPackets = [new Uint8Array(542), new Uint8Array(542), new Uint8Array(542), new Uint8Array(542)];

  // Pass an 800x800 outRgba buffer to a 560x560 render
  const mismatchedBuffer = new Uint8ClampedArray(800 * 800 * 4);
  const res = renderFrame(dummyPackets, { corePx: 5, outRgba: mismatchedBuffer });
  assert.strictEqual(res.width, 560);
  assert.strictEqual(res.rgba.length, 560 * 560 * 4);
  // It did not corrupt the mismatched buffer length
  assert.strictEqual(res.rgba !== mismatchedBuffer, true);
});
