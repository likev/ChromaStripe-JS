# ChromaStripe-JS Code Review (`review1.md`)

## Executive Summary: Why Your Phone Cannot Receive Files (`Throughput: 0.0 KB/s`)

When running ChromaStripe-JS between a computer screen (`web/send.html`) and a real phone camera (`web/receive.html`), transfers fail and throughput stays stuck at **`0.0 KB/s`** due to **7 compounding bugs** across the computer vision pipeline, camera acquisition layer, fountain coding schedule, and sender sizing logic:

1. **[CRITICAL] Finder Detector False Positives & Corner Drop Bug (`src/vision/finder.js`):**
   - `findCorners()` only checks `R - G` chrominance (`1:3:1`), ignoring the **Blue channel (`B`)** and the **outer Black ring (`1:1:3:1:1`)**, while skipping up to 5 pixels of neutral/black guard bands (`runs[j].len <= 5`). Because 50% of data cells (`Red`, `Magenta`, `Green`, `Cyan`) have the exact same `|R - G| = 215` as the finders, camera blur causes dozens of false finder candidates inside the data grid on every frame.
   - `clusterCandidates()` merges candidates within a hardcoded `30 px` radius without checking polarity (`cand.inverted`), pulling real corner centroids off by **2–6+ pixels** and merging interior false hits into high-count clusters.
   - `clusters.sort(...); const top4 = clusters.slice(0, 4);` slices the top 4 clusters **before** separating the 3 standard corners from the 1 inverted `BR` corner. Because scanlines run top-to-bottom (`y` increasing) and `Array.prototype.sort` is stable, `BL` and `BR` (at the bottom of the frame) are **always last** in any scanline-count tie and get **dropped by `slice(0, 4)`** in favor of interior data cells.
2. **[CRITICAL] Permanent Poison Lock in ROI Tracking (`src/vision/frameDecoder.js` & `src/vision/finder.js`):**
   - `FrameDecoder.decode()` saves `this.prevCorners` whenever `findCorners` returns 4 points—**even when 0 out of 4 stripes pass RS/CRC (`validStripesCount === 0`)**—and never performs the spec's periodic 15-frame full rescan (`this.lockCount` is unused).
   - `trackCornersROI()` only checks for a $\ge 4 \times 4\text{ px}$ patch with `|R - G| >= 25` (no ring check, no max-size check). Once `findCorners` locks onto a false positive (interior data cells, pilot block, or room object) on a single frame, `trackCornersROI` stays **permanently locked onto the bogus coordinates**, yielding `0.0 KB/s` forever.
3. **[CRITICAL] Systematic `(+1.0 px, +1.0 px)` Cell Sampling Offset (`src/vision/finder.js`, `src/vision/sampler.js`, `src/vision/pilots.js`):**
   - `finder.js` computes `(topCore + botCore + 1) * 0.5` where `topCore = y_first - 1` and `botCore = y_last + 1`, adding a **`+0.5 px` bias** in both X and Y to all 4 corner coordinates.
   - `sampler.js` then takes `ix = Math.floor(x)` and averages the $2 \times 2$ block `[ix, ix + 1] × [iy, iy + 1]` (centered at `ix + 0.5`), adding **another `+0.5 px` shift** (instead of `Math.floor(x - 0.5)`).
   - Together, every sampled data cell is shifted by **`(+1.0 px, +1.0 px)`** toward the bottom-right. At realistic phone camera scales (`4.5–6 px/cell`), this pushes the $2 \times 2$ sample window out of the cell core and **directly into the black guard band**, corrupting bits across all 4 stripes (`RS_OR_CRC_FAILED`).
4. **[HIGH] Broken `TimingRefiner` Loop Always Uses `s = +1` (`src/vision/timing.js`):**
   - In `_computeOffsetField()`, the loops step by 2 (`for (let c = 8; c <= 71; c += 2)`), so `c - 8` is **always even** and `const s = ((c - 8) & 1) === 0 ? 1 : -1` is **always `+1`**. Dark timing cells (`c = 9, 11, ...`) are never sampled or subtracted. Instead of measuring alternating timing contrast, it maximizes raw border luminance, which under slight corner offsets or glare selects a bogus `bestK1` that warps `duField`/`dvField` by up to `±2.0` full cells.
