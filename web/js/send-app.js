/**
 * Sender web application logic: File ingestion, frame pacing, fullscreen, and HUD.
 */

import { TxSession } from '../../src/session/txSession.js';
import { TxCanvasRenderer } from './tx-render.js';
import { formatBytes, formatTime } from './ui.js';
import { getDropletPhase } from '../../src/fountain/schedule.js';

let session = null;
let renderer = null;
let isRunning = false;
let isPaused = false;
let animFrameId = null;

let vsyncCount = 0;
let txHold = 4; // Default: Normal (15 fps on 60 Hz)
let rotation = 0;
let startTime = 0;
let totalFramesSent = 0;

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileStats = document.getElementById('fileStats');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const rotateBtn = document.getElementById('rotateBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const speedSelect = document.getElementById('speedSelect');
const canvas = document.getElementById('txCanvas');
const hud = document.getElementById('hud');

// File Selection Handler
async function handleFile(file) {
  if (!file) return;

  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  session = new TxSession(bytes, {
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    scale: 1,
    rotation
  });

  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = formatBytes(bytes.length);
  fileStats.style.display = 'block';

  await session.init();

  document.getElementById('blockCount').textContent = session.K;
  const estSec = Math.ceil(session.K / (60 / txHold / 4));
  document.getElementById('estTime').textContent = formatTime(estSec);

  startBtn.disabled = false;
}

// Drag & drop listeners
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    handleFile(e.dataTransfer.files[0]);
  }
});
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    handleFile(fileInput.files[0]);
  }
});

// Speed setting
speedSelect.addEventListener('change', () => {
  txHold = parseInt(speedSelect.value, 10);
});

// Rotation toggle
rotateBtn.addEventListener('click', () => {
  rotation = rotation === 0 ? 90 : 0;
  if (session) session.rotation = rotation;
  rotateBtn.textContent = `Rotate (${rotation}°)`;
});

// Fullscreen & Wake Lock
fullscreenBtn.addEventListener('click', async () => {
  const container = document.getElementById('canvasArea');
  if (!document.fullscreenElement) {
    await container.requestFullscreen().catch(() => {});
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').catch(() => {});
    }
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

// Start Transmission Loop
startBtn.addEventListener('click', () => {
  if (!session) return;

  renderer = new TxCanvasRenderer(canvas, 1);
  isRunning = true;
  isPaused = false;
  vsyncCount = 0;
  totalFramesSent = 0;
  startTime = performance.now();

  startBtn.style.display = 'none';
  pauseBtn.style.display = 'inline-block';
  hud.style.display = 'grid';

  requestAnimationFrame(renderLoop);
});

pauseBtn.addEventListener('click', () => {
  isPaused = !isPaused;
  pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
});

// Main render loop locked to vsync
function renderLoop() {
  if (!isRunning) return;

  if (!isPaused) {
    if (vsyncCount % txHold === 0) {
      const frame = session.getNextFrame();
      renderer.displayFrame(frame.rgba);
      totalFramesSent++;

      // Update HUD
      const phaseNum = getDropletPhase(frame.seeds[0], session.K);
      const phaseNames = ['Systematic', 'Parity', 'Fountain'];
      document.getElementById('hudPhase').textContent = phaseNames[phaseNum];
      document.getElementById('hudSeeds').textContent = `${frame.seeds[3] + 1}`;
      const elapsed = (performance.now() - startTime) / 1000.0;
      document.getElementById('hudTime').textContent = formatTime(elapsed);
      document.getElementById('hudFps').textContent = (totalFramesSent / Math.max(1, elapsed)).toFixed(1);
    }
    vsyncCount++;
  }

  animFrameId = requestAnimationFrame(renderLoop);
}

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (isRunning) pauseBtn.click();
  } else if (e.key === 'r' || e.key === 'R') {
    rotateBtn.click();
  }
});
