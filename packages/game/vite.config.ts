import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const shim = path.resolve(import.meta.dirname, 'src/shims/shim.ts');

export default defineConfig({
  // Relative asset paths: the build is a static folder that can be served from anywhere.
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    // @wattsim/pki (through @wattsim/core) imports it at module level for certificate handling the game never uses.
    alias: { 'node:crypto': shim },
  },
  server: { port: 5174 },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2500 },
});
