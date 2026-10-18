/**
 * Receiver web application logic: Camera acquisition, backpressure, overlay rendering, and completion flow.
 */

import { formatBytes } from './ui.js';

let worker = null;
let video = null;
let overlayCanvas = null;
let overlayCtx = null;
let offscreenCanvas = null;
let offscreenCtx = null;

let isCapturing = false;
let workerBusy = false;
let startTime = 0;
let rxStartTime = 0;
let totalBytesReceived = 0;

const startBtn = document.getElementById('startCameraBtn');
const cameraArea = document.getElementById('cameraArea');
const progressPanel = document.getElementById('progressPanel');
const resultCard = document.getElementById('resultCard');
const stripeBars = [
  document.getElementById('stripe0'),
  document.getElementById('stripe1'),
  document.getElementById('stripe2'),
  document.getElementById('stripe3')
];

// Initialize worker
worker = new Worker(new URL('./rx-worker.js', import.meta.url), { type: 'module' });

worker.onmessage = (e) => {
  workerBusy = false;
  const { type, ok, corners, stripes, progress, decodeMs, result } = e.data;

  // Render overlay graphics
  renderOverlay(corners, stripes);

  // Update progress HUD
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
      const kb = (distinct * 448) / 1024.0;
      document.getElementById('rxSpeed').textContent = `${(kb / Math.max(0.1, elapsed)).toFixed(1)} KB/s`;
    }
  }

  if (decodeMs) {
    document.getElementById('rxDecodeMs').textContent = `${decodeMs.toFixed(1)} ms`;
  }

  // Update stripe status indicators
  if (stripes) {
    for (let s = 0; s < 4; s++) {
      if (stripes[s]?.ok) {
        stripeBars[s].className = 'stripe-bar active';
      } else {
        stripeBars[s].className = 'stripe-bar error';
      }
    }
  }

  // Check completion
  if (type === 'complete' && result) {
    isCapturing = false;
    showCompletion(result);
  }
};

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
  cameraArea.style.display = 'block';
  progressPanel.style.display = 'block';

  isCapturing = true;
  startTime = performance.now();
  rxStartTime = 0;
  scheduleNextFrame();
}

startBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });

    video = document.getElementById('cameraVideo');
    video.srcObject = stream;
    await video.play();

    startReceiving();
  } catch (err) {
    alert(`Camera error: ${err.message}`);
  }
});

function scheduleNextFrame() {
  if (!isCapturing) return;

  if ('requestVideoFrameCallback' in video) {
    video.requestVideoFrameCallback(captureLoop);
  } else {
    requestAnimationFrame(captureLoop);
  }
}

function captureLoop() {
  if (!isCapturing) return;

  // Backpressure: drop frame if worker is still processing previous frame
  if (!workerBusy && video && video.readyState >= 2) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (vw > 0 && vh > 0) {
      if (offscreenCanvas.width !== vw || offscreenCanvas.height !== vh) {
        offscreenCanvas.width = vw;
        offscreenCanvas.height = vh;
      }
      if (overlayCanvas.width !== vw || overlayCanvas.height !== vh) {
        overlayCanvas.width = vw;
        overlayCanvas.height = vh;
      }

      workerBusy = true;
      try {
        offscreenCtx.drawImage(video, 0, 0);
        const imgData = offscreenCtx.getImageData(0, 0, vw, vh);

        worker.postMessage(
          {
            type: 'decode_frame',
            rgba: imgData.data,
            width: vw,
            height: vh
          },
          [imgData.data.buffer] // Transferable buffer
        );
      } catch (err) {
        console.error('Frame capture error:', err);
        workerBusy = false;
      }
    }
  }

  scheduleNextFrame();
}
