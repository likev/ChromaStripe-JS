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
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream not supported in this environment');
  }

  const ds = new DecompressionStream('deflate-raw');
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
