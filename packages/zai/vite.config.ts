import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const projectRoot = process.cwd();
const apiOrigin = process.env.ZAI_API_ORIGIN || 'http://localhost:7715';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(projectRoot, 'src', 'shared'),
    },
  },
  server: {
    port: Number.parseInt(process.env.VITE_PORT || '5173', 10),
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
