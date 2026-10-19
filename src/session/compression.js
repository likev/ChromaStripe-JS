/**
 * Compression module using native CompressionStream('deflate-raw') and DecompressionStream.
 */

/**
 * Compresses bytes using deflate-raw stream.
 *
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function compressDeflateRaw(data) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream not supported in this environment');
  }

  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();

  const reader = cs.readable.getReader();
  const chunks = [];
  let totalLen = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }

  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Decompresses deflate-raw compressed bytes.
 *
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function decompressDeflateRaw(data) {
  return decompressWithFormat(data, 'deflate-raw');
}

/**
 * Compresses bytes using gzip stream.
 */
export async function compressGzip(data) {
  return compressWithFormat(data, 'gzip');
}

/**
 * Decompresses gzip compressed bytes.
 */
export async function decompressGzip(data) {
  return decompressWithFormat(data, 'gzip');
}

/**
 * Compresses bytes using deflate stream.
 */
export async function compressDeflate(data) {
  return compressWithFormat(data, 'deflate');
}

/**
 * Decompresses deflate compressed bytes.
 */
export async function decompressDeflate(data) {
  return decompressWithFormat(data, 'deflate');
}

async function compressWithFormat(data, format) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream not supported in this environment');
  }
  const cs = new CompressionStream(format);
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();

  const reader = cs.readable.getReader();
  const chunks = [];
  let totalLen = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function decompressWithFormat(data, format) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream not supported in this environment');
  }
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();

  const reader = ds.readable.getReader();
  const chunks = [];
  let totalLen = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Applies 1st-order byte delta filter: y[0]=x[0], y[i]=(x[i]-x[i-1]) mod 256.
 * Significantly improves compression for audio, telemetry, sensor logs, and bitmaps.
 */
export function applyDeltaFilter(data) {
  const out = new Uint8Array(data.length);
  if (data.length === 0) return out;
  out[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    out[i] = (data[i] - data[i - 1]) & 0xFF;
  }
  return out;
}

/**
 * Inverts 1st-order byte delta filter.
 */
export function invertDeltaFilter(data) {
  const out = new Uint8Array(data.length);
  if (data.length === 0) return out;
  out[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    out[i] = (out[i - 1] + data[i]) & 0xFF;
  }
  return out;
}

export const COMPRESSION_FORMATS = {
  NONE: 0,
  DEFLATE_RAW: 1,
  GZIP: 2,
  DEFLATE: 3,
  DELTA_DEFLATE_RAW: 4
};

/**
 * Automatically evaluates candidate compression pipelines and selects the best.
 *
 * @param {Uint8Array} data - Input bytes
 * @returns {Promise<{ data: Uint8Array, format: number, isCompressed: boolean }>}
 */
export async function compressAuto(data) {
  const originalSize = data.length;
  if (originalSize <= 64) {
    return { data, format: COMPRESSION_FORMATS.NONE, isCompressed: false };
  }

  let bestData = data;
  let bestFormat = COMPRESSION_FORMATS.NONE;
  let minSize = originalSize * 0.98; // Minimum 2% threshold to justify compression

  // Candidate 1: Deflate-raw
  try {
    const cDefRaw = await compressDeflateRaw(data);
    if (cDefRaw.length < minSize) {
      minSize = cDefRaw.length;
      bestData = cDefRaw;
      bestFormat = COMPRESSION_FORMATS.DEFLATE_RAW;
    }
  } catch (_) {}

  // Candidate 2: Deflate
  try {
    const cDef = await compressDeflate(data);
    if (cDef.length < minSize) {
      minSize = cDef.length;
      bestData = cDef;
      bestFormat = COMPRESSION_FORMATS.DEFLATE;
    }
  } catch (_) {}

  // Candidate 3: Gzip
  try {
    const cGzip = await compressGzip(data);
    if (cGzip.length < minSize) {
      minSize = cGzip.length;
      bestData = cGzip;
      bestFormat = COMPRESSION_FORMATS.GZIP;
    }
  } catch (_) {}

  // Candidate 4: Delta + Deflate-raw
  try {
    const delta = applyDeltaFilter(data);
    const cDelta = await compressDeflateRaw(delta);
    if (cDelta.length < minSize) {
      minSize = cDelta.length;
      bestData = cDelta;
      bestFormat = COMPRESSION_FORMATS.DELTA_DEFLATE_RAW;
    }
  } catch (_) {}

  return {
    data: bestData,
    format: bestFormat,
    isCompressed: bestFormat !== COMPRESSION_FORMATS.NONE
  };
}

/**
 * Decompresses data according to the format identifier.
 *
 * @param {Uint8Array} data
 * @param {number} format - COMPRESSION_FORMATS enum
 * @returns {Promise<Uint8Array>}
 */
export async function decompressFormatted(data, format) {
  switch (format) {
    case COMPRESSION_FORMATS.NONE:
      return data;
    case COMPRESSION_FORMATS.DEFLATE_RAW:
      return decompressDeflateRaw(data);
    case COMPRESSION_FORMATS.GZIP:
      return decompressGzip(data);
    case COMPRESSION_FORMATS.DEFLATE:
      return decompressDeflate(data);
    case COMPRESSION_FORMATS.DELTA_DEFLATE_RAW: {
      const deflated = await decompressDeflateRaw(data);
      return invertDeltaFilter(deflated);
    }
    default:
      // Backward compatibility fallback to deflate-raw
      return decompressDeflateRaw(data);
  }
}

