# ChromaStripe-JS Root-Cause Review: Why Both v1 and v2 Are Failing (`review3.md`)

## 1. Executive Summary

Following the Tier 1 (`d32f719`), Tier 2 (`a9430f9`), Tier 3 v2 (`228290c`), and post-v2 (`63bc6e0`, `90ed052`) commits, **both v1 and v2 optical transfers fail in real-world and simulated end-to-end operation**.

We audited the entire TX/RX codebase and profiled both protocol versions against:
1. The real-world v1 smartphone capture `/root/upload/files/VID20261018001853.mp4` (`720×1280` @ 60 fps, 421 frames, `80×80` v1).
2. The real-world v2 smartphone capture `/root/upload/files/VID20261019203625.mp4` (`720×1280` @ 60 fps, 499 frames, `80×80` v2 6-bit 4-PAM, 8 micro-stripes).
3. The sender UI screenshot `/root/upload/files/Screenshot 2026-10-19 at 20-15-05 Send a File — ChromaStripe-JS.png` (`96×96` v2 Turbo).
4. The Level-2 synthetic camera benchmark (`ideal.json` and `indoor-typical.json`).

### Empirical Reproduction Summary

| Scenario / Configuration | Current Behavior (`HEAD = 90ed052`) | Root Cause(s) | Behavior With Fixes Verified |
| :--- | :--- | :--- | :--- |
| **v1 sent from `web/send.html`** (`Protocol Version: v1 Standard`) -> Receiver (`Auto` or `v1`) | **`0 / 12` stripes (`0.0%` yield)** even on **noiseless `ideal.json`** | `send-app.js:104` reads hidden `#modSelect` (`value="6"`), encoding v1 packets at **6-bit 4-PAM into 723 cells** with 4-PAM grayscale pilots | **`12 / 12` (`100.0%` yield)** |
| **v1 (`VID20261018001853.mp4`)** with Receiver in default `Auto-Detect` mode | **`59.38 ms/frame`** decode latency (**3.60× slower** than `16.48 ms` in v1 mode) | `FrameDecoder.decode()` runs all 8 stripes × 3 temporal passes of `_decodeV2Stripes` (up to 132 RS decodes) on every v1 frame before trying `_decodeV1Stripes` | **`16.48 ms/frame`** (**3.60× faster**), `281 / 284` (`98.9%`) unique seeds |
| **v1 (`VID20261018001853.mp4`)** with 3-Worker Pool (`receive-app.js`) | Stripe 3 yield drops from `95.8%` to **`78.9%`** (and temporal accum breaks at 15–30 fps) | Round-robin dispatch across 3 stateful `FrameDecoder` workers separates `prevRgb` by 3 frames ($t - 3$), breaking `mad <= 15` accumulation & tear stitching | **`98.9%` yield** (single vision state or shared frame history) |
| **v2 (`80×80`, `96×96`, `112×112`, 6-bit 4-PAM)** on `indoor-typical.json` | **`0 / 24` stripes (`0.0%` yield)** (`28.6%` symbol error rate = `95.5` errs/stripe) | `sliceCell4Pam` has **zero cross-channel crosstalk compensation**; linear-light bleed + gamma curve shifts `L0(40)` above `L1(112)` when `G` or `B = 255` | **`24 / 24` (`100.0%` yield)** (`0.37%` symbol error rate = `1.2` errs/stripe) |
| **v2 (`VID20261019203625.mp4`, `80×80`, 6-bit 4-PAM)** on real laptop/phone | **`0 / 3,992` stripes (`0.0%` yield)** across all 499 frames (`67%–93%` symbol error rate) | Linear crosstalk (`R(L0, G=255) = 144` > `R(L2, G=40) = 133`) + top LCD toe crush (`L0=28` vs `L1=34`) + bottom Blue highlight clipping (`L2=240` vs `L3=239`) + weak `nsym=14` RS | Use **3-bit 2-PAM (`bpc=3`)** for `80×80`/`96×96` v2 micro-stripes + linear crosstalk unmixing |
| **v2 (`3 bits/cell` or `5 bits/cell`)** selected in `web/send.html` | **`0.0%` yield** across all grid sizes (`80`, `96`, `112`) | `_decodeV2Stripes` (`frameDecoder.js:475`) hardcodes `this.bitsPerCell !== 3 ? ... : 6`; `getLayoutV2` (`80×80`) gives Stripes 0 & 7 only `596` cells (`223.5 B` < `250 B`), truncating packets | **`100.0%` yield** (equalized micro-stripe layout + auto `bpc` detection) |

---

## 2. The 9 Root Causes in Detail

---

### Root Cause 1: [FATAL — V1 Sender Bug] Selecting `v1 Standard` in `send.html` Secretly Transmits 6-Bit 4-PAM Hybrid Frames (`web/js/send-app.js:101-117, 136-143`, `src/frame/renderer.js:235-236, 302-313`)

