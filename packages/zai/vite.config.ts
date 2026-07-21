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
    host: '127.0.0.1',
    port: Number.parseInt(process.env.VITE_PORT || '5173', 10),
    proxy: {
      '/api': {
        // Resolve `localhost` to an explicit IPv4 host so the proxy always
        // dials the same address family as the API server (which listens on
        // 127.0.0.1 only). Without this, vite may resolve `localhost` to
        // `::1` and the proxy silently hangs (Vite 8 default IPv6 dual-stack).
        target: apiOrigin.replace(/^localhost/, '127.0.0.1'),
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
