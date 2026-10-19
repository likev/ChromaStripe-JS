# ChromaStripe-JS: Directions to Further Improve Throughput (`10 KB/s → 30–100+ KB/s`)

Recent optimizations (Fourier guard-band phase refinement, 3-channel causal crosstalk slicing, 5-point spatial deblurring, incremental RS error-and-erasure decoding, and lazy-RHS Gaussian elimination) doubled real-world throughput from **`~5 KB/s` to `~10 KB/s`**.

To understand where the remaining gap lies and how to push effective goodput to **`25–45 KB/s` (v1 wire-compatible)** and **`60–120+ KB/s` (v2 protocol evolution)**, we can break throughput down into its governing equation:

$$\text{Goodput} = \underbrace{F_{\text{TX}}}_{\text{TX FPS}} \times \underbrace{P_{\text{frame}}}_{\text{1.75 KB/frame}} \times \underbrace{\eta_{\text{capture}}}_{\text{Stripe Decode Yield}} \times \underbrace{\frac{1}{1 + \epsilon_{\text{fountain}}}}_{\text{Fountain Efficiency}} \times \underbrace{R_{\text{comp}}}_{\text{Compression}}$$

At `15 fps` (`Normal`, `txHold = 4`), the raw physical link rate is **`26.25 KB/s`**; at `20 fps` (`Fast`, `txHold = 3`), it is **`35.0 KB/s`**; at `30 fps` (`Max`, `txHold = 2`), it is **`52.5 KB/s`**. Achieving `~10 KB/s` today means we are capturing roughly **35–55% of the physical link** due to a combination of:
1. **Fountain schedule & stripe-mapping stalls** (Stripe 3 systematically starving 25% of blocks across cycles, plus heavy Phase-3 degrees stalling belief propagation).
2. **Mobile CPU frame drops (`workerBusy`)** and residual `TimingRefiner` overhead.
3. **Rolling-shutter partial stripe tears** at `15–30 fps` TX.
4. **Stripe 3 residual symbol error rate** (`67.6%` yield vs. `100%` on Stripes 0–2 in `VID20261018001853.mp4`).

Below is a prioritized roadmap of concrete technical directions organized into **three tiers**:
- **Tier 1:** High-ROI, 100% v1 wire-compatible algorithmic improvements (`10 KB/s → 25–35 KB/s`).
- **Tier 2:** Browser/worker concurrency, camera pipeline, and GPU readback optimizations (`25–35 KB/s → 40–50 KB/s`).
- **Tier 3:** Next-generation v1.1 / v2 modulation and framing extensions (`50 KB/s → 80–150+ KB/s`).

---

## Tier 1: Algorithmic & Schedule Improvements (100% v1 Wire-Compatible)

### 1. Fix Stripe-Locked Systematic Starvation & Shorten the Systematic Cycle (`src/session/txSession.js`)
- **The Problem:**
  In `TxSession.getNextFrame()` (`src/session/txSession.js:126-135`), frame `f` assigns `rawSeeds = [4*f, 4*f+1, 4*f+2, 4*f+3]` to Stripes `0, 1, 2, 3`, and wraps seeds modulo `cycleLen = 3 * K`.
  1. Notice that `rawSeeds[i] % 4 === i` on every frame. Whenever `K` is even or a multiple of 4 (e.g., `K = 356` in `VID20261018001853.mp4`), `cycleLen = 3 * K = 1068` is also a multiple of 4, so `(s % cycleLen) % 4 === i` forever. Because `permuteBlock(seed, K)` is deterministic from `seed`, **the exact same 25% of source blocks (`seed % 4 === 3`) are permanently pinned to Stripe 3 on every systematic cycle**. Since Stripe 3 has the lowest optical yield (bottom of screen, highest perspective foreshortening and rolling-shutter skew), those 25% of blocks are repeatedly lost on every pass!
  2. Furthermore, `cycleLen = 3 * K` spends `1.0 * K` in Phase 1 (Systematic) and **`2.0 * K` (67% of the time) in Phase 3 (Fountain)**. A receiver joining mid-cycle waits up to `2 * K` droplets before seeing systematic degree-1 blocks again.
