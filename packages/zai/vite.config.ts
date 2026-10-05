import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { resolve, join, dirname } from 'node:path';
import { cpSync, createReadStream, existsSync, mkdirSync } from 'node:fs';

const projectRoot = process.cwd();
const apiOrigin = process.env.ZAI_API_ORIGIN || 'http://localhost:7715';

/**
 * pdf.js 的 worker / cMaps / standard_fonts 都是**运行时按需取**的文件,不能打进
 * bundle,也不适合塞进仓库(cMaps 约 170 个 .bcmap / 5 MB)。这里两边都兜住:
 *   - dev:`configureServer` 中间件直接从 node_modules 送出;
 *   - build:`writeBundle` 之后拷进 `dist/web/pdfjs/`,由 express.static 提供
 *     (.mjs 会被解析成 application/javascript,module worker 才能加载)。
 *
 * 为什么 worker 用「复制 + 固定 URL」而不是 `import worker from '…?url'`:
 * worker 是运行时按需取的文件,不需要经过打包器;固定路径少一份 Vite 资源副本,
 * 也避免 `?url` 资源模块混进 pdf.js 那个 chunk 里。
 * (真正会让 pdf.js 变"必加载"的是 pdf.mjs 自带的动态 import,见下面
 * neutralizePdfjsDynamicImport。)
 *
 * 少了 cMaps,中文/日文等**未内嵌字体**的 PDF 会整页丢字(不是排版差异,是内容
 * 缺失),所以这个目录不能省。
 */