5. **[CRITICAL] Mobile Portrait Canvas Clipping & Uncaught Worker Lockup (`web/js/receive-app.js` & `web/js/rx-worker.js`):**
   - `offscreenCanvas` and `overlayCanvas` sizes are set once in `startReceiving()` and never synced in `captureLoop()` when `video.videoWidth`/`videoHeight` update or swap to portrait (`720×1280` vs `1280×720`), clipping the bottom 560 rows of the camera frame or throwing an uncaught `IndexSizeError` when `videoWidth === 0`.
   - `rx-worker.js` has no `try/catch`; any error sets `workerBusy = true` permanently.
6. **[HIGH] Late-Join Fountain Stall & `0.0 KB/s` HUD Reporting (`src/fountain/schedule.js`, `src/fountain/degree.js`, `web/js/receive-app.js`):**
   - Phase 1 (`seed < K`, degree-1 systematic sweep) only runs once at the very start of transmission (finishing in **0.4–2.0 seconds** for a 10–50 KB file—before you can pick up your phone and aim the camera).
   - After `seed >= 1.15 * K`, the sender stays in Phase 3 forever, where `sampleResidualDegree()` emits **only 5% degree-1 droplets** and 95% high-degree droplets. A phone that starts scanning in Phase 3 cannot peel equations: droplets accumulate in `waitingList` while `solvedCount` stays `0` (or near `0`), so `receive-app.js` displays **`Throughput: 0.0 KB/s`** until 100% of $K$ independent equations are collected for Gaussian Elimination.
7. **[HIGH] Simulator & Loopback Freeze After Frame 30 (`web/sim.html`, `sim/run.js`, `sim/camera/timing.js`):**
   - `txFramesMap.delete(frameNo - 15)` deletes TX frames indexed by the **30 fps camera `frameNo`**, while `ShutterTiming` reads TX frames at **15 fps (`frameIdx = Math.floor(frameNo / 2)`)**. At camera `frameNo = 31`, `txFramesMap` deletes TX frame `16` right before `ShutterTiming` needs it, causing `SyntheticCamera` to render a **blank black screen** from frame 31 onward (`FINDER_NOT_FOUND` forever).

---

## Detailed Bug-by-Bug Technical Analysis

### 1. Finder Pattern Detection & Corner Selection (`src/vision/finder.js`)

#### 1.1 Data Cells Mimic Finder Patterns in `R - G` Space (`lines 37–119, 214–260`)
The detector projects RGB pixels onto a single 1D axis:
```js
// src/vision/finder.js:39-42
const getCdiff = (x, y) => {
  const idx = (y * width + x) * 4;
  return rgba[idx] - rgba[idx + 1];
};
```
Look at the 8 data constellation colors in `src/frame/constants.js` (`lines 46–55`):
| Symbol | Binary | RGB `(R, G, B)` | `cd = R - G` | `finder.js` Sign (`T = 35`) |
|---|---|---|---|---|
| 0 (Dark) | `000` | `(40, 40, 40)` | `0` | `0` (Neutral) |
| 1 (Blue) | `001` | `(40, 40, 255)` | `0` | `0` (Neutral) |
| 2 (Green) | `010` | `(40, 255, 40)` | **`-215`** | **`-1` (Same as Cyan!)** |
| 3 (Cyan) | `011` | `(40, 255, 255)` | **`-215`** | **`-1` (Cyan)** |
| 4 (Red) | `100` | `(255, 40, 40)` | **`+215`** | **`+1` (Same as Magenta!)** |
| 5 (Magenta) | `101` | `(255, 40, 255)` | **`+215`** | **`+1` (Magenta)** |
| 6 (Yellow) | `110` | `(255, 255, 40)` | `0` | `0` (Neutral) |
| 7 (White) | `111` | `(255, 255, 255)` | `0` | `0` (Neutral) |

- **50% of all data cells** have `|R - G| = 215` (`{Green, Cyan}` = `-215`, `{Red, Magenta}` = `+215`).
- The design doc (`chroma-stripe-plan1.md` R5) stated that data cells would not trigger finder matches because *"Data cells are always broken by 2-px guards."*
- **However**, `finder.js` (`lines 77–84` and `238–251`) explicitly skips neutral (`sign === 0`) runs of up to **5 pixels horizontally** and **4 pixels vertically** between the ring and core:
  ```js
  // src/vision/finder.js:77-85
  let j = i + 1;
  if (j < runs.length && runs[j].sign === 0 && runs[j].len <= 5) j++;
  if (j >= runs.length || runs[j].sign !== targetCoreSign) continue;
  const r2 = runs[j]; // core

  let k = j + 1;
  if (k < runs.length && runs[k].sign === 0 && runs[k].len <= 5) k++;
  if (k >= runs.length || runs[k].sign !== r1.sign) continue;
  const r3 = runs[k]; // ring
  ```
  Because the black guard band (`R - G = 0`, `sign = 0`) between data cells is `1–2 pixels` wide, `finder.js` **skips right over the black guard bands**.