- **Direction to Try:**
  - **Rotate stripe-to-seed mapping across cycles:** Offset the wrapped seed by the cycle index `cycleIdx = Math.floor(s / cycleLen)` so that `(s % cycleLen + cycleIdx) % K` shifts each block to a different physical stripe (`0 → 1 → 2 → 3`) on consecutive cycles.
  - **Shorten `cycleLen` from `3 * K` to `1.4 * K` (or `1.5 * K`):** Spend `1.0 * K` in Phase 1 (Systematic), `0.15 * K` in Phase 2 (Strided Parity), and `0.25–0.35 * K` in Phase 3 (Fountain) before cycling back to astripe-rotated systematic sweep.
  - **Interleaved Frame Scheduling:** Alternatively, on every frame during Phase 3, dedicate 1 or 2 stripes (rotating across `0..3`) to systematic seeds `0..K-1` and the other 2–3 stripes to fountain seeds.
- **Expected Impact:** **+25% to +40% faster completion** in real-world late-join and bottom-stripe-degraded captures.

---

### 2. Rebalance Phase 3 Fountain Degree Distribution (`src/fountain/degree.js`)
- **The Problem:**
  In `sampleResidualDegree()` (`src/fountain/degree.js:21-33`), **50% of all Phase 3 droplets have huge degrees**: `0.12K` (20%), `0.25K` (15%), and `0.50K` (15%).
  - On `VID20261018001853.mp4` (`K = 356`), out of `260` unique received droplets, belief propagation only peels **`29` blocks (`11%`)**, leaving `230` dense equations sitting in `waitingList`.
  - High-degree droplets (`d = 43, 89, 178`) cannot be peeled until `>95%` of blocks are already solved, AND each incoming droplet must XOR up to `178 × 112` `Uint32` words during ingestion and peeling.
- **Direction to Try:**
  - Shift to a **Raptor-style sparse + capped inactivation distribution**:
    - `15%` degree 1
    - `40%` degree 2
    - `20%` degree 3
    - `12%` degree 4–6
    - `8%` degree 8–16
    - `5%` dense inactivation (`min(K, max(16, round(0.15 * K)))`) to guarantee full GF(2) matrix rank during end-game Gaussian elimination.
- **Expected Impact:** Keeps the belief-propagation ripple active throughout Phase 3, reduces fountain overhead $\epsilon$ from `~10–15%` toward `~3–6%`, and cuts per-droplet XOR work by **3–4×**.

---

### 3. Bypass Redundant 10-Step Radial `k1` Search in `TimingRefiner` (`src/vision/timing.js`)
- **The Problem:**
  Even after adding `_computeGuardPhaseField()`, `TimingRefiner._analyze()` (`src/vision/timing.js:149-167`) still runs `evalContrast(k)` across 10 candidate `k1` values (`solveHomography` 10× + `2,560` border pixel projections) on **every single frame** before entering the `else { this._computeGuardPhaseField(...) }` branch!
  - Worse, if noise or glare ever causes `Math.abs(bestK1) > 0.005` to win by a tiny margin, `_computeGuardPhaseField()` is **skipped completely**, losing the 8×8 interior phase warp correction!
- **Direction to Try:**
  1. **Always run `_computeGuardPhaseField()`** as the primary 2D warp estimator (since an 8×8 arbitrary displacement grid $(du, dv)$ already subsumes radial barrel distortion *plus* projective/rolling-shutter skew in `0.3 ms`).
  2. Remove the 10-step `evalContrast(k)` loop from the per-frame hot path (or run it only once when `lockCount === 1` and compose it with `_computeGuardPhaseField`).
  3. **Improve Stripe 3 phase accuracy in `_computeGuardPhaseField()`:**
     - Currently, corner blocks `(7, 0)` and `(7, 7)` are skipped entirely because of the 8×8 finders, leaving the bottom-left and bottom-right of Stripe 3 without direct phase measurements. However, in block `(7, 0)` (`rows 70..79, cols 0..9`), columns `8..9` are data cells, and in `(7, 1)..(7, 6)` (`cols 10..69`), all rows `70..78` are data cells! Including all non-finder cells (`layout.cellClass !== 1`) in all 64 blocks and sampling every row (`r += 1` instead of `r += 2`) in the bottom row of blocks (`qr === 7`) will sharpen vertical phase tracking in Stripe 3.
