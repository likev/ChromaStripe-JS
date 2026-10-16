/**
 * Shared UI helper utilities.
 */

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function checkBrowserCapabilities() {
  const caps = {
    webCrypto: typeof crypto !== 'undefined' && !!crypto.subtle,
    compressionStream: typeof CompressionStream !== 'undefined',
    decompressionStream: typeof DecompressionStream !== 'undefined',
    camera: typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    videoFrame: typeof VideoFrame !== 'undefined'
  };

  caps.allSupported = caps.webCrypto && caps.compressionStream && caps.decompressionStream;
  return caps;
}
