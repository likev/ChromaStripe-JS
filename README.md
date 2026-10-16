# ChromaStripe-JS

> High-speed screen-to-camera optical file transfer in **100% vanilla JavaScript** (zero dependencies, zero WASM, zero OpenCV).

---

## Overview

ChromaStripe-JS redesigns optical file modems (such as `libcimbar`) specifically for the JavaScript engine (V8/JIT) and real-world camera optics. It solves the two fundamental bottlenecks of browser-based optical transfer:

1. **The Pixel Bottleneck:** full-frame perspective warps and shape convolutions are replaced with **zero-warp inverse homography sampling** and branchless 3-bit RGB cube slicing.
2. **Rolling Shutter Tearing:** frames are partitioned into **4 independent horizontal micro-stripes**. When a rolling shutter tear occurs, intact stripes still decode and pass their CRC32, jumping usable packet yield from ~45% to over 85%.

---

## System Architecture

```
Layer 1: Physical Modulation — 8-Color RGB Cube (80x80 Grid, 2px Guard Bands, 4x4 Pilot Blocks)
Layer 2: Framing            — 4 Horizontal Micro-Stripes (542B packet, 3 interleaved RS codewords, CRC32)
Layer 3: Computer Vision    — Opponent-Color Corner Finders (R-G), DLT Homography, Coons-Patch Timing
Layer 4: Channel Coding     — Systematic LT Fountain Code + Inactivation Gaussian Elimination
Layer 5: Web Application    — Native Web Worker decode pipeline, static zero-dependency HTTPS server
```

---

## Quick Start

### 1. Requirements
- Node.js ≥ 20 (Node 24 recommended).
- Modern web browser (Chrome, Edge, Safari, Firefox).

### 2. Run Test Suite
```bash
npm test
```
Runs 37 unit and integration tests covering PRNG, CRCs, RS codecs, bit packing, layout compiler, scrambler, packet framing, vision pipeline, homography, timing, pilots, fountain codec, and end-to-end sessions.

### 3. Run Microbenchmarks
```bash
npm run bench
```
Measures kernel execution times against frozen §7.1 performance budgets (homography, CRC32, timing, sampler, RS decode, fountain GE).

### 4. Run Simulation Suite
```bash
# Level 0: Fountain erasure channel experiments
npm run sim:l0

# Level 1: Symbol & bit-error channel experiments
npm run sim:l1

# Level 2: Synthetic camera optical simulation (ideal scenario)
npm run sim:l2
```

### 5. Launch Web Application
```bash
# HTTP server (localhost testing)
npm run serve

# HTTPS server (mobile camera testing over LAN)
./tools/make-cert.sh
npm run serve:https
```
Open `http://localhost:8080/web/` in your browser.

---

## Web Pages
- `web/index.html`: Diagnostic landing page with browser capability detection.
- `web/send.html`: Full-screen optical transmitter with speed presets (10–30 fps) and HUD.
- `web/receive.html`: Mobile-optimized camera receiver with worker decode loop and overlay graphics.
- `web/sim.html`: Interactive in-browser loopback simulation with live optical/sensor sliders.

---

## License
MIT