- **Expected Impact:** Cuts **3–5 ms/frame on desktop (`10–15 ms/frame` on mobile ARM)** and improves Stripe 3 decode yield.

---

### 4. Decision-Directed 8-Color Centroid Tracking & Adaptive Crosstalk (`src/vision/sampler.js`, `src/vision/pilots.js`, `src/vision/frameDecoder.js`)
- **The Problem:**
  1. `sliceCellCausal()` (`src/vision/sampler.js:20-44`) uses hardcoded crosstalk offsets (`+14 / -10`, `+6 / -10`, `+13 / -10`) tuned on one camera/screen pair. Different displays (OLED vs. IPS, Night Shift, sRGB vs. P3) and different phone ISPs have different cross-channel leakage matrices and contrast swings.
  2. The 16 embedded `2×2` pilot blocks only contain **4 of the 8 constellation symbols**: `White (111)`, `Black (000)`, `Cyan (011)`, and `Magenta (101)`. They never directly measure `Red (100)`, `Green (010)`, `Blue (001)`, or `Yellow (110)` (where Green-to-Red and Blue-to-Green crosstalk errors actually occur!).
- **Direction to Try:**
  - **Pilot-Proportional Crosstalk Offsets:** Scale the crosstalk terms in `sliceCellCausal` proportionally to the local channel swings `(rHi - rLo)`, `(gHi - gLo)`, `(bHi - bLo)` and measured pilot leakages `cR - kR` (Cyan Red-leak) and `mG - kG` (Magenta Green-leak) from `PilotCalibrator`.
  - **Decision-Directed Online 8-Centroid Calibration (Using RS-Decoded Stripes as Ground-Truth Pilots!):**
    - Whenever *any* stripe (e.g., Stripe 0, 1, or 2) passes RS + CRC32 verification, re-encode the corrected 542-byte packet into its **exact 1,446 ground-truth 3-bit symbols**.
    - Group that stripe's 1,446 sampled `[R, G, B]` values by their ground-truth symbol `sym ∈ {0..7}` (`~180` samples per color per stripe!).
    - Maintain a fast exponential moving average (EMA) of the 8 3D RGB cluster centroids $\boldsymbol{\mu}_0, \dots, \boldsymbol{\mu}_7 \in \mathbb{R}^3$ (and per-channel variances) per stripe/vertical band.
    - Slice cells using **Nearest Centroid / Mahalanobis Distance** to the 8 learned symbol clusters:
      $$\hat{s} = \arg\min_{k \in \{0..7\}} \|\mathbf{y}_{\text{deblur}} - \boldsymbol{\mu}_k\|_W^2$$
    - If Stripe 2 decodes cleanly on Frame $t$, its learned 8-color centroids (adjusted by the vertical pilot ratio between Stripe 2 and Stripe 3) immediately calibrate Stripe 3 on the very same frame!
- **Expected Impact:** Eliminates camera/screen-specific color tuning sensitivities and lifts Stripe 3 capture yield from `~68%` toward **`95%+`**.

---

### 5. Row-Wise Rolling-Shutter Tear Detection, RS Row Erasures, & Sub-Stripe Stitching (`src/vision/frameDecoder.js`)
- **The Problem:**
  Currently, when the user increases TX speed to `15 fps` (`txHold = 4`), `20 fps` (`txHold = 3`), or `30 fps` (`txHold = 2`), a CMOS rolling shutter (~15–25 ms readout time) frequently catches a display transition mid-stripe.
  - `FrameDecoder.decode()` (`src/vision/frameDecoder.js:179-186`) computes a single scalar `mad` across all `1,446` cells of the stripe.
  - If a rolling-shutter tear crosses row 50 (inside Stripe 2, rows `40..58`), whole-stripe `mad` jumps above `15`, so temporal accumulation resets (`st.count = 1`) and the 2-frame pair average is skipped.
