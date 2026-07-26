import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { resolve } from 'node:path';

const projectRoot = process.cwd();
const apiOrigin = process.env.ZAI_API_ORIGIN || 'http://localhost:7715';

export default defineConfig({
  plugins: [
    react(),
    ...(process.env.ANALYZE
      ? [visualizer({ gzipSize: true, open: false, filename: 'dist/stats.html' })]
      : []),
  ],
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
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@codemirror')) return 'codemirror';
          if (id.includes('react-markdown') || id.includes('remark') || id.includes('micromark')) return 'markdown';
          if (
            id.includes('react-syntax-highlighter') ||
            id.includes('prismjs') ||
            id.includes('refractor') ||
            id.includes('lowlight') ||
            id.includes('highlight.js')
          )
            return 'syntax-highlight';
          if (id.includes('@ant-design/icons')) return 'ant-icons';
          if (id.includes('antd') || id.includes('@ant-design/cssinjs') || id.includes('rc-'))
            return 'antd';
          if (id.includes('react-router') || id.includes('history')) return 'router';
          if (id.includes('zustand')) return 'store';
          if (id.includes('@zn-ai/zai-agent-core')) return 'agent-core';
          if (id.includes('react') || id.includes('scheduler')) return 'react';
          return 'vendor';
        },
      },
    },
  },
});
