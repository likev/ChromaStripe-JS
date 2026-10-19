/**
 * Receiver web application logic: Camera acquisition, backpressure, overlay rendering,
 * multi-worker pool orchestration, cropped readback, and completion flow.
 */

import { formatBytes } from './ui.js';
import { RxSession } from '../../src/session/rxSession.js';

let video = null;
let overlayCanvas = null;
let overlayCtx = null;
let offscreenCanvas = null;
let offscreenCtx = null;

let isCapturing = false;
let startTime = 0;
let rxStartTime = 0;
let lastCorners = null;
let cameraLocked = false;
let frameSeq = 0;
let nextWorkerIdx = 0;
let sessionEpoch = 0;
let latestCompletedFrameId = 0;
let consecutiveMisses = 0;
let hasCompleted = false;
let bitmapTransferSupported = (typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined');

const rxSession = new RxSession();

const startBtn = document.getElementById('startCameraBtn');
const cameraArea = document.getElementById('cameraArea');
const progressPanel = document.getElementById('progressPanel');
const resultCard = document.getElementById('resultCard');
const rxVersionSelect = document.getElementById('rxVersionSelect');
const rxGridSelect = document.getElementById('rxGridSelect');
const stripeBars = [
  document.getElementById('stripe0'),
  document.getElementById('stripe1'),
  document.getElementById('stripe2'),
  document.getElementById('stripe3'),
  document.getElementById('stripe4'),
  document.getElementById('stripe5'),
  document.getElementById('stripe6'),
  document.getElementById('stripe7')
];

// Initialize multi-worker RX pool (2–3 Web Workers) to eliminate workerBusy frame drops
const POOL_SIZE = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency)
  ? Math.max(2, Math.min(3, navigator.hardwareConcurrency - 1))
  : 2;

const workers = [];
for (let i = 0; i < POOL_SIZE; i++) {
  const w = new Worker(new URL('./rx-worker.js', import.meta.url), { type: 'module' });
  const workerObj = {
    id: i,
    worker: w,
    busy: false
  };
  w.onmessage = (e) => handleWorkerMessage(workerObj, e);
  w.onerror = (err) => {
    console.error(`RX Worker ${i} error:`, err);
    workerObj.busy = false;
  };
  workers.push(workerObj);
}

async function handleWorkerMessage(workerObj, e) {
  workerObj.busy = false;
  const { type, ok, corners, stripes, decodeMs, frameId, sessionId } = e.data;

  // Discard frames from previous sessions
  if (sessionId && sessionId !== sessionEpoch) {
    return;
  }

  if (type === 'error') {
    if (e.data.error && (e.data.error.includes('OffscreenCanvas') || e.data.error.includes('RGBA'))) {
      bitmapTransferSupported = false;
    }
    return;
  }

  // Lock camera hardware (AE/AWB/Focus) if first valid stripe decoded (Tier 2 Item 9)
  if (ok && stripes && stripes.some(s => s && s.ok)) {
    tryLockCameraHardware();
  }

  // Ingest decoded stripe packets into the unified RxSession regardless of frame ordering
  if (ok && stripes) {
    for (const stripe of stripes) {
      if (stripe && stripe.ok && stripe.header && stripe.payloadU32) {
        await rxSession.ingestPacket(stripe.header, stripe.payloadU32);
      }
    }
  }

  // Check completion (single-fire)
  if (rxSession.isComplete && rxSession.result && !hasCompleted) {
    hasCompleted = true;
    isCapturing = false;
    showCompletion(rxSession.result);
  }

  // Update progress HUD
  const progress = rxSession.getProgress();
  if (progress) {
    const totalCollected = progress.solvedCount + (progress.waitingCount || 0);
    const distinct = progress.distinctCount !== undefined ? progress.distinctCount : Math.min(progress.K, totalCollected);
    document.getElementById('rxBlocks').textContent = `${progress.solvedCount} / ${progress.K} (${totalCollected} eq)`;
    document.getElementById('rxPercent').textContent = `${(progress.percent * 100).toFixed(0)}%`;
    document.getElementById('progressBar').style.width = `${(progress.percent * 100).toFixed(0)}%`;

    if (distinct > 0) {
      if (!rxStartTime) {
        rxStartTime = performance.now();
      }
      const elapsed = (performance.now() - rxStartTime) / 1000.0;
      const bytesPerBlock = rxSession.fountainDecoder?.bytesPerBlock || 448;
      const kb = (distinct * bytesPerBlock) / 1024.0;
      document.getElementById('rxSpeed').textContent = `${(kb / Math.max(0.1, elapsed)).toFixed(1)} KB/s`;
    }
  }

  // Frame sequencing: Only update visual priors (corners, overlay, stripe bars) if this frame is newer
  // than previously rendered frames to prevent out-of-order jitter
  if (frameId !== undefined && frameId < latestCompletedFrameId) {
    return;
  }
  if (frameId !== undefined) {
    latestCompletedFrameId = frameId;
  }

  if (corners && corners.TL && corners.TR && corners.BL && corners.BR) {
    lastCorners = corners;
    consecutiveMisses = 0;
    renderOverlay(corners, stripes);
  } else {
    consecutiveMisses++;
    if (consecutiveMisses >= POOL_SIZE) {
      lastCorners = null;
    }
    renderOverlay(null, null);
  }

  if (decodeMs) {
    document.getElementById('rxDecodeMs').textContent = `${decodeMs.toFixed(1)} ms`;
  }

  // Update stripe status indicators
  const numStripes = stripes ? stripes.length : 4;
  for (let s = 0; s < stripeBars.length; s++) {
    if (!stripeBars[s]) continue;
    if (s < numStripes) {
      stripeBars[s].style.display = 'block';
      if (stripes && stripes[s]?.ok) {
        stripeBars[s].className = 'stripe-bar active';
      } else {
        stripeBars[s].className = 'stripe-bar error';
      }
    } else {
      stripeBars[s].style.display = 'none';
    }
  }
}

