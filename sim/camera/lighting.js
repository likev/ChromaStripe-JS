/**
 * Camera simulation: Lighting, glare spots, gradients, and vignetting.
 */

export function applyLighting(buf, w, h, options = {}) {
  const glare = options.glare; // { x, y, radius, intensity }
  const gradient = options.gradient ?? 0.0;
  const vignette = options.vignette ?? 0.0;
  const ambient = options.ambient ?? 0.0;

  const cx = w / 2;
  const cy = h / 2;
  const maxR2 = cx * cx + cy * cy;

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w * 3;
    const dy = y - cy;
    const gradFactor = 1.0 + ((y / h) - 0.5) * gradient;

    for (let x = 0; x < w; x++) {
      const idx = rowOffset + x * 3;
      const dx = x - cx;
      const r2 = dx * dx + dy * dy;

      // Vignette falloff
      let lightFactor = gradFactor;
      if (vignette > 0) {
        lightFactor *= (1.0 - vignette * (r2 / maxR2));
      }

      // Additive glare
      let glareAdd = 0;
      if (glare && glare.intensity > 0) {
        const gx = x - glare.x;
        const gy = y - glare.y;
        const dist2 = gx * gx + gy * gy;
        const rad2 = glare.radius * glare.radius;
        glareAdd = glare.intensity * Math.exp(-dist2 / (2 * rad2));
      }

      for (let c = 0; c < 3; c++) {
        let val = buf[idx + c] * lightFactor + ambient + glareAdd;
        buf[idx + c] = Math.max(0.0, Math.min(1.0, val));
      }
    }
  }

  return buf;
}
