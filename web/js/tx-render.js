/**
 * Canvas renderer adapter and auto-sizing helper for TX screen display.
 */

/**
 * Computes the largest integer corePx that fits available screen/viewport width and height
 * without scrolling, considering fullscreen vs windowed mode.
 *
 * @param {object} [options]
 * @param {number} [options.guardPx=1] - Guard pixel width per cell side (default 1)
 * @param {number} [options.minCorePx=3] - Minimum corePx (default 3, 400x400)
 * @param {number} [options.maxCorePx=10] - Maximum corePx (default 14, 1280x1280)
 * @param {number} [options.viewportWidth] - Explicit width for testing
 * @param {number} [options.viewportHeight] - Explicit height for testing
 * @param {boolean} [options.isFullscreen] - Explicit fullscreen state for testing
 * @param {number} [options.containerPadding] - Explicit quiet zone padding
 * @returns {number} Largest integer corePx fitting the viewport
 */
export function computeAutoCorePx(options = {}) {
  const guardPx = options.guardPx !== undefined ? options.guardPx : 1;
  const minCore = options.minCorePx !== undefined ? options.minCorePx : 3;
  const maxCore = options.maxCorePx !== undefined ? options.maxCorePx : 14;

  const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';
  const isFs = options.isFullscreen !== undefined
    ? !!options.isFullscreen
    : (hasDom ? !!(document.fullscreenElement || document.webkitFullscreenElement) : false);

  const vw = options.viewportWidth !== undefined
    ? options.viewportWidth
    : (hasDom ? (window.innerWidth || (window.screen ? window.screen.width : 1366)) : 1366);

  const vh = options.viewportHeight !== undefined
    ? options.viewportHeight
    : (hasDom ? (window.innerHeight || (window.screen ? window.screen.height : 768)) : 768);

  let availW, availH;

  if (isFs) {
    let padX = options.containerPadding !== undefined ? options.containerPadding : 40;
    let padY = options.containerPadding !== undefined ? options.containerPadding : 40;
    if (hasDom && options.containerPadding === undefined) {
      const container = document.getElementById('canvasArea');
      if (container) {
        const cs = window.getComputedStyle(container);
        padX = (parseFloat(cs.paddingLeft) || 20) + (parseFloat(cs.paddingRight) || 20);
        padY = (parseFloat(cs.paddingTop) || 20) + (parseFloat(cs.paddingBottom) || 20);
      }
    }
    availW = Math.max(0, vw - padX);
    availH = Math.max(0, vh - padY);
  } else {
    let padX = options.containerPadding !== undefined ? options.containerPadding : 40;
    let padY = options.containerPadding !== undefined ? options.containerPadding : 40;
    let topOffset = 180;
    let belowOffset = 50;

    const stageEl = hasDom ? document.getElementById('canvasArea') : null;
    if (stageEl && stageEl.clientWidth > 0 && stageEl.clientHeight > 0) {
      // Workspace layout: the stage is sized by the page grid (independent of the canvas),
      // so the available area is simply its content box.
      if (options.containerPadding === undefined) {
        const cs = window.getComputedStyle(stageEl);
        padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      }
      availW = Math.max(0, stageEl.clientWidth - padX);
      availH = Math.max(0, stageEl.clientHeight - padY);
    } else if (hasDom) {
      const container = document.getElementById('canvasArea');
      if (container) {
        const cs = window.getComputedStyle(container);
        if (options.containerPadding === undefined) {
          padX = (parseFloat(cs.paddingLeft) || 20) + (parseFloat(cs.paddingRight) || 20);
          padY = (parseFloat(cs.paddingTop) || 20) + (parseFloat(cs.paddingBottom) || 20);
        }

        const rect = container.getBoundingClientRect();
        topOffset = rect.top + window.scrollY;

        const mb = parseFloat(cs.marginBottom) || 24;
        const hudEl = document.getElementById('hud');
        // Factor in HUD height if visible, or anticipate ~72px when hidden for active transmission
        const hudH = hudEl ? ((hudEl.style.display !== 'none' && hudEl.offsetHeight > 0) ? hudEl.offsetHeight + 16 : 72) : 0;

        const mainEl = document.querySelector('main');
        const mainCs = mainEl ? window.getComputedStyle(mainEl) : null;
        const mainPb = mainCs ? (parseFloat(mainCs.paddingBottom) || 32) : 32;

        belowOffset = mb + hudH + mainPb;
      }

      const mainEl = document.querySelector('main');
      let maxContentW = Math.min(vw - 64, 836);
      if (mainEl) {
        const mainCs = window.getComputedStyle(mainEl);
        const pl = parseFloat(mainCs.paddingLeft) || 32;
        const pr = parseFloat(mainCs.paddingRight) || 32;
        maxContentW = Math.max(0, mainEl.clientWidth - pl - pr);
      }
      availW = Math.max(0, maxContentW - padX);
      availH = Math.max(0, vh - topOffset - padY - belowOffset);
    } else {
      availW = Math.max(0, Math.min(vw - 64, 836) - padX);
      availH = Math.max(0, vh - topOffset - padY - belowOffset);
    }
  }

  const maxDim = Math.min(availW, availH);
  const gridSize = options.gridSize || 80;
  const maxCellPx = Math.floor(maxDim / gridSize);
  const corePx = maxCellPx - 2 * guardPx;

  return Math.max(minCore, Math.min(maxCore, corePx));
}

