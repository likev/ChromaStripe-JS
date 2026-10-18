/**
 * Zero-dependency static HTTP/HTTPS file server using Node.js built-ins.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const useHttps = args.includes('--https');
const port = parseInt(process.env.PORT || (useHttps ? '8443' : '8080'), 10);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.rgba': 'application/octet-stream'
};

function requestHandler(req, res) {
  let reqUrl = req.url.split('?')[0];
  if (reqUrl === '/') reqUrl = '/web/index.html';

  let filePath = path.resolve('.' + reqUrl);

  // Security check: ensure path is within workspace
  if (!filePath.startsWith(process.cwd())) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // If path is a directory, look for index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // Check fallback in web/public if requested under /web/
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    if (reqUrl.startsWith('/web/')) {
      const publicPath = path.resolve('./web/public' + reqUrl.slice(4));
      if (fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) {
        filePath = publicPath;
      }
    }
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`File not found: ${reqUrl}`);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp'
  };

  res.writeHead(200, headers);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
}

let server;
if (useHttps) {
  const certPath = path.resolve('tools/cert.pem');
  const keyPath = path.resolve('tools/key.pem');

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.error(`[Error] SSL certificate files missing: ${certPath} / ${keyPath}`);
    console.error(`Run ./tools/make-cert.sh first to generate self-signed certs.`);
    process.exit(1);
  }

  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
  server = https.createServer(options, requestHandler);
} else {
  server = http.createServer(requestHandler);
}

server.listen(port, () => {
  const proto = useHttps ? 'https' : 'http';
  console.log(`[ChromaStripe Server] Running at ${proto}://localhost:${port}/`);
  console.log(`[ChromaStripe Server] Web UI: ${proto}://localhost:${port}/web/`);
});