/**
 * Attempts to lock camera hardware Auto-Exposure, Auto-White-Balance, and Focus
 * via MediaStreamTrack advanced constraints to minimize transition motion/shutter blur.
 */
async function tryLockCameraHardware() {
  if (cameraLocked || !video || !video.srcObject) return;
  cameraLocked = true; // Attempt lock only once per session to avoid hammering camera driver

  try {
    const stream = video.srcObject;
    const tracks = (typeof stream.getVideoTracks === 'function') ? stream.getVideoTracks() : [];
    if (!tracks || tracks.length === 0) return;
    const track = tracks[0];

    if (typeof track.getCapabilities !== 'function' || typeof track.applyConstraints !== 'function') {
      return;
    }

    const caps = track.getCapabilities();
    const settings = (typeof track.getSettings === 'function') ? track.getSettings() : {};
    const advanced = [];

    // 1. Lock White Balance to manual if supported
    if (caps.whiteBalanceMode && Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('manual')) {
      advanced.push({ whiteBalanceMode: 'manual' });
    }

    // 2. Lock Exposure Mode to manual if supported
    if (caps.exposureMode && Array.isArray(caps.exposureMode) && caps.exposureMode.includes('manual')) {
      advanced.push({ exposureMode: 'manual' });
    }

    // 3. Lock Focus Mode to continuous or manual if supported
    if (caps.focusMode && Array.isArray(caps.focusMode)) {
      if (caps.focusMode.includes('continuous')) {
        advanced.push({ focusMode: 'continuous' });
      } else if (caps.focusMode.includes('manual')) {
        advanced.push({ focusMode: 'manual' });
      }
    }

    // 4. Cap exposure time to <= 1/60s for crisp rolling shutter transitions
    // Units in W3C ImageCapture: 100-microsecond units (max > 100), ms (max <= 100), or seconds (max <= 1)
    if (caps.exposureTime && typeof caps.exposureTime === 'object') {
      const minExp = caps.exposureTime.min || 0;
      const maxExp = caps.exposureTime.max || 100;
      let cap60;
      if (maxExp <= 1.0) {
        cap60 = 1.0 / 60.0; // seconds
      } else if (maxExp <= 100.0) {
        cap60 = 1000.0 / 60.0; // milliseconds (~16.6 ms)
      } else {
        cap60 = 10000.0 / 60.0; // 100-microsecond units (~166.6 units)
      }
      const curExp = settings.exposureTime || cap60;
      const targetExp = Math.max(minExp, Math.min(curExp, cap60, maxExp));
      advanced.push({ exposureTime: targetExp });
    }

    if (advanced.length > 0) {
      await track.applyConstraints({ advanced });
    }
  } catch (err) {
    console.debug('Hardware camera locking note:', err);
  }
}

