/**
 * Canvas renderer adapter for TX screen display.
 */

export class TxCanvasRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {number} [scale=1]
   */
  constructor(canvas, scale = 1) {
    this.canvas = canvas;
    this.scale = scale;
    this.ctx = canvas.getContext('2d', { willReadFrequently: false });
    this.ctx.imageSmoothingEnabled = false;

    this.dim = 800 * scale;
    this.canvas.width = this.dim;
    this.canvas.height = this.dim;
    this.imgData = this.ctx.createImageData(this.dim, this.dim);
  }

  /**
   * Updates canvas display with rendered RGBA buffer.
   *
   * @param {Uint8ClampedArray} rgba
   */
  displayFrame(rgba) {
    this.imgData.data.set(rgba);
    this.ctx.putImageData(this.imgData, 0, 0);
  }
}