/**
 * Calculates cellPx and total image dimension for a given corePx, guardPx, and gridSize.
 *
 * @param {number} corePx
 * @param {number} [guardPx=1]
 * @param {number} [gridSize=80]
 * @returns {{ corePx: number, guardPx: number, cellPx: number, dim: number, gridSize: number }}
 */
export function getDimensionsForCorePx(corePx, guardPx = 1, gridSize = 80) {
  const cellPx = corePx + 2 * guardPx;
  const dim = gridSize * cellPx;
  return { corePx, guardPx, cellPx, dim, gridSize };
}

export class TxCanvasRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {number|object} [scaleOrOptions=1]
   * @param {number} [dim]
   */
  constructor(canvas, scaleOrOptions = 1, dim = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: false });
    if (this.ctx) {
      this.ctx.imageSmoothingEnabled = false;
    }
    if (canvas && canvas.style) {
      canvas.style.imageRendering = 'pixelated';
    }

    let targetDim = 800;
    if (typeof scaleOrOptions === 'object' && scaleOrOptions !== null) {
      this.scale = scaleOrOptions.scale || 1;
      targetDim = scaleOrOptions.dim || scaleOrOptions.width || (800 * this.scale);
    } else {
      this.scale = scaleOrOptions || 1;
      targetDim = dim || (800 * this.scale);
    }

    this.dim = targetDim;
    this.setSize(targetDim);
  }

  /**
   * Updates canvas dimensions and pre-allocates matching ImageData.
   *
   * @param {number} dim
   */
  setSize(dim) {
    if (this.dim === dim && this.imgData && this.canvas.width === dim && this.canvas.height === dim) {
      return;
    }
    this.dim = dim;
    this.canvas.width = dim;
    this.canvas.height = dim;
    if (this.canvas && this.canvas.style) {
      this.canvas.style.imageRendering = 'pixelated';
    }
    if (this.ctx) {
      this.ctx.imageSmoothingEnabled = false;
      this.imgData = this.ctx.createImageData(dim, dim);
    }
  }

  /**
   * Returns preallocated ImageData buffer for zero-copy frame generation.
   * @returns {Uint8ClampedArray|null}
   */
  getBackingBuffer() {
    return this.imgData ? this.imgData.data : null;
  }

  /**
   * Updates canvas display with rendered RGBA buffer.
   * Dynamically resizes if buffer dimensions differ.
   *
   * @param {Uint8ClampedArray} rgba
   * @param {number} [width]
   * @param {number} [height]
   */
  displayFrame(rgba, width, height) {
    const frameDim = width || (height || Math.round(Math.sqrt(rgba.length / 4)));
    if (frameDim !== this.dim || !this.imgData || this.imgData.data.length !== rgba.length) {
      this.setSize(frameDim);
    }
    if (this.imgData && rgba !== this.imgData.data) {
      this.imgData.data.set(rgba);
    }
    if (this.ctx && this.imgData) {
      this.ctx.putImageData(this.imgData, 0, 0);
    }
  }
}