function pdfjsAssetsPlugin(): Plugin {
  const dirMounts = [
    { url: '/pdfjs/cmaps/', dir: resolve(projectRoot, 'node_modules/pdfjs-dist/cmaps') },
    { url: '/pdfjs/standard_fonts/', dir: resolve(projectRoot, 'node_modules/pdfjs-dist/standard_fonts') },
  ];
  const fileMounts = [
    {
      url: '/pdfjs/pdf.worker.min.mjs',
      file: resolve(projectRoot, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
    },
  ];
  let outDir = resolve(projectRoot, 'dist/web');
  return {
    name: 'zai-pdfjs-assets',
    configResolved(config) {
      outDir = resolve(projectRoot, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const sendFile = (file: string) => {
          if (!existsSync(file)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader('Content-Type', 'application/octet-stream');
          createReadStream(file).pipe(res);
        };
        const direct = fileMounts.find((f) => f.url === url);
        if (direct) return sendFile(direct.file);
        const mount = dirMounts.find((m) => url.startsWith(m.url));
        if (!mount) return next();
        const rel = decodeURIComponent(url.slice(mount.url.length));
        // 目录穿越防护:只允许 mount 目录下的一层文件名。
        if (rel.includes('/') || rel.includes('..')) return next();
        sendFile(join(mount.dir, rel));
      });
    },
    writeBundle() {
      for (const { url, file } of fileMounts) {
        if (!existsSync(file)) continue;
        const dest = join(outDir, url.replace(/^\//, ''));
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(file, dest);
      }
      for (const { url, dir } of dirMounts) {
        if (!existsSync(dir)) continue;
        cpSync(dir, join(outDir, url.replace(/^\//, '')), { recursive: true });
      }
    },
  };
}


/**
 * pdf.js 的 `build/pdf.mjs` 里有一个**非字面量**动态 import(fake worker 回退路径):
 *
 *     const worker = await import(this.workerSrc)
 *
 * 源码里那行带着 webpack/vite 的双 ignore 注释,但 rolldown 仍然把它当成真实
 * 动态 import,于是 Vite 的 preload helper 被提升进「包含 pdf.js 的 chunk」;
 * 而 preload helper 又被入口自己用着(路由级 dynamic import)—— 结果入口变成
 * `import { __vitePreload } from './doc-pdf-….js'`,432 kB 的 pdf.js 连同
 * index.html 的 modulepreload 一起回到首屏,manualChunks 拆出来的懒加载作废。
 *
 * 换成 Function 构造的 import 表达式后,打包器看不到动态 import token,chunk 回到
 * "只有打开 PDF 才加载"。运行时语义不变(同样是 `import(workerSrc)`),只影响
 * fake worker 回退路径;正常路径用真 worker(workerSrc 指向 /pdfjs/pdf.worker.min.mjs)。
 * 代价:这条回退路径依赖 `new Function`,若部署方加了禁止 unsafe-eval 的 CSP 会失效
 * —— 那种情况下 PDF 预览本身也基本不可用,zai 目前不设 CSP。
 */
function neutralizePdfjsDynamicImport(): Plugin {
  const PATTERN =
    /await import\(\s*\/\*webpackIgnore: true\*\/\s*\/\*@vite-ignore\*\/\s*this\.workerSrc\s*\)/;
  return {
    name: 'zai-pdfjs-neutralize-dynamic-import',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/pdfjs-dist/') || !code.includes('this.workerSrc')) return null;
      const next = code.replace(PATTERN, 'await (Function("u", "return import(u)"))(this.workerSrc)');
      return next === code ? null : { code: next, map: null };
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    pdfjsAssetsPlugin(),
    neutralizePdfjsDynamicImport(),
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
          // Monaco editor — 仅当用户进入代码编辑时才加载。AA 的 monaco-code-view.tsx
          // 用 `import('monaco-editor')` 做代码分割,我们套同一模式。worker 走
          // `new URL(..., import.meta.url)` 由 Vite 自动 emit 为独立 chunk,无需新增
          // vite plugin。basic-languages / language / editor 各自独立,首屏不影响。
          if (id.includes('monaco-editor/esm/vs/basic-languages/')) return 'monaco-langs';
          if (id.includes('monaco-editor/esm/vs/language/')) return 'monaco-lang-workers';
          if (id.includes('monaco-editor/esm/vs/editor/')) return 'monaco-editor-core';
          if (id === 'monaco-editor' || id.includes('monaco-editor/esm/vs/editor/standalone') || id.includes('monaco-editor/esm/vs/editor/main')) return 'monaco-standalone';
          if (id.includes('react-markdown') || id.includes('remark') || id.includes('micromark')) return 'markdown';
          if (
            id.includes('react-syntax-highlighter') ||
            id.includes('prismjs') ||
            id.includes('refractor') ||
            id.includes('lowlight') ||
            id.includes('highlight.js')
          )
            return 'syntax-highlight';
          // Mermaid(2026-10-05 从 beautiful-mermaid 换成官方 mermaid.js 全量
          // 运行时 + dagre 布局)。它只在 ```mermaid 块首次出现时才 dynamic
          // import(MermaidBlock.tsx → mermaidRenderer.ts 的 `import("mermaid")`)。
          //
          // 这里 **返回 undefined 而不是给它一个 chunk 名** —— 让打包器按
          // dynamic import 边界自然切。给名字反而会出事,两种都实测过:
          //  1. 完全不写规则 → mermaid 自己切对了,但依赖链落进下面的
          //     `return 'vendor'`(静态 chunk)→ 首屏 +5MB。
          //  2. 写 `if (id.includes('/mermaid/')) return 'mermaid'` → rolldown
          //     把 Vite 的 **__vitePreload helper 一并塞进这个手写 chunk**;
          //     入口里每个 React.lazy() 都要 import 它,于是入口静态 import 了
          //     3.5MB 的 mermaid chunk,index.html 还给它加了
          //     <link rel="modulepreload">,懒加载彻底失效。
          // 两者都是本文件 pdfjs 那段注释记的同一类事故:**手写 chunk 边界会
          // 惊动 preload helper,拆了也白拆**。
          //
          // 所以策略是「**负向**认领」:只拦住这些包不去掉底部的
          // `return 'vendor'`(静态),return undefined 让它们跟着 mermaid 的
          // 动态边界走。改完请用这两条复核:
          //   - `grep -oE 'assets/[a-z-]+\.js' dist/web/index.html | grep -i mermaid`
          //     必须无输出(没有 preload = 懒加载生效);
          //   - `grep -c cytoscape dist/web/assets/vendor-*.js` 必须为 0。
          if (id.includes('/mermaid/') || id.includes('/@mermaid-js/')
            || id.includes('/d3-') || id.includes('/d3/') || id.includes('/internmap/')
            || id.includes('/delaunator/') || id.includes('/robust-predicates/')
            || id.includes('/cytoscape') || id.includes('/dagre') || id.includes('/elkjs/')
            || id.includes('/dagre-d3-es/') || id.includes('/layout-base/')
            || id.includes('/roughjs/') || id.includes('/khroma/') || id.includes('/marked/')
            || id.includes('/chevrotain/') || id.includes('/d3-sankey/')
            || id.includes('/@upsetjs/') || id.includes('/@braintree/')
            || id.includes('/es-toolkit/')) return undefined;
          // 文档预览(2026-09-21)。这几个库全部只在 DocumentPreview 里
          // dynamic import,必须各自拆 chunk —— 落到下面的 `return 'vendor'`
          // 会被并进**静态** vendor chunk,等于把 5 个库(含 echarts ~1MB)
          // 拉回首屏,懒加载白做。用 `/pkg/` 路径段匹配而不是裸 includes,
          // 避免误伤 lodash.debounce / lodash-es 这类同前缀包。
          // 注意:光拆出 chunk 还不够 —— pdf.js 还额外需要下面的
          // neutralizePdfjsDynamicImport(),否则入口会为 preload helper 静态
          // import 整个 doc-pdf chunk,拆了也白拆。
          if (id.includes('/docx-preview/') || id.includes('/jszip/')) return 'doc-docx';
          if (id.includes('/pptx-preview/') || id.includes('/echarts/') || id.includes('/zrender/')
            || id.includes('/lodash/') || id.includes('/uuid/')) return 'doc-pptx';
          if (id.includes('/pdfjs-dist/')) return 'doc-pdf';
          if (id.includes('/xlsx/')) return 'doc-sheet';
          if (id.includes('/dompurify/')) return 'doc-sanitize';
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