- Furthermore, when 2 or 3 adjacent data cells share the same `R - G` sign (which occurs dozens of times per frame across 5,824 whitened cells), optical PSF blur + YUV 4:2:0 chroma subsampling bridges the narrow guard band so `|R - G|` stays $\ge 25$, forming a synthetic 2–3 cell "core" surrounded by 1-cell "rings" across guard bands.
- Despite the file comment on line 3 claiming `1:1:3:1:1 ratio matcher`, `finder.js` **never checks the outer `7×7` black ring** and **never checks that the Blue channel `B` is high** (`B > 120` and `B - min(R, G) > 50`, which would reject all `Red` and `Green` data cells and room objects).

#### 1.2 `clusterCandidates` and `clusters.slice(0, 4)` Drop Real Corners (`lines 121–139, 283–312`)
```js
// src/vision/finder.js:121-135
const clusters = clusterCandidates(candidates);
if (clusters.length < 4) {
  return { found: false, candidates };
}

// Find the top 4 clusters by hit count
clusters.sort((a, b) => b.count - a.count);
const top4 = clusters.slice(0, 4);

// Inverted finder BR has positive inverted ratio
top4.sort((a, b) => (b.invCount / b.count) - (a.invCount / a.count));
const brCandidate = top4[0];
const standardCandidates = top4.slice(1);
```
This logic has three severe bugs:
1. **`clusterCandidates` merges within a fixed `30 px` radius (`MERGE_DIST2 = 30 * 30`) and ignores `cand.inverted`:**
   - When the code occupies 350–480 px on a phone camera (`4.5–6 px/cell`), data cells start at cell 8 (`4.5 cells = 20–27 px` from the finder center at cell `3.5`). False candidates on data cells near a corner are within `30 px` of the true corner and get averaged into the corner cluster, shifting the corner centroid by **2 to 6+ pixels**!
   - A `6 px` error on `TL` (observed reproducibly at `corePx = 4, codeHeightFrac = 0.5`) increases Stripe 0 symbol errors from `6 / 1446` to **`809 / 1446` (56% error rate)**.
2. **`clusters.slice(0, 4)` drops `BR` (or `BL`) whenever an interior false cluster ties in scanline hit `count`:**
   - At `4.5–6 px/cell`, the 3-cell finder core is `13–18 px` high. With `scanStep = 4`, each corner is hit by only **3 or 4 scanlines** (`count = 3` or `4`).
   - Because scanlines run top-to-bottom (`y` from `5` to `height - 5`), `TL` and `TR` are inserted into `clusters` first, interior data-cell false clusters are inserted in the middle, and `BL` and `BR` (largest `y`) are inserted **last**.
   - Because `Array.prototype.sort` is stable, any interior false cluster with `count = 3` (or `4`) is ordered **before** `BL` and `BR` (also `count = 3`) and selected into `top4`, while **`BR` is discarded**!
3. **No separation of standard vs. inverted finders and no quadrilateral validation before picking `top4`:**
   - `top4` is sliced *before* checking `invCount`, so `top4` frequently contains 0 inverted clusters (or 2 inverted clusters) and forms a degenerate interior triangle/quadrilateral instead of the 4 outer corners of the code.

---

### 2. Permanent Poison Lock in `FrameDecoder` & `trackCornersROI` (`src/vision/frameDecoder.js` & `src/vision/finder.js`)

