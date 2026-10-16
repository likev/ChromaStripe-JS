/**
 * Source stream manifest serialization and deserialization.
 */

import { MAGIC_MANIFEST } from '../frame/constants.js';

/**
 * Encodes manifest structure into a byte buffer.
 *
 * @param {object} meta
 * @param {string} meta.fileName
 * @param {string} meta.mimeType
 * @param {number} meta.originalSize
 * @param {number} meta.payloadSize
 * @param {Uint8Array} meta.sha256Bytes - 32-byte hash of uncompressed file
 * @param {boolean} [meta.isCompressed=false]
 * @returns {Uint8Array}
 */
export function encodeManifest(meta) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(meta.fileName || 'file.bin');
  const mimeBytes = enc.encode(meta.mimeType || 'application/octet-stream');

  if (nameBytes.length > 255) throw new Error('File name exceeds 255 bytes');
  if (mimeBytes.length > 255) throw new Error('MIME type exceeds 255 bytes');
  if (meta.sha256Bytes.length !== 32) throw new Error('SHA-256 must be 32 bytes');

  // Header: 4 (magic) + 2 (len) + 1 (flags) + 4 (orig) + 4 (payl) + 32 (sha) + 1 (nLen) + name + 1 (mLen) + mime
  const totalLen = 4 + 2 + 1 + 4 + 4 + 32 + 1 + nameBytes.length + 1 + mimeBytes.length;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);

  // Magic "CSv1"
  out[0] = 0x43; out[1] = 0x53; out[2] = 0x76; out[3] = 0x31;

  // manifestLen (u16)
  view.setUint16(4, totalLen, false);

  // flags (u8)
  out[6] = meta.isCompressed ? 1 : 0;

  // originalSize (u32)
  view.setUint32(7, meta.originalSize >>> 0, false);

  // payloadSize (u32)
  view.setUint32(11, meta.payloadSize >>> 0, false);

  // sha256 (32 bytes)
  out.set(meta.sha256Bytes, 15);

  let offset = 47;
  // nameLen + name
  out[offset++] = nameBytes.length;
  out.set(nameBytes, offset);
  offset += nameBytes.length;

  // mimeLen + mime
  out[offset++] = mimeBytes.length;
  out.set(mimeBytes, offset);

  return out;
}

/**
 * Decodes manifest from the start of a source stream.
 *
 * @param {Uint8Array} streamBytes
 * @returns {{ manifest: object, manifestLen: number } | null}
 */
export function decodeManifest(streamBytes) {
  if (streamBytes.length < 49) return null; // Minimum header length

  // Check magic "CSv1"
  if (
    streamBytes[0] !== 0x43 ||
    streamBytes[1] !== 0x53 ||
    streamBytes[2] !== 0x76 ||
    streamBytes[3] !== 0x31
  ) {
    return null;
  }

  const view = new DataView(streamBytes.buffer, streamBytes.byteOffset, streamBytes.byteLength);
  const manifestLen = view.getUint16(4, false);
  if (streamBytes.length < manifestLen) return null;

  const flags = streamBytes[6];
  const isCompressed = (flags & 1) !== 0;
  const originalSize = view.getUint32(7, false);
  const payloadSize = view.getUint32(11, false);

  const sha256Bytes = new Uint8Array(32);
  sha256Bytes.set(streamBytes.subarray(15, 47));

  let offset = 47;
  const nameLen = streamBytes[offset++];
  if (offset + nameLen > manifestLen) return null;
  const dec = new TextDecoder();
  const fileName = dec.decode(streamBytes.subarray(offset, offset + nameLen));
  offset += nameLen;

  const mimeLen = streamBytes[offset++];
  if (offset + mimeLen > manifestLen) return null;
  const mimeType = dec.decode(streamBytes.subarray(offset, offset + mimeLen));

  return {
    manifest: {
      fileName,
      mimeType,
      originalSize,
      payloadSize,
      sha256Bytes,
      isCompressed
    },
    manifestLen
  };
}
