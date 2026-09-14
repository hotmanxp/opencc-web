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
      // bun: protocol shims — alias to dist/ (not src/) so production
      // builds work even when @zn-ai/zn-agent-core is consumed from npm
      // (where only dist/ is published). Task 12 Step 1b's
      // copy-runtime-assets.mjs is responsible for shipping the shims in dist/.
      'bun:bundle': resolve(projectRoot, 'node_modules/@zn-ai/zn-agent-core/dist/compat/runtime/bun-shim.ts'),
      'bun:feature': resolve(projectRoot, 'node_modules/@zn-ai/zn-agent-core/dist/compat/runtime/bun-feature-shim.ts'),
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
      external: [
        'bun:bundle',
        'bun:feature',
        // Match opencc-src by both relative path (if Vite sees the source string)
        // and absolute path (if Vite resolves through the bridge's constructed
        // import path). The regex matches anywhere in the path.
        /opencc-src\//,
      ],
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
          // Mermaid 双 renderer 各自拆 chunk,只在 ```mermaid 块首次出现时
          // 才 dynamic import(MermaidBlock.tsx → mermaidRenderer.ts)。mermaidjs ~600KB
          // 必须独立 chunk,beautiful-mermaid ~30KB 单独便于 Vite 单独 cache。
          // mermaidjs 依赖 d3 / dagre / elkjs,这些跟 mermaid 走同一 chunk。
          // sanitize 走自写正则,不再单独拆 chunk。
          if (
            id.includes('node_modules/mermaid') ||
            id.includes('@mermaid-js') ||
            (id.includes('node_modules/d3-') && !id.includes('node_modules/d3-array')) ||
            id.includes('node_modules/dagre') ||
            id.includes('node_modules/elkjs')
          )
            return 'mermaid';
          if (id.includes('beautiful-mermaid')) return 'mermaid-beautiful';
          if (id.includes('@ant-design/icons')) return 'ant-icons';
          if (id.includes('antd') || id.includes('@ant-design/cssinjs') || id.includes('rc-'))
            return 'antd';
          if (id.includes('react-router') || id.includes('history')) return 'router';
          if (id.includes('zustand')) return 'store';
          if (id.includes('@zn-ai/zn-agent-core')) return 'agent-core';
          if (id.includes('react') || id.includes('scheduler')) return 'react';
          return 'vendor';
        },
      },
    },
  },
});