In `src/vision/frameDecoder.js` (`lines 47–63`):
```js
const finderRes = findCorners(rgba, width, height, {
  prevCorners: this.prevCorners
});

if (!finderRes.found || !finderRes.corners) {
  this.prevCorners = null;
  this.lockCount = 0;
  return { ok: false, error: 'FINDER_NOT_FOUND', stats: { totalMs: performance.now() - t0 } };
}

const corners = finderRes.corners;
this.prevCorners = [corners.TL, corners.TR, corners.BL, corners.BR];
this.lockCount++;
```
And in `src/vision/finder.js` (`lines 169–197`):
```js
for (let i = 0; i < 4; i++) {
  const prior = prevCorners[i];
  const isInverted = (i === 3); // BR is inverted
  const isCore = (cd) => isInverted ? cd >= 25 : cd <= -25;

  const cx = Math.round(prior.x);
  const cy = Math.round(prior.y);

  let top = cy;
  while (top > Math.max(2, cy - 25) && isCore(getCdiff(cx, top))) top--;
  let bot = cy;
  while (bot < Math.min(height - 3, cy + 25) && isCore(getCdiff(cx, bot))) bot++;
  const coreH = bot - top - 1;
  if (coreH < 4) return { found: false };
  ...
```
- **Poison lock:** If Frame 0 locks onto 3 corners + 1 interior data cell/pilot block (or background object), all 4 stripes fail (`validStripesCount === 0`), **but `this.prevCorners` is still saved**! On Frame 1+, `trackCornersROI` only checks `coreH >= 4` and `coreW >= 4` (no ring check, no max core size check). As long as those 4 locations sit on $\ge 4\text{ px}$ patches with `|R - G| >= 25`, `trackCornersROI` returns `found: true` forever, and `FrameDecoder` never resets `this.prevCorners` when `validStripesCount === 0` or after 15 frames (`this.lockCount` is never read).
- **No search window on real corners:** When `prevCorners` *is* on a real corner, `trackCornersROI` starts its `while` loop at `(cx, cy)` without searching a local window if `isCore(getCdiff(cx, cy))` is false. At `5 px/cell`, the $3 \times 3$ core has a radius of only `7.5 px`; if hand movement between frames exceeds `7.5 px`, `top === cy`, `bot === cy`, `coreH = -1 < 4`, and ROI tracking immediately drops lock.

---

### 3. Systematic `+1.0 px` Bottom-Right Coordinate Bias (`src/vision/finder.js`, `src/vision/sampler.js`, `src/vision/pilots.js`)

1. **Finder Centroid Bias (`+0.5 px` in `src/vision/finder.js` lines 185, 195, 263, 271):**
   ```js
   let topCore = cy;
   while (topCore > 2 && isCore(getCdiff(cx, topCore))) topCore--;
   let botCore = cy;
   while (botCore < height - 3 && isCore(getCdiff(cx, botCore))) bot++;
   ...
   const refinedY = (topCore + botCore + 1) * 0.5;
   ```
   When the core spans integer pixel indices `[y_first .. y_last]`, the `while` loops terminate at `topCore = y_first - 1` and `botCore = y_last + 1`.
   The mean pixel index of the core is:
   $$\frac{y_{\text{first}} + y_{\text{last}}}{2} = \frac{(\text{topCore} + 1) + (\text{botCore} - 1)}{2} = \frac{\text{topCore} + \text{botCore}}{2}$$
   Adding `+ 1` in `(topCore + botCore + 1) * 0.5` shifts every detected corner by **`+0.5 px`** in both X and Y relative to 0-indexed pixel centers.

2. **Sampler $2 \times 2$ Flooring Bias (`+0.5 px` in `src/vision/sampler.js` lines 43–56):**
   ```js
   const { x, y } = projectH(H, uRef, vRef);
   const ix = Math.floor(x);
   const iy = Math.floor(y);
   ...
   const o00 = (iy * width + ix) * 4;
   const o10 = o00 + 4;
   const o01 = ((iy + 1) * width + ix) * 4;
   const o11 = o01 + 4;
   ```
   Averaging pixel indices `ix` and `ix + 1` samples a $2 \times 2$ footprint centered at pixel index **`(ix + 0.5, iy + 0.5)`**.
   Because `projectH(H, uRef, vRef)` already includes the `+0.5 px` bias from `finder.js` (`x = x_true + 0.5`), `ix = Math.floor(x_true + 0.5)` rounds to `Math.round(x_true)`, so the $2 \times 2$ block `[ix, ix + 1]` is centered at **`x_true + 0.5` to `x_true + 1.0`** in pixel-index space!
   - At `codeHeightFrac = 0.5` on a 720p camera (`4.5 px/cell`, where the core is `3.6 px` wide), a `+1.0 px` shift places the right column (`ix + 1`) and bottom row (`iy + 1`) of the $2 \times 2$ sample window **on the black guard border (`[0, 0, 0]`)**.
   - **Empirical verification:** In L2 simulation (`1280×720`, `codeHeightFrac = 0.5`, `yaw = 5°`, `pitch = 5°`), subtracting `0.5 px` from the detected corners reduces per-stripe symbol errors from **`38–55 / 1446` (stripes fail RS/CRC)** down to **`5–8 / 1446` (100% of stripes decode cleanly)**.

