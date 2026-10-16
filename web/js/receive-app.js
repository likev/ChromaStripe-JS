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
    document.getElementById('rxBlocks').textContent = `${progress.solvedCount} / ${progress.K}`;
    document.getElementById('rxPercent').textContent = `${(progress.percent * 100).toFixed(0)}%`;
    document.getElementById('progressBar').style.width = `${(progress.percent * 100).toFixed(0)}%`;

    if (progress.solvedCount > 0 && startTime > 0) {
      const elapsed = (performance.now() - startTime) / 1000.0;
      const kb = (progress.solvedCount * 448) / 1024.0;
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

    overlayCanvas = document.getElementById('overlayCanvas');
    overlayCanvas.width = video.videoWidth;
    overlayCanvas.height = video.videoHeight;
    overlayCtx = overlayCanvas.getContext('2d');

    offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = video.videoWidth;
    offscreenCanvas.height = video.videoHeight;
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

    startBtn.style.display = 'none';
    cameraArea.style.display = 'block';
    progressPanel.style.display = 'block';

    isCapturing = true;
    startTime = performance.now();
    scheduleNextFrame();
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
  if (!workerBusy && video.readyState >= 2) {
    workerBusy = true;
    offscreenCtx.drawImage(video, 0, 0);
    const imgData = offscreenCtx.getImageData(0, 0, video.videoWidth, video.videoHeight);

    worker.postMessage(
      {
        type: 'decode_frame',
        rgba: imgData.data,
        width: video.videoWidth,
        height: video.videoHeight
      },
      [imgData.data.buffer] // Transferable buffer
    );
  }

  scheduleNextFrame();
}
