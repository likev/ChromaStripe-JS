import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  base: './',
  root: 'web',
  publicDir: resolve(__dirname, 'web/public'),
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'web/index.html'),
        send: resolve(__dirname, 'web/send.html'),
        receive: resolve(__dirname, 'web/receive.html'),
        sim: resolve(__dirname, 'web/sim.html')
      }
    }
  },
  server: {
    fs: {
      allow: [resolve(__dirname)]
    }
  },
  worker: {
    format: 'es'
  }
});