3. **Pilot $3 \times 3$ Window Bleeds into Guard Bands (`src/vision/pilots.js` lines 41–59):**
   - `PilotCalibrator` samples a $3 \times 3$ pixel block (`dx, dy ∈ [-1, 0, 1]`) around `Math.round(x)` for each `1×1` pilot cell. At `4.5–6 px/cell` (core width `3.5–4.8 px`), a $3 \times 3$ window shifted by `+0.5 px` overlaps the black guard border, depressing `rHi, gHi, bHi` and skewing the thresholds `Tr, Tg, Tb`.
   - Furthermore, on lines 87–89 (`const Tr = (rHi - rLo > 30) ? (rHi + rLo) * 0.5 : 128;`), if local glare reduces contrast to $\le 30$ (e.g., `rHi = 245, rLo = 220`), falling back to hardcoded `128` forces every bit in that glare region to slice to `1`.

---

### 4. Broken Timing Track Refiner (`src/vision/timing.js`)

Look at `src/vision/timing.js` (`lines 76–90`):
```js
let contrast = 0;
// Top and bottom timing edges (step 2 for speed)
for (let c = 8; c <= 71; c += 2) {
  const s = ((c - 8) & 1) === 0 ? 1 : -1;
  const pT = dist(projectH(H_u, c + 0.5, 0.5));
  const pB = dist(projectH(H_u, c + 0.5, 79.5));
  contrast += s * getLuma(pT.x, pT.y) + s * getLuma(pB.x, pB.y);
}
// Left and right timing edges
for (let r = 8; r <= 71; r += 2) {
  const s = ((r - 8) & 1) === 0 ? 1 : -1;
  const pL = dist(projectH(H_u, 0.5, r + 0.5));
  const pR = dist(projectH(H_u, 79.5, r + 0.5));
  contrast += s * getLuma(pL.x, pL.y) + s * getLuma(pR.x, pR.y);
}
```
- **Bug 4.1 (`s` is always `+1`):** Because `c` starts at `8` and increments by `2` (`c = 8, 10, 12, ..., 70`), `c - 8` is **always even**, so `((c - 8) & 1)` is **always `0`** and `s` is **always `+1`**! The dark timing cells at odd indices (`9, 11, 13, ...`) are never sampled or subtracted. Instead of measuring white-minus-dark contrast along the timing track, `contrast` simply sums raw luminance at even positions. When the area outside the code is bright (e.g., `#808080` quiet zone, white monitor background, or screen glare) or corners are slightly off, `TimingRefiner` selects an extreme `bestK1` that bows sampling coordinates toward brighter pixels (up to the `±2.0` cell clamp on lines 163–164!).
- **Bug 4.2 (Elliptical normalization & fixed optical center):** Lines 56–65 normalize `(x, y)` by `cx = width * 0.5` and `cy = height * 0.5` (`nx = (pt.x - cx) / cx`, `ny = (pt.y - cy) / cy`). On a `1280×720` or `720×1280` frame, `cx !== cy`, making `nx² + ny²` elliptical instead of radially symmetric in pixel space (`scale = Math.min(cx, cy)` or `Math.hypot(cx, cy)`).
- **Bug 4.3 (Missing border-residual Coons patch):** `TimingRefiner` never measures local timing cell centroids along the 4 edges to correct translational/projective drift between the 4 corner finders and interior cells (as specified in `chroma-stripe-plan1.md` §2.7 step 5 and R13).

---

### 5. Receiver Web App & Worker Bugs (`web/js/receive-app.js` & `web/js/rx-worker.js`)

