/**
 * Level 0 Simulation: Stripe-erasure channel models.
 */

import { PRNG } from '../../src/core/prng.js';

export class ErasureChannel {
  /**
   * @param {object} options
   * @param {string} [options.model='bernoulli'] - 'bernoulli' | 'gilbert-elliott' | 'stuck-tear'
   * @param {number} [options.lossProb=0.15] - For bernoulli
   * @param {number} [options.burstLength=10] - For gilbert-elliott
   * @param {number} [options.seed=123]
   */
  constructor(options = {}) {
    this.model = options.model || 'bernoulli';
    this.lossProb = options.lossProb ?? 0.15;
    this.burstLength = options.burstLength || 10;
    this.rng = new PRNG(options.seed || 123);

    // Gilbert-Elliott state: 0 = Good, 1 = Bad
    this.geState = 0;
    this.geP_GB = 1.0 / Math.max(1, (this.burstLength * 4)); // Transition Good -> Bad
    this.geP_BG = 1.0 / Math.max(1, this.burstLength);       // Transition Bad -> Good

    // Stuck-tear state: index of stripe currently torn [0..3]
    this.stuckStripe = 1;
    this.stuckProb = 0.85;
    this.driftCounter = 0;
  }

  /**
   * Determines if a stripe packet is successfully received without erasure.
   *
   * @param {number} stripeIdx - 0..3
   * @param {number} frameNo - Frame index
   * @returns {boolean} true if survived, false if erased
   */
  transmit(stripeIdx, frameNo) {
    switch (this.model) {
      case 'bernoulli':
        return this.rng.nextFloat() >= this.lossProb;

      case 'gilbert-elliott': {
        // Update Markov state
        if (this.geState === 0) {
          if (this.rng.nextFloat() < this.geP_GB) this.geState = 1;
        } else {
          if (this.rng.nextFloat() < this.geP_BG) this.geState = 0;
        }
        const pLoss = this.geState === 0 ? 0.02 : 0.80;
        return this.rng.nextFloat() >= pLoss;
      }

      case 'stuck-tear': {
        // Slowly drift the tear position every 30 frames
        if (frameNo !== this.driftCounter) {
          this.driftCounter = frameNo;
          if (frameNo % 30 === 0) {
            this.stuckStripe = (this.stuckStripe + 1) % 4;
          }
        }
        if (stripeIdx === this.stuckStripe) {
          return this.rng.nextFloat() >= this.stuckProb;
        }
        // Other stripes have low baseline loss
        return this.rng.nextFloat() >= 0.05;
      }

      default:
        return true;
    }
  }
}