function renderOverlay(corners, stripes) {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!corners) return;

  const pts = [corners.TL, corners.TR, corners.BR, corners.BL];

  // Draw code boundary
  overlayCtx.beginPath();
  overlayCtx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    overlayCtx.lineTo(pts[i].x, pts[i].y);
  }
  overlayCtx.closePath();
  overlayCtx.lineWidth = 3;
  overlayCtx.strokeStyle = '#10b981';
  overlayCtx.stroke();

  // Draw corner dots
  const cornerColors = ['#ef4444', '#3b82f6', '#f59e0b', '#10b981'];
  for (let i = 0; i < pts.length; i++) {
    overlayCtx.beginPath();
    overlayCtx.arc(pts[i].x, pts[i].y, 6, 0, 2 * Math.PI);
    overlayCtx.fillStyle = cornerColors[i];
    overlayCtx.fill();
    overlayCtx.lineWidth = 2;
    overlayCtx.strokeStyle = '#ffffff';
    overlayCtx.stroke();
  }

  if (isDebug) {
    overlayCtx.fillStyle = '#10b981';
    overlayCtx.font = '14px monospace';
    overlayCtx.fillText(`TL: (${pts[0].x.toFixed(1)}, ${pts[0].y.toFixed(1)})`, 10, 25);
    overlayCtx.fillText(`TR: (${pts[1].x.toFixed(1)}, ${pts[1].y.toFixed(1)})`, 10, 45);
    overlayCtx.fillText(`BR: (${pts[2].x.toFixed(1)}, ${pts[2].y.toFixed(1)})`, 10, 65);
    overlayCtx.fillText(`BL: (${pts[3].x.toFixed(1)}, ${pts[3].y.toFixed(1)})`, 10, 85);
  }
}

function showCompletion(result) {
  progressPanel.style.display = 'none';
  resultCard.style.display = 'block';

  document.getElementById('resName').textContent = result.fileName;
  document.getElementById('resSize').textContent = formatBytes(result.originalSize);
  document.getElementById('resHash').textContent = result.sha256Verified ? '✔ Verified SHA-256' : '✖ Integrity Failed';

  const blob = new Blob([result.data], { type: result.mimeType });
  const url = URL.createObjectURL(blob);
  const dlBtn = document.getElementById('downloadBtn');
  dlBtn.href = url;
  dlBtn.download = result.fileName;
}

const urlParams = new URLSearchParams(window.location.search);
const sourceMode = urlParams.get('source');
const isDebug = urlParams.get('debug') === '1';

const loadFileBtn = document.getElementById('loadFileBtn');
const videoFileInput = document.getElementById('videoFileInput');

if (sourceMode === 'file') {
  startBtn.style.display = 'none';
  loadFileBtn.style.display = 'inline-block';
  loadFileBtn.addEventListener('click', () => videoFileInput.click());
  videoFileInput.addEventListener('change', async () => {
    const file = videoFileInput.files?.[0];
    if (!file) return;
    try {
      video = document.getElementById('cameraVideo');
      video.src = URL.createObjectURL(file);
      video.loop = true;
      await video.play();
      startReceiving();
    } catch (err) {
      alert(`Video error: ${err.message}`);
    }
  });
}

function startReceiving() {
  overlayCanvas = document.getElementById('overlayCanvas');
  overlayCanvas.width = video.videoWidth || 1280;
  overlayCanvas.height = video.videoHeight || 720;
  overlayCtx = overlayCanvas.getContext('2d');

  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = overlayCanvas.width;
  offscreenCanvas.height = overlayCanvas.height;
  offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

  startBtn.style.display = 'none';
  if (loadFileBtn) loadFileBtn.style.display = 'none';
  const placeholder = document.getElementById('stagePlaceholder');
  if (placeholder) placeholder.style.display = 'none';
  const videoContainer = document.querySelector('.video-container');
  if (videoContainer) videoContainer.style.display = 'block';
  progressPanel.style.display = 'block';

  rxSession.reset();
  lastCorners = null;
  cameraLocked = false;
  latestCompletedFrameId = 0;
  consecutiveMisses = 0;
  hasCompleted = false;
  const currentSessionId = ++sessionEpoch;

  for (const w of workers) {
    w.busy = false;
    w.worker.postMessage({ type: 'reset', sessionId: currentSessionId });
  }

  isCapturing = true;
  startTime = performance.now();
  rxStartTime = 0;
  scheduleNextFrame();
}

startBtn.addEventListener('click', async () => {
  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60, min: 30 }
        }
      });
    } catch (_) {
      // Fallback for camera hardware not satisfying min: 30 (e.g., desktop/laptop webcams)
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60 }
        }
      });
    }

    video = document.getElementById('cameraVideo');
    video.srcObject = stream;
    await video.play();

    startReceiving();
  } catch (err) {
    alert(`Camera error: ${err.message}`);
  }
});

function scheduleNextFrame() {
  if (!isCapturing || !video) return;

  if (typeof video.requestVideoFrameCallback === 'function') {
    video.requestVideoFrameCallback(captureLoop);
  } else {
    requestAnimationFrame(captureLoop);
  }
}

/**
 * Finds next available worker in the pool, round-robin.
 */
