# ChromaStripe-JS — Manual Test Procedures

This document outlines standard verification procedures for running the optical modem on desktop and mobile browsers.

---

## 1. Local Testing Setup
1. Start the local server:
   ```bash
   npm run serve
   ```
2. Open `http://localhost:8080/web/` in your browser.
3. For mobile testing over LAN with camera access (HTTPS):
   ```bash
   ./tools/make-cert.sh
   npm run serve:https
   ```
   Open `https://<your-lan-ip>:8443/web/` on your phone.

---

## 2. Test Procedures

### Test 1: Sender File Ingestion & Rendering
- Navigate to `send.html`.
- Drag and drop a file (e.g. `test/fixtures/sample.json`).
- Verify that the file name, size, block count ($K$), and estimated time are correctly calculated.
- Click **Start Transmission**.
- Verify that the code renders smoothly at 800×800 pixels with a mid-gray quiet zone.
- Verify HUD counters increment.

### Test 2: In-Browser Loopback Simulation
- Open `sim.html`.
- Click **Start Simulation**.
- Verify that the simulated camera frame updates in real-time.
- Move the sliders (Blur, Noise, Glare, Tilt) and observe how the green quad overlay tracks the code.
- Verify that the transfer completes with a verified SHA-256 integrity check.

### Test 3: Cross-Device Optical Transfer (Laptop to Phone)
- On laptop: open `send.html` and select a 50 KB image or file. Start transmission in fullscreen.
- On phone: open `receive.html` and grant camera permission.
- Point the phone camera at the laptop screen from ~35 cm distance.
- Verify:
  - Green corner bounding box locks onto the display.
  - Stripe indicator bars flash green as packets are ingested.
  - Progress bar advances to 100%.
  - Verified checkmark and download button appear.
- Download the received file on phone and verify byte-for-byte identity.