#### 5.1 Canvas Dimension Mismatch on Mobile Portrait Streams (`web/js/receive-app.js` lines 155–165, 206–225)
```js
// web/js/receive-app.js:155-165
function startReceiving() {
  overlayCanvas = document.getElementById('overlayCanvas');
  overlayCanvas.width = video.videoWidth || 1280;
  overlayCanvas.height = video.videoHeight || 720;
  ...
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = overlayCanvas.width;
  offscreenCanvas.height = overlayCanvas.height;
```
```js
// web/js/receive-app.js:210-221
if (!workerBusy && video.readyState >= 2) {
  workerBusy = true;
  offscreenCtx.drawImage(video, 0, 0);
  const imgData = offscreenCtx.getImageData(0, 0, video.videoWidth, video.videoHeight);
```
- On mobile browsers (iOS Safari, Android Chrome) held in portrait orientation, `getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } })` often delivers a **`720 × 1280`** portrait buffer, or updates `video.videoWidth` / `video.videoHeight` asynchronously after `video.play()` or on device rotation.
- Because `offscreenCanvas.width` and `offscreenCanvas.height` are never updated inside `captureLoop()` to match `video.videoWidth` and `video.videoHeight`:
  - If `offscreenCanvas` defaulted to `1280×720` while `video` is `720×1280`, `drawImage(video, 0, 0)` clips the bottom 560 pixels of the video (`y = 720..1279`), and `getImageData(0, 0, 720, 1280)` fills the bottom 560 rows with transparent black `(0,0,0,0)`, cutting off the bottom finders (`BL`, `BR`).
  - If `video.videoWidth === 0` on the first frame tick, `getImageData(0, 0, 0, 0)` throws an uncaught `IndexSizeError` after `workerBusy = true` (`line 211`) and before `scheduleNextFrame()` (`line 226`), permanently halting frame capture.

#### 5.2 Unhandled Worker Errors Permanently Deadlock `workerBusy` (`web/js/rx-worker.js` lines 11–58)
- `rx-worker.js` has no `try / catch` block in `self.onmessage`. If `rxSession.ingestPacket()` / `_finalize()` throws an error, `self.postMessage` is never called, so `workerBusy` in `receive-app.js` stays `true` forever and no further camera frames are ever processed.

#### 5.3 No Session Reset When Switching Files (`src/session/rxSession.js` lines 36–43)
- Once `rxSession` locks onto the first valid stripe's `sessionId`, any packet with a different `sessionId` returns `false` (`line 42`). If you change the file or settings on the sender, the phone silently ignores all new packets forever unless the page is reloaded.

---

### 6. Fountain Schedule, Late-Join Stall, and Sender Sizing (`src/fountain/`, `web/js/`)

#### 6.1 Phase 1 Systematic Sweep Never Repeats -> Late-Joining Phone Stalls at `0.0 KB/s`
- In `src/fountain/schedule.js` (`lines 70–103`), seeds `0 .. K - 1` are Phase 1 (Systematic, degree 1), seeds `K .. 1.15 * K - 1` are Phase 2 (Strided Parity, degree 3), and **all seeds `>= 1.15 * K` forever after are Phase 3 (Rateless Fountain)**.
- At 15 fps (60 droplets/second), Phase 1 finishes in **0.38 s for a 10 KB file (`K = 23`)** and **1.9 s for a 50 KB file (`K = 115`)**.
- In real usage, a user clicks **"Start Transmission"** on the computer first and then aims their phone camera several seconds later—meaning **the phone almost always joins during Phase 3**.
- In Phase 3, `sampleResidualDegree` (`src/fountain/degree.js` lines 15–38) emits **only 5% degree-1 droplets** (`r < 0.05`) and 95% degree 2–20 droplets. Without the 85% systematic foundation from Phase 1, the peeling decoder (`_peelCascade`) cannot peel: ~90% of incoming droplets remain unsolved in `this.waitingList`.
- Meanwhile, `web/js/receive-app.js` (`lines 42–50`) calculates `Progress` and `Throughput` (`rxSpeed`) exclusively from **`progress.solvedCount`**:
  ```js
  // web/js/receive-app.js:46-50
  if (progress.solvedCount > 0 && startTime > 0) {
    const elapsed = (performance.now() - startTime) / 1000.0;
    const kb = (progress.solvedCount * 448) / 1024.0;
    document.getElementById('rxSpeed').textContent = `${(kb / Math.max(0.1, elapsed)).toFixed(1)} KB/s`;
  }
  ```
  Because droplets sitting in `waitingList` do not increment `solvedCount` until `waitingList.length >= numUnknowns` triggers Gaussian Elimination at the very end of the transfer, the UI displays **`0.0 KB/s` (or a tiny fraction)** during the entire collection phase!