#### What Happens
In [`web/send.html:78-105`](file:///root/downloads/ChromaStripe-JS/web/send.html#L78-L105), `#versionSelect` defaults to `value="2"` and `#modSelect` defaults to `value="6"` (`6 bits/cell (4-PAM RGB, 64 colors)`).
When the user switches `#versionSelect` to `"1"` (`v1 Standard (3-bit RGB, 4 Stripes)`):
1. [`web/js/send-app.js:136-143`](file:///root/downloads/ChromaStripe-JS/web/js/send-app.js#L136-L143) hides `#modField` via `modField.style.display = 'none'`, **but `#modSelect.value` remains `"6"`** (and `#gridSelect` remains unlocked, so it can stay at `96` or `112`):
   ```javascript
   // web/js/send-app.js:136-143
   if (versionSelect) {
     versionSelect.addEventListener('change', () => {
       const isV2 = versionSelect.value === '2';
       if (rateModeField) rateModeField.style.display = isV2 ? 'block' : 'none';
       if (modField) modField.style.display = isV2 ? 'block' : 'none';
       if (currentFile) handleFile(currentFile);
     });
   }
   ```
2. Inside `handleFile(file)` ([`web/js/send-app.js:101-104`](file:///root/downloads/ChromaStripe-JS/web/js/send-app.js#L101-L104)):
   ```javascript
   const version = versionSelect ? parseInt(versionSelect.value, 10) : 2;
   const gridSize = gridSelect ? parseInt(gridSelect.value, 10) : 80;
   const rateMode = rateModeSelect ? parseInt(rateModeSelect.value, 10) : 1;
   const bitsPerCell = modSelect ? parseInt(modSelect.value, 10) : (version === 2 ? 6 : 3);
   ```
   Because `modSelect` is a non-null DOM element, `modSelect ? parseInt(modSelect.value, 10) : ...` **always evaluates to `6` (or `5`) even when `version === 1`**!
3. [`TxSession`](file:///root/downloads/ChromaStripe-JS/src/session/txSession.js#L40-L43) accepts `version: 1, bitsPerCell: 6` and passes both to [`renderFrame()`](file:///root/downloads/ChromaStripe-JS/src/frame/renderer.js#L235-L313):
   - `renderFrame` sets `is4Pam = bitsPerCell >= 5` (`true`) and paints **4-PAM grayscale pilot blocks (`[40, 112, 184, 255]`)** instead of v1's `[White, Black, Cyan, Magenta]` pilots.
   - `renderFrame` computes `numPacketSymbols = Math.min(1446, Math.ceil((542 * 8) / 6)) = 723` and encodes each 542-byte v1 packet using **6-bit 4-PAM symbols into only the first 723 cells** of each 1,446-cell v1 stripe, filling the remaining 723 cells with dummy `getFillSymbols`.
4. On the receiver:
   - In `Auto-Detect` mode, `pilotCalibrator.hasPamPilots` is `true` (because of the 4-PAM grayscale pilots), so [`FrameDecoder.decode()`](file:///root/downloads/ChromaStripe-JS/src/vision/frameDecoder.js#L406) treats the frame as v2 (8 micro-stripes) and **never calls `_decodeV1Stripes`**.
   - Even if the receiver is manually set to `v1 Standard`, `_decodeV1Stripes` slices 1,446 cells at **3 bits/cell (2-PAM RGB)**, which cannot decode 723 6-bit 4-PAM cells.
   - **Result:** Every v1 transfer initiated from `send.html` has a **0.0% decode rate**.

#### Fix (`web/js/send-app.js` & `src/session/txSession.js` & `src/frame/renderer.js`)
In `web/js/send-app.js`, enforce `bitsPerCell = 3` and `gridSize = 80` whenever `version === 1`, and enforce the same invariant inside `TxSession` and `renderFrame`:
```javascript
// In web/js/send-app.js:101-105
const version = versionSelect ? parseInt(versionSelect.value, 10) : 2;
const gridSize = version === 1 ? 80 : (gridSelect ? parseInt(gridSelect.value, 10) : 80);
const rateMode = rateModeSelect ? parseInt(rateModeSelect.value, 10) : 1;
const bitsPerCell = version === 1 ? 3 : (modSelect ? parseInt(modSelect.value, 10) : 6);
```
```javascript
// In src/session/txSession.js:40-43
this.version = options.version || 1;
this.gridSize = this.version === 1 ? 80 : (options.gridSize || 80);
this.bitsPerCell = this.version === 1 ? 3 : (options.bitsPerCell || 6);
this.numStripes = this.version === 1 ? 4 : (options.numStripes || 8);
```

---

### Root Cause 2: [CRITICAL — V2 Color Physics & Slicer] Uncompensated Linear-Light Cross-Channel Crosstalk in `sliceCell4Pam` (`src/vision/sampler.js:88-141`)

#### What Happens
In [`src/vision/sampler.js:88-141`](file:///root/downloads/ChromaStripe-JS/src/vision/sampler.js#L88-L141), `sliceCell4Pam(rVal, gVal, bVal, thresh4Pam)` slices `rVal`, `gVal`, and `bVal` independently against the 1D thresholds `thresh4Pam[0..8]` interpolated from the 16 `2×2` grayscale pilot blocks (`PILOT_COLORS_4PAM_U32 = [40, 112, 184, 255]`), with **zero cross-channel crosstalk compensation**.

Why does this cause a **`28.6%` symbol error rate (`0%` packet yield) on `indoor-typical.json`** and a **`67%–93%` symbol error rate (`0%` packet yield) on `VID20261019203625.mp4`**?
1. **Optical and Bayer sensor crosstalk occurs in linear light ($\Phi \propto (\text{sRGB}/255)^{2.2}$) before the camera ISP's concave gamma curve ($\text{sRGB} = 255 \cdot \Phi^{1/2.2}$):**
   - The 4-PAM levels `[40, 112, 184, 255]` have linear-light intensities:
     $$\Phi(40) = 0.0170, \quad \Phi(112) = 0.1636, \quad \Phi(184) = 0.4882, \quad \Phi(255) = 1.0000$$
   - Notice that the linear-light separation between `L0 (40)` and `L1 (112)` is only **$\Delta\Phi = 0.1636 - 0.0170 = 0.1466$ (`14.7%` of full scale)**.
   - When a cell has `R = L0 (40)` ($\Phi_R = 0.0170$) alongside `G = L3 (255)` or `B = L3 (255)` ($\Phi_G = 1.0$), just `13–18%` linear cross-channel leakage adds $\Delta\Phi \approx 0.15$ to Red, yielding $\Phi_{R,\text{meas}} \approx 0.167$.
   - After the camera's gamma curve $\text{sRGB} = 255 \cdot (0.167)^{1/2.2}$, the measured Red value jumps from `40` to **`114–160`**, which is **above `L1 (112)`**!
   - Meanwhile, in the grayscale pilot cell `L0 = [40, 40, 40]`, all three channels are dark ($\Phi_R = \Phi_G = \Phi_B = 0.0170$), so the pilot experiences zero leakage from bright `G` or `B` and places `Tr01` at `~70`. Every data cell with `R = L0` and bright `G`/`B` crosses `Tr01` (and even `Tr12`!) into `L1` or `L2`.

2. **Empirical Proof on `VID20261019203625.mp4` (Ground-Truth Fill Cells, Frame 120):**

| Stripe | `R(L0=40)` when `G=L0` | `R(L0=40)` when `G=L3` | `R(L1=112)` when `G=L0` | `R(L1=112)` when `G=L3` | `R(L2=184)` when `G=L0` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Stripe 0** | `28 ± 19` | **`145 ± 28`** (`+117`!) | `34 ± 25` | `146 ± 29` | `107 ± 17` |
| **Stripe 1** | `17 ± 16` | **`144 ± 28`** (`+127`!) | `48 ± 16` | `161 ± 23` | `133 ± 18` |
| **Stripe 2** | `23 ± 21` | **`159 ± 23`** (`+136`!) | `81 ± 17` | `179 ± 17` | `165 ± 20` |
| **Stripe 3** | `40 ± 20` | **`145 ± 26`** (`+105`!) | `121 ± 17` | `188 ± 17` | `195 ± 14` |

   Look at **Stripe 1**: a cell with **`R = L0 (40), G = L3 (255)` has a mean measured Red value of `144`**, which is **higher than `R = L2 (184), G = L0 (40)` at `133`**!

3. **Empirical Ablation on `indoor-typical.json` (`ablate_v2_indoor.mjs` & `test_linear_xtalk.mjs`):**
   - Baseline `indoor-typical` (`v2`, `80×80`, `bpc = 6`): **`764 / 2,672` symbol errors (`28.59%`, `95.5` errors/stripe) -> `0 / 8` stripes decoded**.
   - With `color` crosstalk disabled in camera (`diag = 1, sat = 1`): **`0 / 2,672` symbol errors (`0.00%`) -> `8 / 8` stripes decoded**.
   - With **linear-light crosstalk unmixing** in `sliceCell4Pam` on the unmodified `indoor-typical` camera: symbol errors drop from **`764 / 2,672 (28.59%)` to `10 / 2,672 (0.37%)` (`-98.7%` errors) -> `8 / 8` (`100%`) stripes decoded**!

#### Fix (`src/vision/sampler.js`)
Before comparing `(rVal, gVal, bVal)` against the grayscale-calibrated `thresh4Pam`, project the cell onto the grayscale pilot diagonal in linear light ($\gamma = 2.2$) by subtracting the cross-channel difference $(\phi_{c'} - \phi_c)$:
```javascript
// In src/vision/sampler.js: sliceCell4Pam
export function unmixLinearCrosstalk(rVal, gVal, bVal, alpha = 0.08) {
  const pR = Math.pow(Math.max(0, rVal) / 255.0, 2.2);
  const pG = Math.pow(Math.max(0, gVal) / 255.0, 2.2);
  const pB = Math.pow(Math.max(0, bVal) / 255.0, 2.2);

  const uR = Math.max(0, pR - alpha * (pG - pR) - alpha * (pB - pR));
  const uG = Math.max(0, pG - alpha * (pR - pG) - alpha * (pB - pG));
  const uB = Math.max(0, pB - alpha * (pR - pB) - alpha * (pG - pB));

  return [
    255.0 * Math.pow(uR, 1.0 / 2.2),
    255.0 * Math.pow(uG, 1.0 / 2.2),
    255.0 * Math.pow(uB, 1.0 / 2.2)
  ];
}
```

---

### Root Cause 3: [CRITICAL — V2 Constellation & Real-World Optics] Toe Crush (`L0` vs `L1`), Highlight Saturation (`L2` vs `L3`), and Insufficient RS Parity on Real Screens (`VID20261019203625.mp4`)

#### What Happens
When we measured the camera-captured RGB distributions across all 8 micro-stripes of `/root/upload/files/VID20261019203625.mp4` (`analyze_v2_errors.mjs`), we found that even with oracle per-stripe 64-centroid calibration (`inspect_vid2_deep.mjs`), the **LSB** of each 4-PAM channel still suffers a **`7.3%` to `19.5%` bit error rate** (`22%` to `53%` 6-bit symbol error rate):

| Micro-Stripe (Rows) | Received `R` `[L0, L1, L2, L3]` | Received `B` `[L0, L1, L2, L3]` | 4-PAM MSB Bit Error Rate | 4-PAM LSB Bit Error Rate |Physical Failure Mechanism |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **Stripe 0 (`1..9`)** | **`70±55 \| 70±54`** \| `129±36` \| `259±11` | **`95±39 \| 73±40`** \| `143±30` \| `255±16` | `3.44%` | **`19.47%`** | **Dark Toe Crush:** `L0(40)` & `L1(112)` crushed (`28±19` vs `34±25` when `G=L0`) |
| **Stripe 1 (`10..19`)** | `66±56` \| `93±46` \| `158±28` \| `261±10` | `81±41` \| `101±41` \| `184±28` \| `251±15` | **`1.52%`** | `10.81%` | Crosstalk (`R(L0, G=L3)=144` vs `R(L1, G=L3)=161`) |
| **Stripe 2 (`20..29`)** | `77±54` \| `131±42` \| `192±24` \| `260±10` | `97±43` \| `149±35` \| `215±24` \| `253±12` | `1.75%` | `7.31%` | Best viewing angle on screen |
| **Stripe 5 (`50..59`)** | `131±36` \| `188±22` \| `226±16` \| `253±9` | `169±29` \| `222±21` \| **`241±16 \| 246±14`** | `6.77%` | `15.75%` | **Blue Highlight Saturation:** `B(L2)` & `B(L3)` clip at `~243` |
| **Stripe 6 (`60..69`)** | `140±33` \| `191±23` \| `223±16` \| `246±12` | `182±28` \| `224±22` \| **`245±13 \| 248±12`** | `7.23%` | `16.74%` | **Blue Highlight Saturation:** `245` vs `248` (`3` counts!) |
| **Stripe 7 (`70..78`)** | `146±24` \| `193±20` \| **`225±16 \| 236±14`** | `197±20` \| `226±19` \| **`240±12 \| 239±14`** | `11.32%` | **`19.08%`** | **Full Highlight Clipping:** `B(L2)=240` vs `B(L3)=239` (`0` counts!) |

Why does 6-bit 4-PAM (`[4×4×4]`) break down on a real laptop LCD filmed by a smartphone camera?
1. **Top-of-Screen LCD Viewing-Angle Toe Crush (`Stripe 0`):** At `[40, 112, 184, 255]`, `L0 (40)` is only `1.7%` linear light and `L1 (112)` is `16.4%`. Viewed from a slight angle at the top of the panel, both `L0` and `L1` fall into the dark toe (`28 ± 19` vs `34 ± 25` — only `6` ADC counts apart against $\sigma = 22$ noise).
2. **Bottom-of-Screen Highlight Clipping (`Stripes 5–7`):** At the bottom of the panel, camera auto-exposure + LCD gamma pushes `L2 (184)` in Blue all the way to **`240–245`**, completely saturating the sensor so `B(L2 = 184)` (`240 ± 12`) and `B(L3 = 255)` (`239 ± 14`) have **zero separation**.
3. **High-Rate RS (`nsym = 14`, $t = 7$) Cannot Absorb 4-PAM Tail Errors:** A single-codeword `250-byte` packet with `nsym = 14` can only correct **7 byte errors (`2.8%`)**, whereas 4-PAM on a real camera produces `50–130` byte errors per stripe.

---

### Root Cause 4: [HIGH — V2 Framing, Capacity Waste & Broken 3-Bit/5-Bit Modes] 54%–77% Dummy Fill Wastage, Missing `turbo` Wiring, and Blocked 3-Bit V2 Mode (`src/session/txSession.js:46-53`, `web/js/send-app.js:106-117`, `src/vision/frameDecoder.js:475`, `src/frame/layout.js:221-240`)

#### What Happens
1. **Massive Cell Wastage in V2 (`54.1%` to `77.4%` of the Grid Wasted on Dummy Fill Symbols):**
   - Look at [`src/session/txSession.js:46-53`](file:///root/downloads/ChromaStripe-JS/src/session/txSession.js#L46-L53):
     ```javascript
     if (options.payloadWords) {
       this.wordsPerBlock = options.payloadWords;
     } else if (options.turbo) {
       this.wordsPerBlock = 112;
     } else {
       this.wordsPerBlock = this.version === 2 ? 56 : 112;
     }
     ```
   - And look at [`web/js/send-app.js:106-117`](file:///root/downloads/ChromaStripe-JS/web/js/send-app.js#L106-L117): **`send-app.js` never passes `turbo: true` or `payloadWords`!**
   - Consequently, in every v2 transmission from `send.html`, each micro-stripe packet is fixed at `250 bytes` (`High-Rate`, `224 B` payload) or `254 bytes` (`Standard`). At `6 bits/cell`, a `250-byte` packet occupies only **$\lceil 250 \times 8 / 6 \rceil = 334$ cells**!
   - Look at how many data cells exist in each grid density vs. how many are actually used:
     - **`80×80` (`5,824` data cells):** Uses `8 × 334 = 2,672` cells (`45.9%`); **wastes `3,152` cells (`54.1%`) on dummy `getFillSymbols` padding**! (This is why `8 × 224 B = 1,792 B/frame` in v2 `80×80` delivers **the exact same payload per frame as v1's `4 × 448 B = 1,792 B/frame`** while sacrificing 2-PAM's `20 dB` SNR margin and cutting RS parity from `82 B` to `14 B`!)
     - **`96×96` (`8,576` data cells):** Uses `2,672` cells (`31.2%`); **wastes `5,904` cells (`68.8%`) on dummy padding**! (This is why `/root/upload/files/Screenshot 2026-10-19 at 20-15-05 Send a File — ChromaStripe-JS.png` showed 9 black rows out of every 12 rows in every stripe before `63bc6e0` painted dummy fill over them!)
     - **`112×112` (`11,840` data cells):** Uses `2,672` cells (`22.6%`); **wastes `9,168` cells (`77.4%`) on dummy padding**!

2. **3-Bit (`2-PAM RGB`) and 5-Bit (`4-PAM RG`) Modes in `send.html` Are Completely Broken in V2:**
   - In [`src/vision/frameDecoder.js:475`](file:///root/downloads/ChromaStripe-JS/src/vision/frameDecoder.js#L475):
     ```javascript
     const bpc = (this.bitsPerCell && this.bitsPerCell !== 3) ? this.bitsPerCell : 6;
     ```
     `_decodeV2Stripes` explicitly **rejects `this.bitsPerCell === 3`** and forces `bpc = 6`!
   - Furthermore, [`web/receive.html`](file:///root/downloads/ChromaStripe-JS/web/receive.html#L52-L71) has no Modulation selector, and `_decodeV2Stripes` never auto-detects `bpc = 3` (when `pilotCalibrator.hasPamPilots === false`) or tries `bpc = 5`.
   - Worse, in [`getLayoutV2()` (`src/frame/layout.js:221-240`)](file:///root/downloads/ChromaStripe-JS/src/frame/layout.js#L221-L240), `80×80` is partitioned into 8 equal 10-row bands (`[0..9], ..., [70..79]`). Because rows `0..7` and `72..79` contain the `8×8` corner finders, Stripes 0 and 7 only have **`596` data cells**, which at `3 bits/cell` is **`223.5 bytes` — too small to hold a `250-byte` (`667`-cell) or `254-byte` (`678`-cell) v2 packet**! In [`renderFrame()` (`src/frame/renderer.js:302`)](file:///root/downloads/ChromaStripe-JS/src/frame/renderer.js#L302), `Math.min(n, 667)` silently **truncates the last 26.5 bytes (all RS parity + 12.5 payload bytes)** of Stripes 0 and 7!

#### Fix (`src/frame/layout.js`, `src/vision/frameDecoder.js`, `src/session/txSession.js`, `web/send.html`)
1. **Equalize Micro-Stripe Row Partitions in `getLayoutV2` (`src/frame/layout.js:221-240`):**
   Just as v1 gives outer stripes 21 rows (`[0,20]`, `[59,79]`) and inner stripes 19 rows (`[21,39]`, `[40,58]`) to compensate for the `8×8` corner finders, partition `80×80` v2 into `[[0,10], [11,19], [20,29], [30,39], [40,49], [50,59], [60,68], [69,79]]` (and `96×96` into `13` outer / `11–12` inner rows). Then **every micro-stripe on `80×80` has `674` to `772` data cells (`>= 252.75 bytes` at 3 bits/cell)**, fitting a full `250-byte` v2 packet at **3 bits/cell (2-PAM RGB, 8 colors)** without truncation!
2. **Make `3 bits/cell (2-PAM RGB)` the Default Modulation for V2 (or Auto-Detect `bpc` from Pilots):**
   - With `3 bits/cell (2-PAM RGB)` + 8 micro-stripes, v2 retains the **rock-solid `20 dB` 8-color SNR of v1** while gaining v2's **8 micro-stripes (halving rolling-shutter tear blast radius)**, **adaptive `80 / 96 / 112` grid density** (where `96×96` + `112×112` at 3 bits/cell or Turbo mode doubles payload per frame!), and **multi-format compression (`CSv2`)**.
   - In `_decodeV2Stripes` (`src/vision/frameDecoder.js:475`), set `const bpc = this.options.bitsPerCell || (pilotCalibrator.hasPamPilots ? 6 : 3);` and include `bpc === 3` (`sliceCellCausal` + `symbolsToBytes`) in `_decodeV2Stripes`.
3. **Auto-Enable Dual-Codeword Turbo (`wordsPerBlock = 112`, `488/496 B` packets) When Stripe Bit Capacity Allows (`src/session/txSession.js:46-53`):**
   - In `TxSession`, compute `minStripeBits = minStripeCells * this.bitsPerCell`. When `this.version === 2 && minStripeBits >= 496 * 8` (e.g., `96×96` or `112×112` at 6 bits/cell, or `112×112` at 3 bits/cell with 15-row outer stripes), automatically set `this.wordsPerBlock = 112` (`448 B` payload × 8 stripes = **`3,584 B/frame`**) instead of wasting 69%–77% of the grid on fill symbols.

---

### Root Cause 5: [CRITICAL — Vision / Auto-Detect] Per-Block `isPamPilot` Corruption, Hard V1 Lockout, and 3.6× Auto-Detect CPU Regression (`src/vision/pilots.js:156-240, 359-360`, `src/vision/frameDecoder.js:362-435`)

#### What Happens
1. **Per-Block `isPamPilot` Evaluation Corrupts Both 2-PAM and 4-PAM Thresholds (`src/vision/pilots.js:162-240`):**
   - In [`src/vision/pilots.js:162-164`](file:///root/downloads/ChromaStripe-JS/src/vision/pilots.js#L162-L164):
     ```javascript
     const isPamPilot = (lumaM > lumaW + 35) && (lumaW <= lumaK + 35);
     if (isPamPilot) {
       this.hasPamPilots = true;
     ```
   - **On a v1 (2-PAM) frame:** If even **1 out of the 16 pilot blocks** suffers local glare or phase drift such that `isPamPilot` is `true`, `this.hasPamPilots` becomes `true` for the entire frame. Then [`FrameDecoder.decode()` (`src/vision/frameDecoder.js:406`)](file:///root/downloads/ChromaStripe-JS/src/vision/frameDecoder.js#L406):
     ```javascript
     if (resV2.validStripesCount > 0 || activeGridSize !== 80 || pilotCalibrator.hasPamPilots) {
       ...
       return { ok: resV2.validStripesCount > 0, ... };
     }
     ```
     immediately returns `ok: false` and **never calls `_decodeV1Stripes`**!
   - **On a v2 (4-PAM) frame:** In `VID20261019203625.mp4`, at `Pilot 2 (9, 49)` where `L0` and `L1` are shadow-crushed, unsharp masking pushes `isPamPilot` to fail or distort `levels`, while any 4-PAM pilot block where `isPamPilot` is `false` falls into the `else` branch (`lines 224-240`), which uses `rHi = (wR + mR) * 0.5` and `rLo = (kR + cR) * 0.5`. For a 4-PAM pilot (`w=40, k=112, c=184, m=255`), `(40+255)/2 = 147.5` and `(112+184)/2 = 148.0`, so **`rHi ≈ rLo ≈ 148`** (`rHi - rLo ≈ 0`), collapsing all 4-PAM thresholds at that pilot to `[143, 148, 153]`!

2. **3.60× CPU Regression in `Auto-Detect` Mode on V1 Frames (`16.48 ms → 59.38 ms/frame`):**
   - In [`src/vision/frameDecoder.js:404-435`](file:///root/downloads/ChromaStripe-JS/src/vision/frameDecoder.js#L404-L435), when `this.version === 'auto'` (the default in `receive.html` and `rx-worker.js`), `decode()` **unconditionally runs `this._decodeV2Stripes()` on every v1 frame** even when `activeGridSize === 80 && !pilotCalibrator.hasPamPilots`!
   - Because `count * 6 >= 496 * 8` for stripes 1..6, `_decodeV2Stripes` runs `parsePacketV2` on `pkt250`, `pkt254`, `pkt488`, and `pkt496` across raw, 2-frame average, and multi-frame average passes — executing **up to 132 wasted RS error-and-erasure codeword decodes per frame** before `_decodeV1Stripes` is even called!

3. **`detectGridDensity()` Overrides User Grid Selection & Uses Unrefined Homography (`src/vision/frameDecoder.js:36-69, 362-364`):**
   - Line 362: `const activeGridSize = (this.autoGrid || this.version === 'auto') ? detectGridDensity(...) : this.gridSize;` runs `detectGridDensity` even when `this.autoGrid === false` (when the user explicitly chose `80×80` in `receive.html`).
   - If `detectGridDensity` misclassifies a noisy v1 frame as `96` or `112`, line 406 (`activeGridSize !== 80`) prevents `_decodeV1Stripes` from running, or if `this.version === 1`, `_decodeV1Stripes` samples `80×80` coordinates using a `96×96` homography and a `96`-stride `gridRgb` buffer!
   - Also, `getThresholds4Pam(u, v)` (`src/vision/pilots.js:359-360`) clamps `s, t` to `[0.0, 1.0]` instead of `[-0.4, 1.4]`.

#### Fix (`src/vision/pilots.js` & `src/vision/frameDecoder.js`)
1. In `PilotCalibrator._samplePilots()`, determine `this.hasPamPilots` via **majority vote across all 16 pilot blocks** (`pamCount >= 8` out of 16) in a first pass, then compute either 4-PAM thresholds for all 16 blocks or 2-PAM thresholds for all 16 blocks in the second pass.
2. In `FrameDecoder.decode()`:
   - Respect `this.autoGrid` (`const activeGridSize = this.autoGrid ? detectGridDensity(...) : this.gridSize;`), and if `this.version === 1`, always force `activeGridSize = 80`.
   - When `this.version === 'auto'`, if `activeGridSize === 80 && !pilotCalibrator.hasPamPilots`, **run `_decodeV1Stripes` first** (restoring `16.48 ms/frame` decode speed on v1!) and only try `_decodeV2Stripes` (with `bpc = 3`) if `_decodeV1Stripes` yields 0 stripes.

---

### Root Cause 6: [HIGH — Concurrency vs. Temporal State] Multi-Worker Round-Robin Dispatch Breaks Temporal Accumulation, Hold Skipping, and Tear Stitching (`web/js/receive-app.js:48-66, 413`, `web/js/rx-worker.js:9`)

#### What Happens
In [`web/js/receive-app.js:48-66`](file:///root/downloads/ChromaStripe-JS/web/js/receive-app.js#L48-L66), Tier 2 introduced a pool of `POOL_SIZE` (2–3) Web Workers, each instantiating its own isolated `FrameDecoder` (`rx-worker.js:9`), and `captureLoop()` dispatches frames round-robin (`Frame 1 → W0`, `Frame 2 → W1`, `Frame 3 → W2`, `Frame 4 → W0`).

However, `FrameDecoder` is **heavily stateful across consecutive frames ($t - 1 \to t$)** via `this.stripeAccum[s]`:
- `st.prevRgb` / `st.prevThresh`: stores the previous frame's deblurred cell RGB values.
- `mad`: mean absolute difference between `st.curRgb` and `st.prevRgb`.
- When 3 workers receive every 3rd frame (`t` and `t - 3`, which are `50–100 ms` apart):
  - At `15 fps` (`txHold = 4` @ 60 Hz or `2` @ 30 Hz) or `20 fps` (`txHold = 3`), frame $t$ and frame $t - 3$ **always belong to different TX frames**!
  - Consequently, inside every worker, `mad` between `curRgb` and `prevRgb` is always `> 15` (`~45`), so:
    1. **`st.count` is reset to `1` on every frame** — multi-frame accumulation (`st.count >= 3`) never activates.
    2. **2-frame pair averaging (`st.hasPrev && mad <= 15`)** never activates.
    3. **Complementary rolling-shutter tear stitching (`frameDecoder.js:793-825`)** splices the top of frame $t$ with the bottom of frame $t - 3$ (an unrelated TX frame!), producing corrupted hybrid packets.
    4. **Hold-window early skip (`st.decodedInHold && mad < 12`)** fails because Workers 1 and 2 do not know Worker 0 already decoded the stationary hold frame.

#### Fix (`web/js/receive-app.js`)
With Root Cause 5 fixed, single-frame decode time is `16.4 ms` (and `< 3 ms` on hold-skipped frames), so **a single Vision Worker (`POOL_SIZE = 1`)** preserves 100% sequential frame ordering ($t - 1 \to t$) for temporal accumulation, 2-frame averaging, hold-window skipping, and rolling-shutter tear stitching without `workerBusy` drops. (If multiple workers are ever used, consecutive frames of the same hold window must be routed to the same worker or `curRgb` must be passed back to the coordinator.)

---

### Root Cause 7: [HIGH — Mobile Camera Pipeline] `tryLockCameraHardware()` Causes Underexposure / Pitch-Black Video & White-Balance Shift After First Decoded Stripe (`web/js/receive-app.js:85-87, 171-232`)

#### What Happens
In [`web/js/receive-app.js:85-87, 171-232`](file:///root/downloads/ChromaStripe-JS/web/js/receive-app.js#L171-L232), as soon as the first stripe decodes (`stripes.some(s => s && s.ok)`), `tryLockCameraHardware()` calls `track.applyConstraints({ advanced })` with:
1. `{ whiteBalanceMode: 'manual' }` **without passing `colorTemperature: settings.colorTemperature`**. On Android Chrome / V4L2 drivers, switching to `'manual'` without an explicit `colorTemperature` resets white balance to the hardware default (often `2800K` tungsten), violently skewing R/B channel ratios right after the first stripe decodes.
2. `{ exposureMode: 'manual' }` and `{ exposureTime: targetExp }` where `cap60` is guessed from `caps.exposureTime.max`:
   ```javascript
   if (maxExp <= 1.0) cap60 = 1.0 / 60.0;
   else if (maxExp <= 100.0) cap60 = 1000.0 / 60.0;
   else cap60 = 10000.0 / 60.0; // ~166.6
   ```
   - On Android Camera2 devices where `exposureTime` is reported in **microseconds** (`maxExp = 33333..1000000`) or **nanoseconds**, `cap60 = 166.6` sets the camera shutter to **`166 µs` (`1/6000 s`)**, turning the camera feed **completely black** immediately after the very first stripe decodes!
   - Even when `exposureTime` is in 100-µs units, forcing `exposureMode: 'manual'` and clamping `exposureTime` below `settings.exposureTime` without boosting `iso` underexposes the image by `1–2 EV`.

#### Fix (`web/js/receive-app.js`)
Never guess `exposureTime` units or force `exposureMode: 'manual'` with a reduced `exposureTime`. Keep continuous auto-exposure/white-balance (which `PilotCalibrator` already tracks per-frame via the 16 spatial pilot blocks), or only lock `focusMode: 'continuous'`!

---

### Root Cause 8: [MEDIUM — Geometry / ROI Cropping] `TimingRefiner` Caches `this.k1` From Full Frame and Applies It to ROI-Cropped Coordinates (`src/vision/frameDecoder.js:379-390`, `src/vision/timing.js:56-60, 175-177`)

#### What Happens
1. On Frame 1 (`roi === null`, full `1280×720` frame), [`FrameDecoder.decode()`](file:///root/downloads/ChromaStripe-JS/src/vision/frameDecoder.js#L379-L390) runs `new TimingRefiner(rgba, width, height, H, corners, this.k1, activeGridSize)` and caches `this.k1 = timingRefiner.bestK1`.
2. On Frame 2+, `receive-app.js:426-443` crops the video frame to the barcode bounding box `(sw, sh)` at offset `(sx, sy)`.
3. Inside [`TimingRefiner._analyze()` (`src/vision/timing.js:56-60, 175-177`)](file:///root/downloads/ChromaStripe-JS/src/vision/timing.js#L56-L60), `cx = this.width * 0.5` and `cy = this.height * 0.5` now use the **cropped ROI center `(sw/2, sh/2)` and scale `min(sw/2, sh/2)`** instead of the full camera optical center `(vw/2 - sx, vh/2 - sy)`! Whenever `Math.abs(this.k1) > 0.005`, `_computeLensField()` warps the grid around the wrong center and scale.
4. Furthermore, `_computeGuardPhaseField()` already measures the 2D `8×8` displacement field `(duGrid, dvGrid)` directly from the guard bands in `0.3 ms`, subsuming radial lens distortion without needing `evalContrast(k)` or `_computeLensField()`.

---

### Root Cause 9: [MEDIUM — Fountain Schedule & Session Finalization] Wire-Incompatible Phase-3 `sampleResidualDegree` Change & Uncaught Concurrent `ingestPacket` Race (`src/fountain/degree.js:15-36`, `web/js/receive-app.js:90-96`, `src/session/rxSession.js:60-63`)

#### What Happens
1. **Phase-3 Degree Distribution Wire Incompatibility (`src/fountain/degree.js:15-36`):**
   - Commit `d32f719` altered `sampleResidualDegree(rng, K)` in-place. Because `getDropletIndices(seed, K)` is deterministic from `seed` and `K`, any v1 video or sender created prior to `d32f719` (such as `/root/upload/files/VID20261018001853.mp4`, where `seed >= 776 > 2K` is in Phase 3) produces Phase-3 droplets whose XORed block indices no longer match `FountainDecoder`'s `getDropletIndices(seed, K)`, causing `RxSession._finalize()` to fail with `CORRUPT_MANIFEST` once $K$ equations are collected.
2. **Concurrent `ingestPacket` Finalization Race & Missing `try/catch` (`src/session/rxSession.js:60-63`, `web/js/receive-app.js:90-96`):**
   - In `RxSession.ingestPacket()`, `this.isComplete = true` is only set at the end of `await this._finalize()` (after async `DecompressionStream` and `crypto.subtle.digest`). When multiple stripes or workers call `await rxSession.ingestPacket(...)` concurrently, `_finalize()` can be entered multiple times, and `receive-app.js:93` lacks a `try / catch` around `await rxSession.ingestPacket(...)`.

---

## 3. Summary Action Plan to Restore & Optimize Both v1 and v2

| Priority | Target File(s) | Exact Fix |
| :--- | :--- | :--- |
| **P0 (Fix v1 TX)** | [`web/js/send-app.js`](file:///root/downloads/ChromaStripe-JS/web/js/send-app.js#L101-L117), [`src/session/txSession.js`](file:///root/downloads/ChromaStripe-JS/src/session/txSession.js#L40-L44) | Force `bitsPerCell = 3`, `gridSize = 80`, `numStripes = 4` whenever `version === 1` so v1 never inherits `modSelect.value = 6` (4-PAM) from the hidden v2 dropdown. |
| **P0 (Fix v2 4-PAM Slicing)** | [`src/vision/sampler.js`](file:///root/downloads/ChromaStripe-JS/src/vision/sampler.js#L88-L184) | Add `unmixLinearCrosstalk(rVal, gVal, bVal, 0.08)` in linear light ($\gamma = 2.2$) before `sliceCell4Pam` and `sliceCell5Pam` (`764 → 10` symbol errors on `indoor-typical`, lifting v2 yield from `0%` to `100%`). |
| **P0 (Fix v2 Layout & 3-Bit Mode)** | [`src/frame/layout.js`](file:///root/downloads/ChromaStripe-JS/src/frame/layout.js#L221-L240), [`src/vision/frameDecoder.js`](file:///root/downloads/ChromaStripe-JS/src/vision/frameDecoder.js#L475), [`src/session/txSession.js`](file:///root/downloads/ChromaStripe-JS/src/session/txSession.js#L46-L53) | Give outer micro-stripes `0` and `7` 11 rows on `80×80` (`674` cells = `252.75 B` at 3 bits/cell) so `250 B` v2 packets fit without truncation at `bpc = 3`; remove `this.bitsPerCell !== 3` guard in `_decodeV2Stripes`; auto-enable `wordsPerBlock = 112` (`488/496 B` Turbo packets) when `minStripeBits >= 496 * 8`. |
| **P0 (Fix Auto-Detect & Pilots)** | [`src/vision/pilots.js`](file:///root/downloads/ChromaStripe-JS/src/vision/pilots.js#L156-L240), [`src/vision/frameDecoder.js`](file:///root/downloads/ChromaStripe-JS/src/vision/frameDecoder.js#L362-L456) | Use majority vote (`pamCount >= 8` of 16) for `hasPamPilots`; extrapolate `getThresholds4Pam` to `[-0.4, 1.4]`; run `_decodeV1Stripes` first when `activeGridSize === 80 && !hasPamPilots` (cutting v1 auto-detect time from `59.38 ms` to `16.48 ms`). |
| **P1 (Fix RX Worker & Camera)** | [`web/js/receive-app.js`](file:///root/downloads/ChromaStripe-JS/web/js/receive-app.js#L48-L66), [`src/session/rxSession.js`](file:///root/downloads/ChromaStripe-JS/src/session/rxSession.js#L60-L63) | Use `POOL_SIZE = 1` sequential vision worker so `prevRgb` is always frame $t - 1$ for temporal accumulation and tear stitching; remove `exposureMode: 'manual'` / `whiteBalanceMode: 'manual'` from `tryLockCameraHardware()`; guard `ingestPacket` with `this.isFinalizing` + `try/catch`. |
| **P1 (Fix ROI `k1` & Fountain)** | [`src/vision/timing.js`](file:///root/downloads/ChromaStripe-JS/src/vision/timing.js#L55-L180) | Rely directly on the 8×8 `_computeGuardPhaseField()` 2D warp grid (or pass full-frame optical center when `roi` is active) instead of re-centering cached `k1` on the cropped ROI. |