- **Direction to Try:**
  1. **Per-Row `mad[r]` Computation:** Compute `mad` separately for each of the 19–21 rows in the stripe (~75 cells per row).
  2. **Localized Transition-Row Erasure:** If 1 or 2 rows in a stripe are caught mid-transition (e.g., `mad[r] > 18` while the other 18 rows have `mad[r] < 8`), assign confidence `margin = 0` to all cells in those 1–2 rows. Since 1 row is ~28 bytes (only **~9 bytes per interleaved RS codeword**), `fastDecodeCodeword` with $n_{\text{sym}} = 27\text{–}28$ can erase a completely destroyed row and still have $t = \lfloor(27 - 9)/2\rfloor = 9$ full byte-error corrections left for the rest of the stripe!
  3. **Cross-Frame Complementary Tear Stitching:**
     - During a transition from TX Frame $A$ to TX Frame $B$ on Camera Frame $t$, the top rows `rStart .. rTear` of Stripe $s$ show new Frame $B$, while the bottom rows `rTear+1 .. rEnd` still show old Frame $A$.
     - On the previous Camera Frame $t-1$, the bottom rows `rTear+1 .. rEnd` ALSO showed Frame $A$ (and on the next Camera Frame $t+1$, the bottom rows will show Frame $B$).
     - By splicing `[prevRgb(rStart..rTear), curRgb(rTear+1..rEnd)]`, the decoder can reconstruct an untorn stripe across adjacent camera frames even at **20–30 fps TX**!
- **Expected Impact:** Unlocks reliable **20–30 fps TX (`Fast` / `Max`)**, raising the usable physical link rate from `17.5–26.25 KB/s` to **`35–52.5 KB/s`**.

---

### 6. Inner-Core Multi-Point Sampling & Bit-Straddle Erasure Mapping (`src/vision/sampler.js`, `src/core/bitpack.js`, `src/core/reedsolomon.js`)
- **The Problem:**
  1. `sampleFullGrid()` samples a single bilinear point `(c + 0.5 + du, r + 0.5 + dv)` per cell. At `720p/1080p`, each cell core covers `5×5` to `8×8` camera pixels, and H.264 4:2:0 video compression introduces $4\times 4$ / $8\times 8$ DCT ringing and mosquito noise at single pixels.
  2. In `bitpack.js`, each 3-bit symbol is packed MSB-first into bytes. Every 8 symbols (24 bits = 3 bytes), symbols 2 and 5 straddle **two consecutive bytes** (`bitPos % 8 === 6` or `7`). A single noisy cell at a straddle boundary corrupts **2 bytes** (which land in two different interleaved RS codewords), whereas `symbolsMarginsToByteMargins` simply takes the minimum margin without boosting erasure priority for straddling cells or per-channel bit margins.
  3. `parsePacket` and `fastDecodeCodeword` allocate dozens of temporary `Uint8Array`, `Float32Array`, and JS `Array` objects per stripe per frame.
- **Direction to Try:**
  - **5-Point Inner-Core Cross Sampling:** Sample `(u, v)` plus 4 symmetric offsets `(u ± 0.14, v)` and `(u, v ± 0.14)` inside the flat core (weighted `[0.4, 0.15, 0.15, 0.15, 0.15]`), averaging out pixel-level sensor and H.264 noise before the 5-point cell-lattice deblur filter.
  - **Adaptive Erasure Trial Stepping & Zero-Allocation RS Scratch Pool:** Preallocate all codeword, syndrome, polynomial, and margin buffers on module load, and select erasure counts adaptively based on the number of bytes with `margin < T_erasure` (reducing RS trial iterations from 11 down to 2–3 per failed codeword).
- **Expected Impact:** **+15–20% lower symbol error rate** and **~30% faster `parsePacket` CPU time**.

---

## Tier 2: Concurrency, Camera Pipeline & Pacing Optimizations

### 7. Multi-Worker RX Pool (2–3 Web Workers) to Eliminate `workerBusy` Frame Drops (`web/js/receive-app.js`, `web/js/rx-worker.js`)
- **The Problem:**
  `receive-app.js:220` uses a single Web Worker with `if (!workerBusy)` backpressure.
  - On a mid-range smartphone CPU, `FrameDecoder.decode()` takes `20–30 ms` on frames that require RS erasure trials or full-frame finder scans.
  - At `60 fps` (`16.67 ms` per camera frame), a single worker drops **every second camera frame (`30 fps` effective capture)**. Dropping half the camera frames halves temporal averaging opportunities and causes missed hold windows at `15–20 fps` TX.
