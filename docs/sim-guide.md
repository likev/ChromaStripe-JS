# ChromaStripe-JS — Simulation Guide

The simulation framework enables rigorous validation of the physical modulation, computer vision pipeline, channel coding, and transmission protocols under synthetic and adversarial conditions.

---

## 1. Simulation Hierarchy

- **Level 0 (Stripe Erasure):** Tests fountain code peeling and Gaussian elimination without rendering. Evaluates Bernoulli loss, Gilbert-Elliott bursts, and rolling-shutter stuck tears.
  ```bash
  npm run sim:l0
  ```
- **Level 1 (Symbol / Bit Errors):** Injects bit flips and spatial burst noise into packed stripe packets to verify Reed-Solomon error correction and CRC32 integrity.
  ```bash
  npm run sim:l1
  ```
- **Level 2 (Synthetic Camera):** Complete optical and sensor simulation:
  - 3D perspective pose (yaw, pitch, roll, distance, shake)
  - Lens radial distortion ($k_1, k_2$)
  - Rolling shutter readout and exposure timing
  - Gaussian Point Spread Function (PSF) blur
  - Additive specular glare, gradients, and vignetting
  - Color crosstalk and AWB drift
  - Sensor shot and read noise
  - BT.601 YCbCr 4:2:0 chroma subsampling
  ```bash
  npm run sim:l2
  # Or with a custom scenario:
  node sim/run.js --level 2 --scenario indoor-typical --trials 20
  ```

---

## 2. Scenario Presets (`sim/scenarios/*.json`)
- `ideal.json`: Baseline frontal geometry, 0 noise, global shutter.
- `indoor-typical.json`: Reference 720p indoor condition with $\pm 5^\circ$ tilt, $0.7$ px PSF blur, 4:2:0 subsampling, and rolling shutter readout.
- `indoor-handheld.json`: Handheld camera shake ($2$ px random walk) and higher sensor noise.
- `outdoor-glare.json`: Sunlight specular glare blob ($35\%$ intensity) and linear brightness gradient.
- `portrait-hold.json`: 90-degree rotated readout sensor orientation.
- `adversarial.json`: Extreme perspective tilts ($\pm 20^\circ$), heavy lens distortion, and multiple distractor objects.

---

## 3. Dataset Export
To export ground-truth labeled datasets for offline replay and regression testing:
```bash
node sim/gen-dataset.js --scenario indoor-typical --frames 30 --out data/sim/indoor-typical
```
Output includes:
- `frame_00000.rgba` (raw camera pixel buffer)
- `truth.jsonl` (ground truth corners, homography matrix $H$, and rolling-shutter tear rows).
