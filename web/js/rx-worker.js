/**
 * RX Web Worker: Runs vision pipeline, RS/CRC decoding, and session reassembly.
 * Supports worker pooling with hint corners and zero-copy ImageBitmap offscreen readback.
 */

import { FrameDecoder } from '../../src/vision/frameDecoder.js';
import { RxSession } from '../../src/session/rxSession.js';

let decoder = new FrameDecoder();
let rxSession = new RxSession();
let offscreen = null;
let offCtx = null;

self.onmessage = async (e) => {
  try {
    const { type } = e.data;

    if (type === 'reset') {
      decoder = new FrameDecoder();
      rxSession.reset();
      self.postMessage({ type: 'reset_done' });
      return;
    }

    if (type === 'set_options') {
      const { version, gridSize } = e.data;
      decoder.setOptions({ version, gridSize });
      self.postMessage({ type: 'options_set' });
      return;
    }

    if (type === 'decode_frame') {
      const { roi, hintCorners, frameId, workerId, poolMode, sessionId } = e.data;
      let { rgba, width, height } = e.data;

      // In pool mode, synchronize tracking corners from coordinator's latest priors
      if (poolMode) {
        if (hintCorners && hintCorners.TL && hintCorners.TR && hintCorners.BL && hintCorners.BR) {
          decoder.prevCorners = [hintCorners.TL, hintCorners.TR, hintCorners.BL, hintCorners.BR];
        } else {
          decoder.prevCorners = null;
        }
      }

      // If transferred an ImageBitmap, read back pixels off the UI thread via OffscreenCanvas
      if (e.data.bitmap) {
        const bitmap = e.data.bitmap;
        try {
          width = bitmap.width;
          height = bitmap.height;
          if (typeof OffscreenCanvas !== 'undefined') {
            if (!offscreen || offscreen.width !== width || offscreen.height !== height) {
              offscreen = new OffscreenCanvas(width, height);
              try {
                offCtx = offscreen.getContext('2d', { willReadFrequently: true });
              } catch (_) {
                offCtx = offscreen.getContext('2d');
              }
            }
            if (offCtx) {
              offCtx.drawImage(bitmap, 0, 0);
              const imgData = offCtx.getImageData(0, 0, width, height);
              rgba = imgData.data;
            }
          }
        } finally {
          if (typeof bitmap.close === 'function') {
            bitmap.close();
          }
        }
      }

      if (!rgba) {
        throw new Error('No valid RGBA buffer available in worker');
      }

      const t0 = performance.now();
      const decOptions = (e.data.version !== undefined || e.data.gridSize !== undefined || e.data.bitsPerCell !== undefined)
        ? { version: e.data.version, gridSize: e.data.gridSize, bitsPerCell: e.data.bitsPerCell }
        : null;
      const decRes = decoder.decode(rgba, width, height, roi, decOptions);
      const decodeMs = performance.now() - t0;
      const corners = decRes.corners;

      // If running standalone (not in a coordinator pool), maintain local RxSession
      if (!poolMode) {
        if (decRes.ok) {
          for (const stripe of decRes.stripes) {
            if (stripe.ok) {
              await rxSession.ingestPacket(stripe.header, stripe.payloadU32);
            }
          }
        }

        const progress = rxSession.getProgress();

        if (rxSession.isComplete) {
          self.postMessage({
            type: 'complete',
            ok: true,
            result: rxSession.result,
            corners,
            stripes: decRes.stripes,
            progress,
            decodeMs,
            frameId,
            workerId,
            sessionId
          });
          return;
        }

        self.postMessage({
          type: 'frame_result',
          ok: decRes.ok,
          corners,
          stripes: decRes.stripes,
          progress,
          decodeMs,
          frameId,
          workerId,
          sessionId
        });
        return;
      }

      // Pool mode: coordinator on main thread receives stripes and ingests into unified RxSession
      self.postMessage({
        type: 'frame_result',
        ok: decRes.ok,
        corners,
        stripes: decRes.stripes,
        decodeMs,
        frameId,
        workerId,
        sessionId
      });
    }
  } catch (err) {
    console.error('rx-worker error:', err);
    self.postMessage({
      type: 'error',
      error: err.message || String(err),
      frameId: e.data?.frameId,
      workerId: e.data?.workerId,
      sessionId: e.data?.sessionId
    });
  }
};