function getAvailableWorker() {
  for (let i = 0; i < workers.length; i++) {
    const idx = (nextWorkerIdx + i) % workers.length;
    if (!workers[idx].busy) {
      nextWorkerIdx = (idx + 1) % workers.length;
      return workers[idx];
    }
  }
  return null;
}

function captureLoop() {
  if (!isCapturing) return;

  const workerObj = getAvailableWorker();
  if (workerObj && video && video.readyState >= 2) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (vw > 0 && vh > 0) {
      if (overlayCanvas.width !== vw || overlayCanvas.height !== vh) {
        overlayCanvas.width = vw;
        overlayCanvas.height = vh;
      }

      // Compute cropped ROI from lastCorners (Tier 2 Item 8)
      let sx = 0, sy = 0, sw = vw, sh = vh;
      if (lastCorners) {
        const minX = Math.max(0, Math.floor(Math.min(lastCorners.TL.x, lastCorners.TR.x, lastCorners.BL.x, lastCorners.BR.x) - 64));
        const minY = Math.max(0, Math.floor(Math.min(lastCorners.TL.y, lastCorners.TR.y, lastCorners.BL.y, lastCorners.BR.y) - 64));
        const maxX = Math.min(vw, Math.ceil(Math.max(lastCorners.TL.x, lastCorners.TR.x, lastCorners.BL.x, lastCorners.BR.x) + 64));
        const maxY = Math.min(vh, Math.ceil(Math.max(lastCorners.TL.y, lastCorners.TR.y, lastCorners.BL.y, lastCorners.BR.y) + 64));
        const cw = maxX - minX;
        const ch = maxY - minY;
        if (cw >= 160 && ch >= 160 && (cw * ch) < (vw * vh * 0.85)) {
          sx = minX;
          sy = minY;
          sw = cw;
          sh = ch;
        }
      }

      const isCropped = (sw !== vw || sh !== vh);
      const roi = isCropped ? { x: sx, y: sy } : null;
      const frameId = ++frameSeq;
      const currentSessionId = sessionEpoch;
      workerObj.busy = true;

      // Offload readback off UI thread via createImageBitmap if supported
      if (bitmapTransferSupported) {
        createImageBitmap(video, sx, sy, sw, sh)
          .then((bitmap) => {
            if (!isCapturing || sessionEpoch !== currentSessionId) {
              if (typeof bitmap.close === 'function') bitmap.close();
              workerObj.busy = false;
              return;
            }
            const rxVer = rxVersionSelect?.value === '1' ? 1 : (rxVersionSelect?.value === '2' ? 2 : 'auto');
            const rxGrid = parseInt(rxGridSelect?.value || '80', 10);
            workerObj.worker.postMessage(
              {
                type: 'decode_frame',
                bitmap,
                width: sw,
                height: sh,
                roi,
                hintCorners: lastCorners,
                frameId,
                workerId: workerObj.id,
                poolMode: true,
                sessionId: currentSessionId,
                version: rxVer,
                gridSize: rxGrid
              },
              [bitmap]
            );
          })
          .catch(() => {
            bitmapTransferSupported = false;
            dispatchViaCanvas(workerObj, sx, sy, sw, sh, roi, frameId, currentSessionId);
          });
      } else {
        dispatchViaCanvas(workerObj, sx, sy, sw, sh, roi, frameId, currentSessionId);
      }
    }
  }

  scheduleNextFrame();
}

/**
 * Fallback cropped drawImage + getImageData when createImageBitmap transfer is unavailable.
 */
function dispatchViaCanvas(workerObj, sx, sy, sw, sh, roi, frameId, currentSessionId) {
  try {
    if (offscreenCanvas.width !== sw || offscreenCanvas.height !== sh) {
      offscreenCanvas.width = sw;
      offscreenCanvas.height = sh;
    }
    // 9-argument cropped drawImage (Item 8)
    offscreenCtx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    const imgData = offscreenCtx.getImageData(0, 0, sw, sh);

    const rxVer = rxVersionSelect?.value === '1' ? 1 : (rxVersionSelect?.value === '2' ? 2 : 'auto');
    const rxGrid = parseInt(rxGridSelect?.value || '80', 10);

    workerObj.worker.postMessage(
      {
        type: 'decode_frame',
        rgba: imgData.data,
        width: sw,
        height: sh,
        roi,
        hintCorners: lastCorners,
        frameId,
        workerId: workerObj.id,
        poolMode: true,
        sessionId: currentSessionId || sessionEpoch,
        version: rxVer,
        gridSize: rxGrid
      },
      [imgData.data.buffer] // Transferable buffer
    );
  } catch (err) {
    console.error('Frame capture fallback error:', err);
    workerObj.busy = false;
  }
}
