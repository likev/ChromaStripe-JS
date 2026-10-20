/**
 * Fountain code decoder: Graph-peeling + Inactivation Gaussian Elimination.
 */

import { getDropletIndices } from './schedule.js';
import { solveBinarySystem } from './gauss.js';

export class FountainDecoder {
  /**
   * @param {number} K - Total number of source blocks
   * @param {{legacyDegree?: boolean}} [options]
   */
  constructor(K, options = {}) {
    this.K = K;
    this.legacyDegree = !!options.legacyDegree;
    this.solved = new Array(K).fill(null);
    this.isSolved = new Uint8Array(K);
    this.solvedCount = 0;
    this.receivedCount = 0;
    this.seenSeeds = new Set();
    this.waitingList = []; // Array<{ indices: number[], payload: Uint32Array }>
    this.words = null;
  }

  /**
   * Whether all K source blocks have been decoded.
   * @returns {boolean}
   */
  isComplete() {
    return this.solvedCount === this.K;
  }

  /**
   * Current decode progress.
   * @returns {{ solvedCount: number, K: number, receivedCount: number, percent: number }}
   */
  getProgress() {
    const distinctCollected = this.solvedCount + Math.min(this.waitingList.length, this.K - this.solvedCount);
    return {
      solvedCount: this.solvedCount,
      waitingCount: this.waitingList.length,
      distinctCount: distinctCollected,
      K: this.K,
      receivedCount: this.receivedCount,
      percent: this.K > 0 ? (this.isComplete() ? 1.0 : Math.min(0.99, distinctCollected / this.K)) : 1
    };
  }

  /**
   * Ingests one verified droplet.
   *
   * @param {number} seed - Droplet seed
   * @param {Uint32Array} payloadU32 - Droplet payload
   * @returns {boolean} true if droplet provided new information
   */
  addDroplet(seed, payloadU32) {
    if (this.isComplete()) return false;
    if (this.seenSeeds.has(seed)) return false;

    if (this.words === null && payloadU32) {
      this.words = payloadU32.length;
    }
    const words = this.words || 112;

    this.seenSeeds.add(seed);
    this.receivedCount++;

    const rawIndices = getDropletIndices(seed, this.K, 0.15, this.legacyDegree);
    const payload = new Uint32Array(payloadU32);

    // XOR out all currently solved blocks
    const activeIndices = [];
    for (let i = 0; i < rawIndices.length; i++) {
      const idx = rawIndices[i];
      if (this.isSolved[idx]) {
        const solvedBlock = this.solved[idx];
        for (let w = 0; w < words; w++) {
          payload[w] ^= solvedBlock[w];
        }
      } else {
        activeIndices.push(idx);
      }
    }

    if (activeIndices.length === 0) {
      return false; // Redundant droplet
    }

    if (activeIndices.length === 1) {
      this._solveBlock(activeIndices[0], payload);
      this._peelCascade();
    } else {
      this.waitingList.push({ indices: activeIndices, payload });
    }

    // If not complete and we have enough waiting equations, attempt Inactivation GE
    if (!this.isComplete() && this.waitingList.length > 0) {
      const numUnknowns = this.K - this.solvedCount;
      if (this.waitingList.length >= numUnknowns) {
        this._tryInactivationGE(numUnknowns);
      }
    }

    return true;
  }

  /**
   * Marks a block as solved and increments solvedCount.
   * @private
   */
  _solveBlock(blockIdx, payload) {
    if (this.isSolved[blockIdx]) return;
    this.solved[blockIdx] = payload;
    this.isSolved[blockIdx] = 1;
    this.solvedCount++;
  }

  /**
   * Recursively peels any waiting equations that now have degree 1.
   * @private
   */
  _peelCascade() {
    let progress = true;

    while (progress && !this.isComplete()) {
      progress = false;
      const nextWaiting = [];

      for (let i = 0; i < this.waitingList.length; i++) {
        const eq = this.waitingList[i];
        const nextIndices = [];

        for (let j = 0; j < eq.indices.length; j++) {
          const idx = eq.indices[j];
          if (this.isSolved[idx]) {
            const block = this.solved[idx];
            const words = this.words || 112;
            for (let w = 0; w < words; w++) {
              eq.payload[w] ^= block[w];
            }
          } else {
            nextIndices.push(idx);
          }
        }

        if (nextIndices.length === 0) {
          // Completely canceled out, discard
          progress = true;
        } else if (nextIndices.length === 1) {
          // Degree-1 reduction!
          this._solveBlock(nextIndices[0], eq.payload);
          progress = true;
        } else {
          eq.indices = nextIndices;
          nextWaiting.push(eq);
        }
      }

      this.waitingList = nextWaiting;
    }
  }

