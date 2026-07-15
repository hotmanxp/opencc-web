import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const projectRoot = process.cwd();

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(projectRoot, 'src', 'shared'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.ZAI_API_ORIGIN ?? 'http://localhost:7715',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
