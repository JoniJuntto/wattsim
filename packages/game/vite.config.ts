import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const shim = (f: string) => path.resolve(import.meta.dirname, 'src/shims', f);

export default defineConfig({
  // Relative asset paths: the build is a static folder that can be served from anywhere.
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    // @wattsim/core imports these at module level for features the game never uses (OCMF signing, Prometheus).
    alias: { 'node:crypto': shim('crypto.ts'), 'prom-client': shim('prom-client.ts') },
  },
  server: { port: 5174 },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2500 },
});
