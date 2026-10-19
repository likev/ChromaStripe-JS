/**
 * Transmission session: File preparation, compression, manifest framing,
 * droplet fountain generation, and RGBA frame rendering.
 */

import { PAYLOAD_BYTES, PROTOCOL_VERSION } from '../frame/constants.js';
import { digestSha256 } from '../core/sha256.js';
import { compressDeflateRaw } from './compression.js';
import { encodeManifest } from './manifest.js';
import { encodeDroplet } from '../fountain/encoder.js';
import { getDropletPhase } from '../fountain/schedule.js';
import { buildPacket } from '../frame/packet.js';
import { renderFrame } from '../frame/renderer.js';

export class TxSession {
  /**
   * @param {Uint8Array} fileData - Raw input file bytes
   * @param {object} [options]
   * @param {string} [options.fileName='file.bin']
   * @param {string} [options.mimeType='application/octet-stream']
   * @param {number} [options.scale=1]
   * @param {number} [options.rotation=0]
   * @param {number} [options.corePx]
   * @param {number} [options.guardPx]
   */
  constructor(fileData, options = {}) {
    this.fileData = fileData;
    this.fileName = options.fileName || 'file.bin';
    this.mimeType = options.mimeType || 'application/octet-stream';
    this.scale = options.scale || 1;
    this.rotation = options.rotation || 0;
    this.corePx = options.corePx !== undefined ? options.corePx : undefined;
    this.guardPx = options.guardPx !== undefined ? options.guardPx : undefined;

    this.isInitialized = false;
    this.K = 0;
    this.sessionId = 0;
    this.sourceBlocks = [];
    this.manifestBytes = null;
    this.frameNo = 0;
  }

  /**
   * Initializes session: compresses, creates manifest, splits into K blocks.
   */
  async init() {
    if (this.isInitialized) return;

    const originalSize = this.fileData.length;
    const sha256Bytes = await digestSha256(this.fileData);

    // Attempt deflate-raw compression
    let payload = this.fileData;
    let isCompressed = false;

    if (originalSize > 64) {
      try {
        const compressed = await compressDeflateRaw(this.fileData);
        // Only use compression if at least 2% smaller
        if (compressed.length <= originalSize * 0.98) {
          payload = compressed;
          isCompressed = true;
        }
      } catch (_) {
        // Fall back to uncompressed
      }
    }

    const payloadSize = payload.length;

    // Create manifest
    this.manifestBytes = encodeManifest({
      fileName: this.fileName,
      mimeType: this.mimeType,
      originalSize,
      payloadSize,
      sha256Bytes,
      isCompressed
    });

    // SessionId = first 2 bytes of SHA-256(manifest)
    const manifestSha = await digestSha256(this.manifestBytes);
    this.sessionId = ((manifestSha[0] << 8) | manifestSha[1]) >>> 0;

    // Build source stream: manifest + payload + padding to multiple of 448
    const totalStreamLen = this.manifestBytes.length + payloadSize;
    this.K = Math.max(1, Math.ceil(totalStreamLen / PAYLOAD_BYTES));
    const paddedLen = this.K * PAYLOAD_BYTES;

    const stream = new Uint8Array(paddedLen);
    stream.set(this.manifestBytes, 0);
    stream.set(payload, this.manifestBytes.length);

    // Slice into K source blocks (each Uint32Array(112))
    this.sourceBlocks = new Array(this.K);
    for (let i = 0; i < this.K; i++) {
      const blockU8 = stream.subarray(i * PAYLOAD_BYTES, (i + 1) * PAYLOAD_BYTES);
      const blockU32 = new Uint32Array(112);
      new Uint8Array(blockU32.buffer).set(blockU8);
      this.sourceBlocks[i] = blockU32;
    }

    this.isInitialized = true;
  }

  /**
   * Generates next frame in sequence.
   *
   * @param {Uint8ClampedArray} [outRgba] - Optional preallocated buffer
   * @returns {{
   *   frameNo: number,
   *   seeds: number[],
   *   packets: Uint8Array[],
   *   width: number,
   *   height: number,
   *   rgba: Uint8ClampedArray
   * }}
   */
  getNextFrame(outRgba) {
    if (!this.isInitialized) {
      throw new Error('TxSession must be initialized before generating frames');
    }

    const f = this.frameNo++;
    let seeds;
    if (this.K > 8) {
      const cycleLen = Math.max(this.K + 4, Math.round(1.5 * this.K));
      const p = Math.ceil(0.15 * this.K);
      const rawSeeds = [4 * f, 4 * f + 1, 4 * f + 2, 4 * f + 3];
      seeds = rawSeeds.map(s => {
        const cycleIdx = Math.floor(s / cycleLen);
        const slotInCycle = s % cycleLen;
        if (slotInCycle < this.K) {
          return (slotInCycle + cycleIdx) % this.K;
        }
        if (slotInCycle < this.K + p) {
          const pSlot = slotInCycle - this.K;
          return this.K + ((pSlot + cycleIdx) % p);
        }
        const p3Slot = slotInCycle - (this.K + p);
        const p3Len = cycleLen - (this.K + p);
        return this.K + p + cycleIdx * p3Len + p3Slot;
      });
    } else {
      seeds = [4 * f, 4 * f + 1, 4 * f + 2, 4 * f + 3];
    }
    const packets = new Array(4);

    for (let i = 0; i < 4; i++) {
      const seed = seeds[i];
      const phase = getDropletPhase(seed, this.K);
      const dropletU32 = encodeDroplet(seed, this.sourceBlocks);

      packets[i] = buildPacket(
        {
          ver: PROTOCOL_VERSION,
          stripeIdx: i,
          phase,
          seed,
          K: this.K,
          sessionId: this.sessionId
        },
        dropletU32
      );
    }

    const renderRes = renderFrame(packets, {
      scale: this.scale,
      rotation: this.rotation,
      corePx: this.corePx,
      guardPx: this.guardPx,
      outRgba
    });

    return {
      frameNo: f,
      seeds,
      packets,
      width: renderRes.width,
      height: renderRes.height,
      rgba: renderRes.rgba,
      cellPx: renderRes.cellPx,
      corePx: renderRes.corePx,
      guardPx: renderRes.guardPx
    };
  }
}