#### 6.2 Post-Systematic Degree Distribution Does Not Scale with $K$ (`src/fountain/degree.js` lines 15–38)
- `sampleResidualDegree` uses fixed small degrees `{1, 2, 3, 5, 8, 12, 20}` with mean degree $\bar{d} = 5.6$, regardless of $K$.
- When 85–95% of blocks are already solved in Phase 1, the probability that a degree-$d$ droplet touches *zero* unknown blocks is $(1 - u)^d$. At $5\%$ loss ($u = 0.05$), **76% of all Phase 3 droplets touch only already-solved blocks and cancel out to zero (`activeIndices.length === 0`)**!
- This is already visible in `reports/L0-summary.md`, where at $K = 200$:
  - `5%` loss requires **64.4% fountain overhead** ($\epsilon = 0.644$),
  - `15%` loss requires **74.5% fountain overhead**,
  - `30%` loss requires **91.6% fountain overhead**,
  even though the report's static footer falsely claims *"Overhead target $\epsilon \le 0.08$ is achieved"*.
- Periodic systematic/parity interleaving (e.g., cycling Phase 1+2 every $1.5K$ or $2K$ seeds, or scaling residual degree as $\approx \min(K, \max(8, \text{round}(0.15 K)))$) fixes both late-join and high-$K$ coupon-collector overhead.

#### 6.3 Windowed Auto-Sizing Produces a Tiny Code on Laptop Screens (`web/js/tx-render.js` lines 52–102)
- `computeAutoCorePx()` computes available height in windowed mode as `vh - topOffset - padY - belowOffset` in CSS pixels (ignoring `window.devicePixelRatio`). On a typical laptop browser window (`vh ≈ 700–800 CSS px`), `topOffset + padY + belowOffset` consumes ~430 px, leaving `availH ≈ 270–370 px`, which clamps `corePx` to `3` (`400×400` px) or `4` (`480×480` px).
- Physically, a `400×400` CSS px canvas on a laptop screen is only ~8–10 cm wide. At a 35–45 cm viewing distance, the 80×80 grid occupies less than 40% of the phone camera frame (`< 4.5 px/cell`), falling below the resolution threshold where `finder.js` and `sampler.js` can recover packets.

#### 6.4 Portrait Rolling-Shutter Tear Axis (`web/send.html` & `web/receive.html`)
- Mobile phone CMOS sensors scan along the **landscape** axis. When a user holds their phone vertically (portrait) to scan a laptop screen, rolling-shutter tear lines run **vertically** through the code, slicing across **all 4 horizontal stripes at once** instead of isolating the tear to 1 stripe. Neither an alternating `0°/90°` rotation schedule on the sender nor an orientation hint on `receive.html` is active by default.

---

### 7. Simulator & Loopback Bugs (`web/sim.html`, `sim/run.js`, `sim/camera/timing.js`)

1. **`txFramesMap.delete(frameNo - 15)` Deletes Active TX Frames After 1 Second (`web/sim.html` line 174 & `sim/run.js` line 174):**
   ```js
   // web/sim.html:170-175 & sim/run.js:169-175
   if (!txFramesMap.has(frameNo)) {
     txFramesMap.set(frameNo, txSession.getNextFrame());
   }
   if (frameNo > 15) {
     txFramesMap.delete(frameNo - 15);
   }
   ```
   - `frameNo` is the **camera** frame index at `30 fps` (`tC = frameNo * 33.33 ms`).
   - `ShutterTiming.getTxFrameBlend()` looks up the **TX** frame index at `15 fps` (`tHoldMs = 66.67 ms`), which is `frameIdx = Math.floor(tC / 66.67) = Math.floor(frameNo / 2)`.
   - At camera `frameNo = 31`, `txFramesMap.delete(31 - 15)` deletes TX frame `16`. At camera `frameNo = 32`, `ShutterTiming` requests `frameIdx = 16`, which is now `undefined`!
   - From camera frame 31 onward (`> 1.0 s`), `SyntheticCamera.captureFrame()` renders a **completely black code (`0, 0, 0`)**, causing both `web/sim.html` and `node sim/run.js --level 2` to fail with `FINDER_NOT_FOUND` on 100% of frames after frame 30!
2. **`readoutMs: 0` Overwritten by `20 ms` (`sim/camera/timing.js` line 16):**
   - `this.readoutMs = options.readoutMs || 20;` treats `0` as falsy, forcing a `20 ms` rolling shutter even in `ideal.json` (`readoutMs: 0`) or when the `sim.html` slider is set to `0 ms`.

