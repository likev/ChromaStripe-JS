/**
 * Camera simulation: Display gamma and linear light transformations.
 */

// Precompute gamma 2.2 LUTs
export const S_TO_LINEAR = new Float32Array(256);
export const LINEAR_TO_S = new Uint8Array(4096);

for (let i = 0; i < 256; i++) {
  S_TO_LINEAR[i] = Math.pow(i / 255.0, 2.2);
}

for (let i = 0; i < 4096; i++) {
  const lin = i / 4095.0;
  LINEAR_TO_S[i] = Math.round(Math.pow(lin, 1.0 / 2.2) * 255.0);
}

export function toLinear(val8) {
  return S_TO_LINEAR[val8 & 0xFF];
}

export function toSRGB(lin) {
  const clamped = Math.max(0.0, Math.min(1.0, lin));
  const idx = Math.min(4095, Math.floor(clamped * 4095.0));
  return LINEAR_TO_S[idx];
}
