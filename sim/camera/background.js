/**
 * Camera simulation: Procedural background and distractors.
 */

export function renderBackground(w, h, distractors = 2) {
  const buf = new Float32Array(w * h * 3);

  // Gradient desk/room background
  for (let y = 0; y < h; y++) {
    const rowOffset = y * w * 3;
    const luma = 0.15 + (y / h) * 0.10;
    for (let x = 0; x < w; x++) {
      const idx = rowOffset + x * 3;
      buf[idx] = luma * 0.9;
      buf[idx + 1] = luma * 0.95;
      buf[idx + 2] = luma;
    }
  }

  // Draw distractor cyan and magenta objects outside screen center
  if (distractors > 0) {
    const dObjects = [
      { x: 50, y: 50, w: 40, h: 40, color: [0.9, 0.1, 0.9] }, // Magenta sticky note
      { x: w - 90, y: 80, w: 50, h: 30, color: [0.1, 0.9, 0.9] } // Cyan object
    ];

    for (let d = 0; d < Math.min(distractors, dObjects.length); d++) {
      const { x: ox, y: oy, w: ow, h: oh, color } = dObjects[d];
      for (let y = oy; y < oy + oh && y < h; y++) {
        for (let x = ox; x < ox + ow && x < w; x++) {
          const idx = (y * w + x) * 3;
          buf[idx] = color[0];
          buf[idx + 1] = color[1];
          buf[idx + 2] = color[2];
        }
      }
    }
  }

  return buf;
}