- **Direction to Try:**
  - Spawn **2 (or `Math.min(3, navigator.hardwareConcurrency - 1)`) Vision Workers** that run `FrameDecoder.decode()` in parallel on round-robin camera frames (`frameIdx % numWorkers`), while `RxSession` / `FountainDecoder` lives in one coordinator worker (or main thread since `ingestPacket` is `< 0.1 ms` with lazy-RHS GE).
  - Share `lastCorners` across workers so all workers stay in fast ROI tracking mode (`0.3 ms` finder tracking instead of `2 ms` full scan).
- **Expected Impact:** Eliminates `workerBusy` frame drops on mobile devices, sustaining **full 60 fps camera processing** (`2×` more captured frames per second).

---

### 8. Cropped `drawImage` & Offscreen `VideoFrame` / `ImageBitmap` Readback (`web/js/receive-app.js`)
- **The Problem:**
  In `web/js/receive-app.js:236-254`:
  ```javascript
  offscreenCtx.drawImage(video, 0, 0); // Blits full 1280x720 (3.68 MB) every frame!
  ...
  const imgData = offscreenCtx.getImageData(sx, sy, sw, sh);
  ```
  Even when `getImageData` reads a cropped `600×600` ROI, `offscreenCtx.drawImage(video, 0, 0)` still copies the full `1280×720` video texture on the main thread every tick.
- **Direction to Try:**
  - Use the 9-argument cropped draw call:
    `offscreenCtx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)` followed by `offscreenCtx.getImageData(0, 0, sw, sh)`.
  - Where `OffscreenCanvas` is supported in Web Workers, transfer an `ImageBitmap` (`createImageBitmap(video, sx, sy, sw, sh)`) or WebCodecs `VideoFrame` directly to the worker and perform `drawImage` + `getImageData` **off the main UI thread**.
- **Expected Impact:** Cuts main-thread GPU/CPU blit overhead by **60–75%**, preventing UI/video-callback jitter on mobile browsers.

---

### 9. Explicit 60 FPS Camera Constraints & Hardware AE/AWB/Focus Locking (`web/js/receive-app.js`)
- **The Problem:**
  `receive-app.js:188-194` requests:
  ```javascript
  video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
  ```
  1. Without `frameRate: { ideal: 60, min: 30 }`, Chrome on Android and Safari on iOS default the camera sensor to **30 fps** (with a longer `16–33 ms` exposure time per frame, which *increases* motion blur and rolling-shutter transition blending!).
  2. Continuous Auto-Exposure (AE) and Auto-White-Balance (AWB) can drift during a transfer, shifting channel thresholds and increasing exposure duration in dim rooms.
- **Direction to Try:**
  - Add `frameRate: { ideal: 60, min: 30 }` to `getUserMedia` constraints. Higher shutter speed at 60 fps sharply reduces inter-frame transition blur!
  - Once corners are locked and the first stripe decodes cleanly, query `track.getCapabilities()` and lock white balance / exposure time (or cap exposure time for crisp shutter transitions) via `track.applyConstraints({ advanced: [...] })`.
- **Expected Impact:** Doubles camera capture rate from `30 fps` to `60 fps` on supported phones and reduces transition-frame blur by **~50%**.

---

### 10. Ultra-Fast `Uint32Array` LUT Renderer on Sender (`src/frame/renderer.js`)
- **The Problem:**
  `renderFrame()` (`src/frame/renderer.js:193-229`) loops pixel-by-pixel over `corePx × corePx` in `Uint8ClampedArray` (writing 4 bytes `r, g, b, a` individually per pixel) and calls `bytesToSymbols(packet, 1446)` with bit-by-bit loops.
- **Direction to Try:**
  - View `rgba.buffer` as a `Uint32Array(imgDim * imgDim)` and write 32-bit packed ABGR colors `0xFFBBGGRR` in a single word store per pixel (4× fewer memory writes).
  - Or render an `800×800` base image (or `80×80` core layer) using a WebGL / CSS `image-rendering: pixelated` canvas so high-DPI screens (`1280×1280`) require zero CPU upscaling.