  /**
   * Attempts bit-packed Gaussian elimination over remaining unknown blocks.
   * @private
   */
  _tryInactivationGE(numUnknowns) {
    if (this.isComplete() || this.waitingList.length === 0) return;

    // Map unknown block indices to 0..numUnknowns-1
    const unknownMap = new Int32Array(this.K).fill(-1);
    const revUnknownMap = new Int32Array(numUnknowns);
    let uCount = 0;

    for (let i = 0; i < this.K; i++) {
      if (!this.isSolved[i]) {
        unknownMap[i] = uCount;
        revUnknownMap[uCount] = i;
        uCount++;
      }
    }

    if (uCount === 0) return;

    const numWords = Math.ceil(uCount / 32);
    const equations = [];

    for (let i = 0; i < this.waitingList.length; i++) {
      const eq = this.waitingList[i];
      const mask = new Uint32Array(numWords);
      let rhs = eq.payload;
      let rhsCopied = false;
      let valid = false;

      for (let j = 0; j < eq.indices.length; j++) {
        const idx = eq.indices[j];
        if (this.isSolved[idx]) {
          if (!rhsCopied) {
            rhs = new Uint32Array(eq.payload);
            rhsCopied = true;
          }
          const solvedBlock = this.solved[idx];
          const words = this.words || 112;
          for (let w = 0; w < words; w++) {
            rhs[w] ^= solvedBlock[w];
          }
        } else {
          const uIdx = unknownMap[idx];
          if (uIdx >= 0) {
            mask[uIdx >>> 5] |= (1 << (uIdx & 31));
            valid = true;
          }
        }
      }

      if (valid) {
        equations.push({ mask, rhs });
      }
    }

    if (equations.length === 0) return;

    const res = solveBinarySystem(equations, uCount);

    if (res.success && res.solution) {
      for (let i = 0; i < uCount; i++) {
        const origBlockIdx = revUnknownMap[i];
        this._solveBlock(origBlockIdx, res.solution[i]);
      }
      this.waitingList = [];
      return;
    }

    // Partial solutions from rows with Hamming weight 1
    const hasPartial = res.partialSolutions && res.partialSolutions.length > 0;
    if (hasPartial) {
      for (let i = 0; i < res.partialSolutions.length; i++) {
        const { col, value } = res.partialSolutions[i];
        const origBlockIdx = revUnknownMap[col];
        this._solveBlock(origBlockIdx, value);
      }
    }

    // Reconstruct waiting list from reduced equations with Hamming weight > 1
    if (hasPartial || (res.reducedEquations && res.reducedEquations.length < this.waitingList.length)) {
      const newWaiting = [];
      if (res.reducedEquations) {
        for (let i = 0; i < res.reducedEquations.length; i++) {
          const origIndices = res.reducedEquations[i].cols.map(c => revUnknownMap[c]);
          newWaiting.push({
            indices: origIndices,
            payload: res.reducedEquations[i].rhs
          });
        }
      }
      this.waitingList = newWaiting;

      if (hasPartial) {
        this._peelCascade();
      }
    }

    if (this.isComplete()) {
      this.waitingList = [];
    }
  }

  /**
   * Returns all reconstructed source blocks concatenated into a single Uint8Array.
   * @returns {Uint8Array}
   */
  getReconstructedBytes() {
    if (!this.isComplete()) {
      throw new Error(`Cannot get bytes: only ${this.solvedCount}/${this.K} blocks solved`);
    }

    const words = this.words || 112;
    const bytesPerBlock = words * 4;
    const out = new Uint8Array(this.K * bytesPerBlock);
    for (let i = 0; i < this.K; i++) {
      const u32 = this.solved[i];
      const u8 = new Uint8Array(u32.buffer, u32.byteOffset, bytesPerBlock);
      out.set(u8, i * bytesPerBlock);
    }
    return out;
  }
}
