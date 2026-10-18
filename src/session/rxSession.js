/**
 * Receive session manager: Session locking, fountain ingestion, reassembly,
 * decompression, and SHA-256 integrity verification.
 */

import { FountainDecoder } from '../fountain/decoder.js';
import { decodeManifest } from './manifest.js';
import { decompressDeflateRaw } from './compression.js';
import { digestSha256 } from '../core/sha256.js';

export class RxSession {
  constructor() {
    this.reset();
  }

  reset() {
    this.sessionId = null;
    this.K = null;
    this.fountainDecoder = null;
    this.isComplete = false;
    this.result = null;
    this.error = null;
  }

  /**
   * Ingests a decoded stripe packet.
   *
   * @param {object} header - { sessionId, K, seed, stripeIdx, phase }
   * @param {Uint32Array} payloadU32 - 112 words
   * @returns {Promise<boolean>} true if droplet provided new information
   */
  async ingestPacket(header, payloadU32) {
    if (this.isComplete) return false;

    // Lock session on first packet
    if (this.sessionId === null) {
      this.sessionId = header.sessionId;
      this.K = header.K;
      this.fountainDecoder = new FountainDecoder(this.K);
      this.newSessionCount = 0;
    } else if (header.sessionId !== this.sessionId) {
      // Packet from a different session
      this.newSessionCount = (this.newSessionCount || 0) + 1;
      if (this.newSessionCount >= 4) {
        // Automatically switch to new session if sender restarted with a different file
        this.reset();
        this.sessionId = header.sessionId;
        this.K = header.K;
        this.fountainDecoder = new FountainDecoder(this.K);
        this.newSessionCount = 0;
      } else {
        return false;
      }
    } else {
      this.newSessionCount = 0;
    }

    const added = this.fountainDecoder.addDroplet(header.seed, payloadU32);

    if (this.fountainDecoder.isComplete() && !this.isComplete) {
      await this._finalize();
    }

    return added;
  }

  /**
   * Finalizes the transfer: parses manifest, decompresses, verifies hash.
   * @private
   */
  async _finalize() {
    try {
      const streamBytes = this.fountainDecoder.getReconstructedBytes();
      const manifestRes = decodeManifest(streamBytes);

      if (!manifestRes) {
        throw new Error('CORRUPT_MANIFEST: Unable to decode stream manifest');
      }

      const { manifest, manifestLen } = manifestRes;
      const rawPayload = streamBytes.subarray(manifestLen, manifestLen + manifest.payloadSize);

      let finalData = rawPayload;
      if (manifest.isCompressed) {
        finalData = await decompressDeflateRaw(rawPayload);
      }

      // Check SHA-256
      const actualHash = await digestSha256(finalData);
      let hashMatch = actualHash.length === manifest.sha256Bytes.length;
      for (let i = 0; i < actualHash.length && hashMatch; i++) {
        if (actualHash[i] !== manifest.sha256Bytes[i]) {
          hashMatch = false;
        }
      }

      if (!hashMatch) {
        throw new Error('SHA256_MISMATCH: Reconstructed file failed integrity check');
      }

      this.isComplete = true;
      this.result = {
        fileName: manifest.fileName,
        mimeType: manifest.mimeType,
        originalSize: manifest.originalSize,
        data: finalData,
        sha256Verified: true
      };
    } catch (err) {
      this.error = err.message || String(err);
      this.isComplete = false;
      throw err;
    }
  }

  /**
   * Current receive progress.
   * @returns {{
   *   isComplete: boolean,
   *   solvedCount: number,
   *   K: number,
   *   percent: number,
   *   receivedCount: number
   * }}
   */
  getProgress() {
    if (!this.fountainDecoder) {
      return { isComplete: false, solvedCount: 0, waitingCount: 0, distinctCount: 0, K: 0, percent: 0, receivedCount: 0 };
    }
    const p = this.fountainDecoder.getProgress();
    return {
      isComplete: this.isComplete,
      ...p
    };
  }
}
