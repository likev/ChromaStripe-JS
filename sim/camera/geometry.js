/**
 * Camera simulation: 3D pose, projective geometry, lens distortion, and coordinate mapping.
 */

export class CameraGeometry {
  /**
   * @param {object} options
   * @param {number} [options.camW=1280]
   * @param {number} [options.camH=720]
   * @param {number} [options.codeHeightFrac=0.75]
   * @param {number} [options.yawDeg=0]
   * @param {number} [options.pitchDeg=0]
   * @param {number} [options.rollDeg=0]
   * @param {number} [options.k1=0.0] - Radial lens distortion coefficient
   * @param {number} [options.k2=0.0]
   * @param {number} [options.shakeX=0.0]
   * @param {number} [options.shakeY=0.0]
   */
  constructor(options = {}) {
    this.camW = options.camW || 1280;
    this.camH = options.camH || 720;
    this.codeHeightFrac = options.codeHeightFrac ?? 0.75;
    this.yawDeg = options.yawDeg ?? 0;
    this.pitchDeg = options.pitchDeg ?? 0;
    this.rollDeg = options.rollDeg ?? 0;
    this.k1 = options.k1 ?? 0.0;
    this.k2 = options.k2 ?? 0.0;
    this.shakeX = options.shakeX ?? 0.0;
    this.shakeY = options.shakeY ?? 0.0;

    this._computeHomography();
  }

  _computeHomography() {
    const cx = this.camW / 2 + this.shakeX;
    const cy = this.camH / 2 + this.shakeY;
    const minDim = Math.min(this.camW, this.camH);
    const s = (minDim * this.codeHeightFrac) / 80.0;

    // Perspective foreshortening from yaw/pitch
    const yawRad = (this.yawDeg * Math.PI) / 180;
    const pitchRad = (this.pitchDeg * Math.PI) / 180;
    const rollRad = (this.rollDeg * Math.PI) / 180;

    const cosR = Math.cos(rollRad);
    const sinR = Math.sin(rollRad);

    const pX = Math.sin(yawRad) * 0.0015;
    const pY = Math.sin(pitchRad) * 0.0015;

    // Affine scale + rotation centered around (40, 40)
    const a00 = s * cosR;
    const a01 = -s * sinR;
    const a10 = s * sinR;
    const a11 = s * cosR;

    const a02 = cx - (a00 * 40 + a01 * 40);
    const a12 = cy - (a10 * 40 + a11 * 40);

    // 3x3 homography matrix mapping (u, v) -> (x, y)
    this.H = [
      a00, a01, a02,
      a10, a11, a12,
      pX,  pY,  1.0
    ];

    // Compute H_inv (inverse 3x3 matrix)
    const [h00, h01, h02, h10, h11, h12, h20, h21, h22] = this.H;
    const det =
      h00 * (h11 * h22 - h12 * h21) -
      h01 * (h10 * h22 - h12 * h20) +
      h02 * (h10 * h21 - h11 * h20);

    const invDet = 1.0 / det;
    this.H_inv = [
      (h11 * h22 - h12 * h21) * invDet,
      (h02 * h21 - h01 * h22) * invDet,
      (h01 * h12 - h02 * h11) * invDet,

      (h12 * h20 - h10 * h22) * invDet,
      (h00 * h22 - h02 * h20) * invDet,
      (h02 * h10 - h00 * h12) * invDet,

      (h10 * h21 - h11 * h20) * invDet,
      (h01 * h20 - h00 * h21) * invDet,
      (h00 * h11 - h01 * h10) * invDet
    ];
  }

  /**
   * Projects logical coordinates (u, v) into camera coordinates (x, y).
   *
   * @param {number} u
   * @param {number} v
   * @returns {{ x: number, y: number }}
   */
  project(u, v) {
    const [h00, h01, h02, h10, h11, h12, h20, h21, h22] = this.H;
    const denom = 1.0 / (h20 * u + h21 * v + h22);
    let x = (h00 * u + h01 * v + h02) * denom;
    let y = (h10 * u + h11 * v + h12) * denom;

    // Apply radial distortion if k1 != 0
    if (this.k1 !== 0 || this.k2 !== 0) {
      const cx = this.camW / 2;
      const cy = this.camH / 2;
      const normX = (x - cx) / cx;
      const normY = (y - cy) / cy;
      const r2 = normX * normX + normY * normY;
      const factor = 1.0 + this.k1 * r2 + this.k2 * r2 * r2;
      x = cx + normX * factor * cx;
      y = cy + normY * factor * cy;
    }

    return { x, y };
  }

  /**
   * Maps camera coordinates (x, y) back to logical coordinates (u, v).
   *
   * @param {number} x
   * @param {number} y
   * @returns {{ u: number, v: number }}
   */
  unproject(x, y) {
    let ux = x;
    let uy = y;

    // Undistort if k1 != 0
    if (this.k1 !== 0 || this.k2 !== 0) {
      const cx = this.camW / 2;
      const cy = this.camH / 2;
      const normX = (x - cx) / cx;
      const normY = (y - cy) / cy;
      const r2 = normX * normX + normY * normY;
      const factor = 1.0 / (1.0 + this.k1 * r2 + this.k2 * r2 * r2);
      ux = cx + normX * factor * cx;
      uy = cy + normY * factor * cy;
    }

    const [i00, i01, i02, i10, i11, i12, i20, i21, i22] = this.H_inv;
    const denom = 1.0 / (i20 * ux + i21 * uy + i22);
    const u = (i00 * ux + i01 * uy + i02) * denom;
    const v = (i10 * ux + i11 * uy + i12) * denom;

    return { u, v };
  }

  /**
   * Returns projected ground-truth positions of finder centers.
   * @returns {{ TL: {x,y}, TR: {x,y}, BL: {x,y}, BR: {x,y} }}
   */
  getGroundTruthCorners() {
    return {
      TL: this.project(3.5, 3.5),
      TR: this.project(76.5, 3.5),
      BL: this.project(3.5, 76.5),
      BR: this.project(76.5, 76.5)
    };
  }
}