- **Expected Impact:** Reduces TX frame generation + blit time to **`< 0.2 ms`**, ensuring zero dropped VSync intervals at `20–30 fps` on mobile senders.

---

## Tier 3: Protocol & Modulation Evolution (v1.1 / v2 Roadmap)

If changing or extending the wire format (via `ver = 2` or header `reserved[1:0]` mode flags) is acceptable in future versions, physical link capacity can be multiplied by **2× to 4×**:

### 11. Higher-Order Color Constellation: 4-PAM on R & G (`[4×4×2] = 5 bits/cell` or `[4×4×4] = 6 bits/cell`)
- **Why It Works:**
  In `VID20261018001853.mp4`, after 5-point spatial deblurring and causal crosstalk cancellation, the High-vs-Low channel separation is `~140–160` ADC counts while within-symbol standard deviation in Stripes 0–2 is only `~10–13` counts (`SNR > 20 dB`).
  - Increasing from **3 bits/cell** (`2×2×2` RGB) to **5 bits/cell** (`4-level R × 4-level G × 2-level B = 32 colors`) increases payload per frame by **+66.7%** (`1.75 KB/frame → 2.92 KB/frame`).
  - Increasing to **6 bits/cell** (`4×4×4 = 64 colors`) **doubles** payload per frame (`1.75 KB/frame → 3.50 KB/frame` = **`70 KB/s` raw at 20 fps**).
  - Using **Gray coding** on each 4-PAM channel (`00 → 40, 01 → 112, 11 → 184, 10 → 255`) ensures that adjacent-level slicing errors only flip **1 bit** out of 2, and our `4×4` pilot blocks can directly include the intermediate levels `(112, 184)` for non-linear gamma calibration.

### 12. 8 Micro-Stripes (`10 Rows/Stripe`) with Single-Codeword RS (`N = 255`)
- **Why It Works:**
  Currently, the `80×80` grid is split into 4 stripes of 20 rows (`542 bytes/stripe`), requiring 3 interleaved RS codewords per stripe.
  - Splitting the grid into **8 horizontal micro-stripes of 10 rows each** (~728 cells = `273 bytes` -> fits in a **single GF(256) RS codeword of length $\le 255$** or `270 bytes`!):
    1. **Halves the rolling-shutter tear blast radius:** A horizontal tear line only touches **1/8 of the frame (12.5%)** instead of **1/4 (25%)**, increasing usable stripe yield at `20–30 fps` TX from `~75%` to **`~88–90%`**.
    2. **Eliminates RS interleaving overhead** and simplifies decoding per micro-stripe.

### 13. Adaptive Grid Density (`96×96` or `112×112` Mode) & Reclaiming Unused Cells
- **Reclaim the 40 wasted fill cells in v1:** Stripes 1 and 2 have `1,466` data cells (`549.75 bytes`), of which `20` cells (`7.5 bytes/stripe = 15 bytes/frame`) are currently padded with unused fill symbols (`src/frame/renderer.js:214-220`).
- **Adaptive Grid Resolution (`96×96` / `112×112`):** On desktop/tablet screens captured at `720p/1080p`, each `80×80` cell currently spans `8.5–12` camera pixels, whereas reliable sampling only requires `~5.5` camera pixels/cell.
  - A **`96×96` grid** increases data cells by **+46%** (`2.56 KB/frame` at 3 bits/cell).
  - A **`112×112` grid** increases data cells by **+100%** (`3.50 KB/frame` at 3 bits/cell, or **`7.0 KB/frame = 140 KB/s` at 20 fps** when combined with 6-bit `4×4×4` color modulation!).

### 14. Adaptive Inner RS Parity Rate (`High-Rate Mode`)
- Currently, 82 out of 542 bytes (**15.1%**) in every stripe are dedicated to RS parity (`nsym = 28, 27, 27`).
- In clean indoor conditions where single-frame symbol errors are `< 15` per stripe, reducing RS parity to `nsym = 14` (`42 parity bytes` instead of `82`) expands the net fountain payload from `448 bytes` to **`488 bytes/stripe` (+8.9% goodput)** at zero hardware cost.

