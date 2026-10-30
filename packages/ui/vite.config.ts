import type { ClientRequest, IncomingMessage } from 'node:http';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.WATTSIM_API ?? 'http://localhost:7700';

/**
 * The wattsim server refuses state-changing requests and stream upgrades from any origin but its own. Behind this
 * proxy the app's origin is the dev server's, so a request whose `Origin` is this dev server (the `Host` it was sent
 * to) goes on with the API's origin. Any other origin passes through unchanged, and the API refuses it.
 */
function asApiOrigin(proxyReq: ClientRequest, req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  try {
    if (new URL(origin).host === req.headers.host) proxyReq.setHeader('origin', new URL(api).origin);
  } catch {
    // `null` or garbage: left for the API to refuse
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      // Listed first so the WebSocket upgrade for the stream is matched before the plain `/api` rule.
      '/api/stream': {
        target: api,
        ws: true,
        changeOrigin: true,
        configure: (proxy) => proxy.on('proxyReqWs', asApiOrigin),
      },
      '/api': { target: api, changeOrigin: true, configure: (proxy) => proxy.on('proxyReq', asApiOrigin) },
    },
  },
  // A local tool loaded from localhost: one ~700 kB bundle is fine.
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 1000 },
});
