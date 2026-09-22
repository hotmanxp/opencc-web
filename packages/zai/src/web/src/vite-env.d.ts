/// <reference types="vite/client" />
//
// 前端没有独立的 tsconfig(顶层 tsconfig.json 的 include 排除了 src/web),
// 所以这份 d.ts 不参与 `tsc -b` 的类型检查,它的作用是在单独给 web 目录跑
// 类型检查时,让 `import xxx from '.*?url'`(pdf.js worker 的资源 URL 导入,
// 见 documentPreview/PdfRenderer.tsx)与 import.meta.env 有类型可用。