---

## Summary Table of Bugs & Recommended Fixes

| # | Severity | File & Lines | Bug Description | Recommended Fix |
|---|---|---|---|---|
| **1** | **CRITICAL** | `src/vision/finder.js` (`L39–139`, `L214–312`) | `R - G` matches 50% of data cells; skips `<= 5 px` black guards; `clusterCandidates` merges within `30 px` ignoring `inverted`; `clusters.slice(0, 4)` drops `BL`/`BR` on scanline ties. | Require high Blue channel (`B > 110 && B > Math.min(R, G) + 40`) on core & ring; verify outer black ring (`1:1:3:1:1`); reduce transition allowance to `<= 2 px`; only cluster candidates with matching `inverted` within `~1.5 * size`; separate standard vs. inverted candidates *before* picking top corners and validate quad geometry/size consistency. |
| **2** | **CRITICAL** | `src/vision/frameDecoder.js` (`L47–63`), `src/vision/finder.js` (`L158–209`) | `this.prevCorners` stays locked even when `validStripesCount === 0`; `trackCornersROI` only checks `coreH >= 4` without ring/max-size check or local search window. | Reset `this.prevCorners = null` whenever `validStripesCount === 0` or every 15 frames; in `trackCornersROI`, search a local ROI around `prior` and call `crossCheckVertical` to verify ring ratios and max core size. |
| **3** | **CRITICAL** | `src/vision/finder.js` (`L185, 195, 263, 271`), `src/vision/sampler.js` (`L44–45`), `src/vision/pilots.js` (`L42–58`) | `+0.5 px` bias in `(topCore + botCore + 1) * 0.5` + `+0.5 px` bias in `Math.floor(x)` $2 \times 2$ sampler shifts all samples by `(+1.0 px, +1.0 px)` into the black guard band. | Use `(topCore + botCore) * 0.5` and `(leftCore + rightCore) * 0.5` in `finder.js`; use `Math.floor(x - 0.5)` / `Math.floor(y - 0.5)` for $2 \times 2$ sampling in both `sampler.js` and `pilots.js`. |
| **4** | **HIGH** | `src/vision/timing.js` (`L54–96`) | `c += 2` and `r += 2` make `s = ((c - 8) & 1) === 0 ? 1 : -1` always `+1`; non-isotropic normalization by `cx, cy`. | Step by 1 (`c++`, `r++`) so odd (dark) timing cells are subtracted (`s = -1`), and normalize radial distortion by `Math.min(cx, cy)`. |
| **5** | **CRITICAL** | `web/js/receive-app.js` (`L155–165`, `L206–225`), `web/js/rx-worker.js` (`L11–58`) | `offscreenCanvas` & `overlayCanvas` not resized when portrait camera dimensions (`720×1280`) differ from `1280×720`; no `try/catch` in worker or `captureLoop`. | Sync `offscreenCanvas.width/height` and `overlayCanvas.width/height` with `video.videoWidth/videoHeight` on every frame in `captureLoop` (and skip if `videoWidth === 0`); wrap worker `onmessage` in `try/catch` so `workerBusy` always resets. |
| **6** | **HIGH** | `src/fountain/schedule.js` (`L70–103`), `src/fountain/degree.js` (`L15–38`), `web/js/receive-app.js` (`L42–50`) | Phase 1 never repeats (late joiners enter Phase 3 with only 5% degree-1 droplets, stalling peeling); HUD only shows `solvedCount` (`0.0 KB/s` until GE); fixed max degree 20 causes 64–92% overhead at $K = 200$. | Periodically repeat systematic/parity passes or use a soliton/residual distribution that supports both peeling and high-rank GE; show received distinct equations (`solvedCount + waitingList.length`) in HUD progress/throughput. |
| **7** | **HIGH** | `web/sim.html` (`L170–175`), `sim/run.js` (`L169–175`), `sim/camera/timing.js` (`L16`) | `txFramesMap.delete(frameNo - 15)` deletes active TX frames at camera `frameNo >= 31`; `options.readoutMs || 20` ignores `0`. | Generate/prune `txFramesMap` by TX `frameIdx` (`Math.floor(tC / tHoldMs)`), not camera `frameNo`; use `options.readoutMs ?? 20`. |
