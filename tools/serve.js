/**
 * Zero-dependency static HTTP/HTTPS file server using Node.js built-ins.
 * Serves production dist/ build if available, or web/ development workspace.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const useHttps = args.includes('--https');
const port = parseInt(process.env.PORT || (useHttps ? '8443' : '8080'), 10);

const hasDist = fs.existsSync(path.resolve('dist/index.html'));

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

function resolveCandidatePath(reqUrl) {
  // If dist/ build exists and request is not explicitly targeted to /web/, /src/, or /sim/:
  if (hasDist && !reqUrl.startsWith('/web/') && !reqUrl.startsWith('/src/') && !reqUrl.startsWith('/sim/')) {
    const distCandidate = path.resolve('./dist' + reqUrl);
    if (distCandidate.startsWith(process.cwd())) {
      if (fs.existsSync(distCandidate)) {
        if (fs.statSync(distCandidate).isDirectory()) {
          const idx = path.join(distCandidate, 'index.html');
          if (fs.existsSync(idx)) return idx;
        } else {
          return distCandidate;
        }
      }
      if (fs.existsSync(distCandidate + '.html') && fs.statSync(distCandidate + '.html').isFile()) {
        return distCandidate + '.html';
      }
    }
  }

  // 1. Direct workspace path
  const directPath = path.resolve('.' + reqUrl);
  if (directPath.startsWith(process.cwd()) && fs.existsSync(directPath)) {
    if (fs.statSync(directPath).isDirectory()) {
      const idx = path.join(directPath, 'index.html');
      if (fs.existsSync(idx)) return idx;
    } else {
      return directPath;
    }
  }

  // 2. Fallback under web/
  const webPath = path.resolve('./web' + reqUrl);
  if (webPath.startsWith(process.cwd())) {
    if (fs.existsSync(webPath)) {
      if (fs.statSync(webPath).isDirectory()) {
        const idx = path.join(webPath, 'index.html');
        if (fs.existsSync(idx)) return idx;
      } else {
        return webPath;
      }
    }
    if (fs.existsSync(webPath + '.html') && fs.statSync(webPath + '.html').isFile()) {
      return webPath + '.html';
    }
  }

  // 3. Fallback under web/public/
  const publicPath = path.resolve('./web/public' + reqUrl);
  if (publicPath.startsWith(process.cwd()) && fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) {
    return publicPath;
  }

  // 4. Fallback if requested with /web/ prefix pointing to web/public
  if (reqUrl.startsWith('/web/')) {
    const webPublicPath = path.resolve('./web/public' + reqUrl.slice(4));
    if (webPublicPath.startsWith(process.cwd()) && fs.existsSync(webPublicPath) && fs.statSync(webPublicPath).isFile()) {
      return webPublicPath;
    }
  }

  return null;
}

function requestHandler(req, res) {
  let reqUrl = req.url.split('?')[0];
  if (reqUrl === '/') {
    reqUrl = hasDist ? '/index.html' : '/web/index.html';
  }

  const filePath = resolveCandidatePath(reqUrl);

  if (!filePath) {
    const notFoundCandidate = hasDist
      ? path.resolve('./dist/404.html')
      : path.resolve('./web/404.html');

    if (fs.existsSync(notFoundCandidate)) {
      res.writeHead(404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      });
      fs.createReadStream(notFoundCandidate).pipe(res);
      return;
    }

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
    console.log(`[ChromaStripe Server] SSL certificates missing. Generating self-signed certs...`);
    try {
      execSync('bash tools/make-cert.sh', { stdio: 'inherit' });
    } catch (err) {
      console.error(`[Error] Failed to generate SSL certificates:`, err);
      process.exit(1);
    }
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
  if (hasDist) {
    console.log(`[ChromaStripe Server] Serving production PWA bundle (dist/): ${proto}://localhost:${port}/`);
  } else {
    console.log(`[ChromaStripe Server] Serving development workspace (web/): ${proto}://localhost:${port}/`);
  }
});
