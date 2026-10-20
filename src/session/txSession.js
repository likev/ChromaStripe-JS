/**
 * Transmission session: File preparation, compression, manifest framing,
 * droplet fountain generation, and RGBA frame rendering.
 */

import { PAYLOAD_BYTES, PROTOCOL_VERSION, PROTOCOL_VERSION_V2, V2_PAYLOAD_BYTES } from '../frame/constants.js';
import { digestSha256 } from '../core/sha256.js';
import { compressDeflateRaw, compressAuto } from './compression.js';
import { encodeManifest } from './manifest.js';
import { encodeDroplet } from '../fountain/encoder.js';
import { getDropletPhase } from '../fountain/schedule.js';
import { buildPacket, buildPacketV2 } from '../frame/packet.js';
import { renderFrame } from '../frame/renderer.js';
import { getLayoutV2 } from '../frame/layout.js';
import { V2_TURBO_PACKET_BYTES_STANDARD } from '../frame/constants.js';

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
   * @param {number} [options.version=1]
   * @param {number} [options.gridSize=80]
   * @param {number} [options.bitsPerCell]
   * @param {number} [options.numStripes]
   * @param {number} [options.rateMode=1]
   * @param {boolean} [options.turbo] - Force (true) / disable (false) dual-codeword Turbo; auto when omitted (v2)
   */
  constructor(fileData, options = {}) {
    this.fileData = fileData;
    this.fileName = options.fileName || 'file.bin';
    this.mimeType = options.mimeType || 'application/octet-stream';
    this.scale = options.scale || 1;
    this.rotation = options.rotation || 0;
    this.corePx = options.corePx !== undefined ? options.corePx : undefined;
    this.guardPx = options.guardPx !== undefined ? options.guardPx : undefined;

    this.version = options.version || 1;
    // v1 is fixed: 80x80, 3-bit 2-PAM RGB, 4 stripes (never inherit v2 UI settings)
    this.gridSize = this.version === 1 ? 80 : (options.gridSize || 80);
    this.bitsPerCell = this.version === 1 ? 3 : (options.bitsPerCell || 6);
    this.numStripes = this.version === 1 ? 4 : (options.numStripes || 8);
    this.rateMode = options.rateMode !== undefined ? options.rateMode : 1; // 1 = HIGH_RATE

    if (options.payloadWords) {
      this.wordsPerBlock = options.payloadWords;
    } else if (options.turbo === true) {
      this.wordsPerBlock = 112;
    } else if (this.version === 2 && options.turbo !== false) {
      // Auto-Turbo: use dual-codeword packets whenever EVERY stripe can hold one,
      // so the grid is not mostly dummy fill.
      const layout = getLayoutV2({ gridSize: this.gridSize, numStripes: this.numStripes });
      let minCells = Infinity;
      for (const cells of layout.stripeDataCells) minCells = Math.min(minCells, cells.length);
      const fitsTurbo = minCells * this.bitsPerCell >= V2_TURBO_PACKET_BYTES_STANDARD * 8;
      this.wordsPerBlock = fitsTurbo ? 112 : 56;
    } else {
      this.wordsPerBlock = this.version === 2 ? 56 : 112;
    }
    this.payloadBytes = this.wordsPerBlock * 4; // 224 for v2, 448 for v1 or v2 Turbo

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

    let payload = this.fileData;
    let isCompressed = false;
    let compressionFormat;

    if (this.version === 2) {
      const compRes = await compressAuto(this.fileData);
      payload = compRes.data;
      isCompressed = compRes.isCompressed;
      compressionFormat = compRes.format;
    } else {
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
    }

    const payloadSize = payload.length;

    // Create manifest
    this.manifestBytes = encodeManifest({
      fileName: this.fileName,
      mimeType: this.mimeType,
      originalSize,
      payloadSize,
      sha256Bytes,
      isCompressed,
      compressionFormat,
      version: this.version
    });

    // SessionId = first 2 bytes of SHA-256(manifest)
    const manifestSha = await digestSha256(this.manifestBytes);
    this.sessionId = ((manifestSha[0] << 8) | manifestSha[1]) >>> 0;

    // Build source stream: manifest + payload + padding to multiple of payloadBytes
    const totalStreamLen = this.manifestBytes.length + payloadSize;
    this.K = Math.max(1, Math.ceil(totalStreamLen / this.payloadBytes));
    const paddedLen = this.K * this.payloadBytes;

    const stream = new Uint8Array(paddedLen);
    stream.set(this.manifestBytes, 0);
    stream.set(payload, this.manifestBytes.length);

    // Slice into K source blocks (each Uint32Array(wordsPerBlock))
    this.sourceBlocks = new Array(this.K);
    for (let i = 0; i < this.K; i++) {
      const blockU8 = stream.subarray(i * this.payloadBytes, (i + 1) * this.payloadBytes);
      const blockU32 = new Uint32Array(this.wordsPerBlock);
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
    const S = this.numStripes;
    let seeds;
    if (this.K > 2 * S) {
      const cycleLen = Math.max(this.K + S, Math.round(1.5 * this.K));
      const p = Math.ceil(0.15 * this.K);
      const rawSeeds = [];
      for (let i = 0; i < S; i++) rawSeeds.push(S * f + i);
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
      seeds = [];
      for (let i = 0; i < S; i++) seeds.push(S * f + i);
    }
    const packets = new Array(S);

    for (let i = 0; i < S; i++) {
      const seed = seeds[i];
      const phase = getDropletPhase(seed, this.K);
      const dropletU32 = encodeDroplet(seed, this.sourceBlocks);

      if (this.version === 2) {
        packets[i] = buildPacketV2(
          {
            stripeIdx: i,
            phase,
            seed,
            K: this.K,
            sessionId: this.sessionId,
            rateMode: this.rateMode
          },
          dropletU32
        );
      } else {
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
    }

    const renderRes = renderFrame(packets, {
      version: this.version,
      gridSize: this.gridSize,
      bitsPerCell: this.bitsPerCell,
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
