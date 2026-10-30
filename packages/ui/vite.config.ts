import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.WATTSIM_API ?? 'http://localhost:7700';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      // Listed first so the WebSocket upgrade for the stream is matched before the plain `/api` rule.
      '/api/stream': { target: api, ws: true, changeOrigin: true },
      '/api': { target: api, changeOrigin: true },
    },
  },
  // A local tool loaded from localhost: one ~700 kB bundle is fine.
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 1000 },
});
