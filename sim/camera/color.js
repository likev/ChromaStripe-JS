/**
 * Camera simulation: Color crosstalk, AWB gains, and saturation.
 */

export function applyColorTransform(buf, w, h, options = {}) {
  const diag = options.crosstalkDiag ?? 0.90;
  const offDiag = (1.0 - diag) / 2.0;
  const awb = options.awbGains || [1.0, 1.0, 1.0];
  const saturation = options.saturation ?? 1.0;
  const blackLevel = (options.blackLevel ?? 0.0) / 255.0;

  const totalPixels = w * h;
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 3;
    const r = buf[idx];
    const g = buf[idx + 1];
    const b = buf[idx + 2];

    // Crosstalk
    let cr = r * diag + g * offDiag + b * offDiag;
    let cg = r * offDiag + g * diag + b * offDiag;
    let cb = r * offDiag + g * offDiag + b * diag;

    // AWB gains
    cr *= awb[0];
    cg *= awb[1];
    cb *= awb[2];

    // Saturation
    if (saturation !== 1.0) {
      const luma = 0.299 * cr + 0.587 * cg + 0.114 * cb;
      cr = luma + (cr - luma) * saturation;
      cg = luma + (cg - luma) * saturation;
      cb = luma + (cb - luma) * saturation;
    }

    buf[idx] = Math.max(0.0, Math.min(1.0, cr + blackLevel));
    buf[idx + 1] = Math.max(0.0, Math.min(1.0, cg + blackLevel));
    buf[idx + 2] = Math.max(0.0, Math.min(1.0, cb + blackLevel));
  }

  return buf;
}