### 15. Stronger Pre-Compression & Lightweight Optical/Audio Backchannel
- **Pre-Compression (`src/session/compression.js`):** Support Brotli/Zstd or pre-filtering (e.g., delta/dictionary compression for small files, or WebP/AVIF transcoding for raw images) before fountain packetization.
- **1-Bit Acoustic or Screen-Flash Return Channel:** A tiny optional ultrasonic/audible chirp (via Web Audio `OscillatorNode` → Sender `AnalyserNode`) or camera torch flash can notify the sender when:
  1. Receiver has locked corners and finished systematic Phase 1.
  2. Receiver decode rate supports stepping up from `15 fps` to `20–30 fps`.
  3. Transfer is `100%` complete (auto-advancing multi-file queues).

---

## Summary Comparison of Directions

| # | Direction | Tier | Wire-Compatible? | Effort | Expected Goodput Gain |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **1** | **Rotate Stripe-Seed Mapping per Cycle & Shorten Cycle (`3K → 1.4K`)** | Tier 1 | ✅ Yes | Low | **+25% – 40%** (eliminates Stripe 3 systematic starvation) |
| **2** | **Rebalance Phase 3 Degree Distribution (Sparse + Capped Inactivation)** | Tier 1 | ✅ Yes* | Low | **+15% – 25%** (restores Phase 3 peeling, cuts GE stall) |
| **3** | **Remove 10-Step `evalContrast(k)` from `TimingRefiner` + Full Bottom-Row Phase** | Tier 1 | ✅ Yes | Low | **-3 to -10 ms/frame CPU**, higher Stripe 3 yield |
| **4** | **Decision-Directed 8-Color Centroid Tracking (Use RS-Valid Stripes as Pilots)** | Tier 1 | ✅ Yes | Medium | **+15% – 25%** (lifts Stripe 3 yield from ~68% to 95%+) |
| **5** | **Row-Wise Tear Detection, Transition-Row Erasures & Cross-Frame Stitching** | Tier 1 | ✅ Yes | Medium | **+40% – 80%** (unlocks reliable 20–30 fps TX) |
| **6** | **5-Point Inner-Core Sampling & Zero-Alloc Adaptive RS Trials** | Tier 1 | ✅ Yes | Low–Med | **+10% – 15%** yield, **-30% RS CPU time** |
| **7** | **Multi-Worker RX Pool (2–3 Workers Round-Robin)** | Tier 2 | ✅ Yes | Medium | **Up to +60% on mobile** (0 `workerBusy` frame drops at 60 fps) |
| **8** | **Cropped `drawImage` + `OffscreenCanvas` / `ImageBitmap` Worker Readback** | Tier 2 | ✅ Yes | Low | **-60% main-thread readback time** |
| **9** | **Request `frameRate: { ideal: 60 }` & Lock AE/AWB on Camera Track** | Tier 2 | ✅ Yes | Low | **2× camera frame rate**, 50% less motion/tear blur |
| **10** | **32-Bit Word-Packed `Uint32Array` TX Renderer** | Tier 2 | ✅ Yes | Low | **`< 0.2 ms` TX render** (stable 20–30 fps on mobile TX) |
| **11** | **5-Bit (`4×4×2`) or 6-Bit (`4×4×4`) Color Constellation** | Tier 3 | ❌ v2 | Medium | **+67% to +100% raw link rate** (`50–70 KB/s`) |
| **12** | **8 Micro-Stripes (`10 rows` each) + Single RS Codeword** | Tier 3 | ❌ v2 | Medium | **Halves rolling-shutter tear loss** at 20–30 fps |
| **13** | **Adaptive `96×96` / `112×112` Grid Density Mode** | Tier 3 | ❌ v2 | Medium | **+46% to +100% raw link rate** (`70–140 KB/s`) |

*(Note on #2: Changing `sampleResidualDegree` requires TX and RX to run the updated build; #1, #3, #4, #5, #6, #7, #8, #9, #10 are 100% interoperable even between unupdated TX/RX peers.)*
