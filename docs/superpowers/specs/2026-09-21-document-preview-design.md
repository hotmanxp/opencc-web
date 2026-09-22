# Office / PDF 文档预览设计

> **目标**:在 zai 的三处文件入口(分屏 FsTab、`/desktop` 资源管理器、对话内产出物)增加 Office 与 PDF 的**内联预览**能力,全部在浏览器内渲染,不引入任何原生依赖、不在服务端做格式转换。
> **范围**:`packages/zai/src/server/routes/fs.ts`、`routes/desktopFs.ts`、`shared/fileKind.ts` + 前端 `components/documentPreview/`(新增)、`FilePreviewBody.tsx`、`splitPane/FsTab.tsx`。
> **来源**:2026-09-21 探索(Explore agent 全量走查 + 人工复核关键行)+ 用户选定范围。

## 1. 背景与现状

### 1.1 三条入口,两条数据通道

| 入口 | 触发点 | 数据通道 | 渲染组件 |
|------|--------|----------|----------|
| 分屏 FsTab | `FsTab.tsx:618 openFile()` / 树点击 / 右键 | `GET /api/fs/file`(`useFsFile.ts:68`) | FsTab 内部 `FilePreview`(`FsTab.tsx:315-341`) |
| 对话产出物 | `MessageBubble.tsx:375`、`fileDisplay.tsx:121`、`DiffBlock.tsx:118`、`FilePathChip.tsx:66`、`openFilePath.ts:96` → 全部走 `useAgentStore.openFilePreview(abs)`(`useAgentStore.ts:1046`) | `FilePreviewDrawer.tsx:76` → `GET /api/fs/preview` | `FilePreviewBody` |
| `/desktop` 资源管理器 | `Desktop.tsx:482 openPreview(entry)` | `Desktop.tsx:414` → `GET /api/desktop/fs/file` | `FilePreviewBody` |

关键事实:**对话入口不需要新增任何东西** —— 上述 5 个聊天侧触发点已经全部收敛到 `openFilePreview(path)` → `/fs/preview` → `FilePreviewBody`。渲染层一通,这些入口自动获得能力。

### 1.2 当前能力边界

- `shared/fileKind.ts:46-52 classifyKind()` 只返回 `text | image | html | binary`,Office/PDF 全部落入 `binary`。
- `/fs/preview`(`fs.ts:1020-1085`)对 `binary` 只返回 `{kind, size, mtime, ext}`,**不含内容**;`PREVIEW_DEFAULT_MAX = 1_048_576`(`fs.ts:992`),且 `maxBytes` 被 clamp 到该值(`fs.ts:1028`)—— Office 文件根本装不下。
- `/desktop/fs/file`(`desktopFs.ts:95-120`)返回 base64 `dataUrl`,上限 5 MB,只认 TEXT/IMAGE/HTML。
- `/fs/file`(`fs.ts:394-489`)上限 2 MB,只认 TEXT/IMAGE/HTML/dotfile。
- 分屏侧更早就断了:`useFsFile.ts:26-37 preflightUnsupported()` 对 `binary` 直接返回"不支持的文件类型",**连网络请求都不发**。
- 前端无 i18n,中文文案内联;无 Office/PDF 相关依赖。

## 2. 设计要点

### 2.1 格式矩阵与 kind 扩展

`shared/fileKind.ts` 新增 4 个 kind + 1 个明确拒绝的 kind:

| 扩展名 | 新 kind | 渲染器 | 库 | 建议上限 |
|--------|---------|--------|-----|----------|
| `.docx` `.docm` | `docx` | DocxRenderer | docx-preview | 30 MB |
| `.xlsx` `.xlsm` `.xlsb` `.xls` `.ods` `.csv` | `sheet` | SheetRenderer | SheetJS | 30 MB |
| `.pptx` `.pptm` | `ppt` | PptRenderer | pptx-preview | 50 MB |
| `.pdf` | `pdf` | PdfRenderer | pdfjs-dist | 50 MB |
| `.doc` `.ppt` `.rtf` `.odt` `.odp` | `legacy-office` | UnsupportedNotice | — | — |

`FilePreviewKind`(`shared/fileKind.ts:7`)扩为 `'text' | 'image' | 'html' | 'binary' | 'docx' | 'sheet' | 'ppt' | 'pdf' | 'legacy-office'`。`legacy-office` 是**故意显式**的:它让前端能给出"疑似旧版二进制格式,请转存为 OOXML 或用系统应用打开",而不是笼统的"不支持"。

`.csv` 目前不在 `TEXT_EXTS`(`fileKind.ts:9-19`)里,现状是 `binary` → "不支持";归入 `sheet` 是净增能力。CSV 大文件在渲染层做行数截断(见 2.4)。

### 2.2 数据通道:新增 `GET /api/fs/raw`

**决策:新增独立字节端点,不改现有 `/fs/preview` 与 `/desktop/fs/file`。**

理由(三条,均有代码依据):
1. `/fs/preview` 的 `maxBytes` 被 `clampInt(..., 1024, PREVIEW_DEFAULT_MAX, ...)`(`fs.ts:1028`)钳在 1 MiB,放宽它会同时改变 image/html/text 的既有行为,回归面不可控。
2. 它的响应是 JSON + base64(`shared/fs.ts:143-150` `FilePreviewPayload.content`),Office 文件走 base64 有 33% 膨胀 + 主线程字符串解码成本;而 JSZip / PDF.js 都直接吃 `ArrayBuffer`。
3. `/desktop/fs/file` 的 `dataUrl` 语义是"图片/HTML 内联数据",不适合承载几十 MB 的文档字节。

端点规格:

```
GET /api/fs/raw?path=<absPath>&maxBytes=<n>
  → 200 application/octet-stream,头携带 X-File-Size / X-File-Mtime
  → 415 {error:{code:'EUNSUPPORTED'}}  扩展名不在白名单
  → 415 {error:{code:'EENCRYPTED_OR_LEGACY', container:'ole'}}  容器嗅探命中 OLE
  → 413 {error:{code:'ETOOBIG', meta:{size}}}  超过上限
  → 400/404/403  同 /fs/preview 的 EBADREQ/ENOENT/EACCES 语义
```

实现要求:
- **扩展名白名单**:`classifyKind(abs) ∈ {docx, sheet, ppt, pdf}` 才放行,否则 415。这条同时使 `/fs/raw` 不会退化成"任意文件下载口"。
- **`maxBytes` 硬上限** `RAW_MAX_BYTES = 64 * 1024 * 1024`,服务端常量,不随请求放宽。
- **容器嗅探**:流式下发前读前 8 字节判型 —— `%PDF-` → pdf;`PK\x03\x04` → ZIP(OOXML 合法容器);`\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1` → OLE。命中 OLE 直接 415 `EENCRYPTED_OR_LEGACY`。**这一步是必需的**:加密的 `.docx/.xlsx`(Agile encryption)和旧版 `.doc/.xls/.ppt` 都是 OLE 容器,不前置拦截就会让用户先下几十 MB 再报错。
- **路径校验**:复用 `normalizePath` 的 NUL 校验与 `resolve` 语义(`desktopFs.ts:38-42` 是现成范式)。权限模型与 `/fs/preview` 一致(zai 仅监听 localhost,等同本机 `cat`),在注释里写明。
- 用 `createReadStream` 管道下发,不 `readFile` 全量进内存。

`/desktop` 侧不新增端点,也不扩 `/desktop/fs/file`:桌面预览对 Office/PDF **跳过该 fetch**(它要求 `dataUrl` 且被 `toMime` 白名单 400 拦住,`desktopFs.ts:104`),直接构造 `{ kind, path }` payload,字节统一由 `DocumentPreview` 内部走 `/api/fs/raw`。

### 2.3 前端渲染层:`components/documentPreview/`

新增一个共享目录,**只实现一次**分发逻辑:

| 文件 | 职责 |
|------|------|
| `index.tsx` | `DocumentPreview({ path, kind })`:fetch `/api/fs/raw` → `ArrayBuffer` → 按 kind 动态 import 渲染器;自带 loading / 错误 / 重试;`useEffect` cleanup 用 `AbortController` 取消在途请求 |
| `DocxRenderer.tsx` | `docx-preview` 的 `renderAsync(buf, containerRef.current, null, { inWrapper: true, breakPages: true })`;docx-preview 自己写 DOM 到容器,故用 ref + `useEffect` |
| `SheetRenderer.tsx` | SheetJS `read(buf, { type: 'array' })` → AntD `Tabs` 切 sheet → 表格 |
| `PptRenderer.tsx` | `pptx-preview` 的 `init(container, {...})` + `preview(buf)` |
| `PdfRenderer.tsx` | `pdfjs-dist`,**文档流 + fit-width + 虚拟化**(2026-09-21 改版,见 2.4) |
| `UnsupportedNotice.tsx` | `legacy-office` 与 415 的落地态:说明文案 + "打开目录"按钮(复用 `FilePreviewBody.tsx:198-207` 的 `/api/fs/reveal` "打开目录"范式) |

懒加载沿用仓库既有模式(模块级 promise cache + 动态 `import()`,见 `FsTab.tsx:31-38` 与 `FilePreviewBody.tsx:92-98`),**不用 `React.lazy`**。

PdfRenderer 的 worker 交给 Vite 处理:

```ts
import * as pdfjs from 'pdfjs-dist'
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
```

`getDocument({ data })` 拿到的 task 在组件卸载时必须 `destroy()`。

### 2.4 大文件与保真度取舍(必须在 UI 上可见)

| 场景 | 处理 |
|------|------|
| SheetJS 大表 | 单 sheet 渲染上限 2000 行 × 100 列,超出显示"仅显示前 N 行/列"提示 |
| CSV | 同上,另加 30 MB 字节上限 |
| PDF | **文档流 + 虚拟化**:所有页顺序排开,但只有视口上下有限屏距内的页真正画进 canvas,离屏页把位图归零(`canvas.width/height = 0`)释放。释放的只是位图,页槽一直占位,所以总高稳定、滚动条不跳。窗口 = 上方 1.5 屏 / 下方 2.5 屏(阅读是向下推进的),实测 ≈ 4~5 页位图 ≈ 40 MB 封顶,与文档页数无关 |
| PPTX | 保真度最差(图表/SmartArt/母版细节/动画/音视频/嵌入对象基本丢失),UI 上以弱提示说明"部分元素可能不显示" |
| XLSX | 不重绘图表、不还原单元格样式细节、不做公式求值(显示缓存值) |

#### 2.4.1 PDF:为什么改成文档流(2026-09-21 改版)

首版是单页翻页,理由写的是"连续滚动要把整篇预渲染,几十 MB 的文档直接爆内存"。这个理由只对了一半:**预渲染全篇**确实会爆内存(单页 A4 @dpr2 位图 ≈ 8 MB,百页 ≈ 800 MB),但连续滚动不必预渲染全篇。虚拟化之后内存与页数无关,翻页模式反而带来两个真实代价:

1. **窄分屏里读长文要不停点按钮** —— 而分屏正是 PDF 预览的主场景;
2. **`scale: 1` 写死,没有 fit-width** —— 窄窗横向溢出、宽窗纸张过小,这是比"翻页 vs 文档流"更影响观感的短板。

改版后 `PdfRenderer` 的三条不变量(实现见文件头注释):

| 机制 | 做法 |
|------|------|
| fit-width | `scale = (容器 clientWidth − 两侧留白) / 首页宽度`,夹在 `[0.1, 2]`;容器宽度靠 `ResizeObserver` 跟随(桌面浮窗可拖拽改尺寸),量不到时(测试环境 / 布局尚未完成的 0)退回 `scale = 1` |
| 虚拟化 | 渲染区间由 `scrollTop + clientHeight` 与页槽布局推出,滚动回调 rAF 合帧后才 setState;区间没变不触发重渲染 |
| 页槽尺寸 | 所有页先按**首页**尺寸排版(`getViewport` 是纯几何、不栅格化;逐个 `getPage` 在几百页文档上要串一串 promise),某页渲染时把实测尺寸回填,混排横竖页的文档滚过之后才对齐 |
| 翻页按钮 | 保留,语义从"换页"变成"跳到某页"(`scrollTo` + 页码指示跟随滚动位置) |

生命周期仍是硬约束:`RenderTask.cancel()`(同一 canvas 并发 render 会让 pdf.js 抛异常,滚出区间 / 改缩放都会打断在途渲染)与 `LoadingTask.destroy()`(卸载时释放 worker 里的文档)一个都不能漏。

### 2.5 接线:三处改动

1. **`FilePreviewBody.tsx`**(共用渲染组件,`/desktop` 与对话抽屉都走它)
   - `switch(payload.kind)`(`:214-228`)新增 `docx | sheet | ppt | pdf | legacy-office` 五个 case → `<DocumentPreview path={payload.path} kind={payload.kind} />`
   - 同步扩它**本地的** `FilePreviewKind`(`:21`)与 `FilePreviewPayload`(`:24`)—— 该文件有意自带一份类型副本,不要只改 shared 导致类型不匹配
2. **分屏 FsTab**
   - `useFsFile.ts:26-37 preflightUnsupported()`:不能再把 `docx/sheet/ppt/pdf` 当 `binary` 拦截,否则请求根本发不出去(改为只拦真正的 `binary` + `legacy-office`)
   - `FsTab.tsx:315-341` 的预览分支:新增同样的 case **或**直接把这一段收敛为复用 `FilePreviewBody`
   - **建议收敛**:现在存在两套并行预览实现(FsTab 内部 `FilePreview` vs `FilePreviewBody`),本次新增 5 种渲染分支会把这个分裂放大成两处维护。收敛到 `FilePreviewBody` 收益明显;若评估后 tab 语义差异过大,退而求其次只加 case,并在 spec 里记为 follow-up。
3. **`/desktop`**(两处改动,均在服务端与页面各自一处)
   - `desktopFs.ts:85` 的 `preview: toMime(d.name) !== undefined` 决定双击走内联预览还是 `systemOpen`(`Desktop.tsx:482-494`)。Office/PDF 必须让该标志为 `true`,否则双击直接弹系统应用。
   - `desktopFs.ts:18-35` 是三份重复 ext 表之一(`shared/fileKind.ts:1-5` 的注释记录 compat 层那份重复是**有意的**,desktopFs 这份没有该约束)。**建议直接 `import { classifyKind }` 收编**,`preview: PREVIEWABLE_KINDS.has(classifyKind(d.name))`;若不想动列表逻辑,则保守同步表 + 扩 `toMime`,并在既有 sync guard 测试里补断言。
   - `Desktop.tsx:414-458` 的 payload 构造:新增分支 —— 先 `classifyKind(preview.path)`,`docx/sheet/ppt/pdf/legacy-office` 直接 `setPreviewData({ kind, path })` 并**跳过 `/desktop/fs/file` 请求**(该请求在 `:415` 有 `!r.dataUrl` 即报错的前置判断,且 Office 会被 `toMime` 400,不跳过就会先弹"读取失败")。

### 2.6 安全

- **docx 渲染产物必须 sanitize**。docx-preview 会把 OOXML 里的关系直接转成 HTML(含 `script`/`on*`/外部 `img[src^=http]`)。硬性要求:渲染后经 DOMPurify 清洗,并剥离远程图片引用(离线渲染,不发出站请求)。
- PDF 走 pdfjs canvas 渲染,不产生可执行 DOM;文本层可选(首版不做选择文本)。
- 不自动打开文档内超链接(`pptx`/`docx` 的外部关系一律不跳转)。
- `/fs/raw` 的白名单 + 硬上限 + NUL 校验必须落在**路由实现里**,不能只靠前端判断(前端 preflight 是体验优化,不是约束)。
- 加密文档不解密,明确报错。

### 2.7 依赖

| 包 | 用途 | 备注 |
|----|------|------|
| `docx-preview` | docx/docm | 传递依赖 `jszip` |
| `xlsx`(SheetJS) | xlsx/xlsm/xlsb/xls/ods/csv | ⚠️ **npm 上的 `xlsx` 停留在 0.18.5,官方新版只发布在 cdn.sheetjs.com**。公司代理已知拦截 jsdelivr/unpkg/npmmirror,cdn.sheetjs.com 能否访问**需在实现时先验证**。备选:接受 0.18.5,或换 `exceljs`(代价:不支持 `.xls/.xlsb/.ods`,体积更大) |
| `pptx-preview` | pptx/pptm | 首选(无 jQuery);`pptxjs` 依赖 jQuery,**不采用** |
| `pdfjs-dist` | pdf | 对齐 DSH 已验证版本 `6.3.289`(见 `deepseek-harness/packages/client/ui-sidebar-documentpreview/package.json`) |
| `dompurify` | HTML 清洗 | 2.6 的硬性依赖 |

依赖归属:npm section 的现有先例不一致(React 在 `devDependencies`,`@codemirror/*` 在 `dependencies`)。前端库一律经 `build:web` 打进 `dist/web`,**建议跟随 `@codemirror/*` 放 `dependencies`**,并在 PR 中确认 `files` 字段与发布产物不受影响。

全部渲染器**懒加载**,不进主 bundle;首屏体积零增长。

## 3. 关键决策 + 取舍

| 决策 | 取舍 |
|------|------|
| 纯浏览器渲染,不做服务端转换 | **放弃** `.doc/.xls/.ppt` 二进制格式与高保真排版;换来零原生依赖、零安装体积(对比 `libreoffice-kit` 单个引擎 300 MB+)、零进程管理 |
| 新增 `/fs/raw` 而非扩 `/fs/preview` | 多一个端点;换来对既有 image/html/text 行为零回归 |
| 流式字节而非 base64 JSON | 前端要自己管 `ArrayBuffer` 生命周期;换来大文件不膨胀、不解码卡主线程 |
| OLE 容器前置嗅探 | 服务端多读 8 字节;换来"旧版/加密文档"秒级明确报错,而不是白下几十 MB |
| pptx 用 pptx-preview | 保真度明显低于原生引擎,需在 UI 上明示;若实测不可接受,降级方案是"只显示文本大纲 + 系统应用打开" |
| 引入 5 个前端库 | 需要接受依赖增长与 DOMPurify 清洗步骤;换来能力覆盖 |

## 4. 范围边界(明确不做)

- 不做文档**编辑**、导出、格式转换
- 不引入 LibreOffice / `libreoffice-kit` / 任何服务端转换引擎
- 不做缺字体诊断与字体替换提示(浏览器依赖系统字体,渲染结果随机器变化 —— 这是本路线**固有**的取舍,不是缺陷)
- 不解密受密码保护的文档
- 不做 pptx 动画/切换/音视频播放
- 不做 xlsx 公式求值、图表重绘
- 不做 PDF 文本选择与复制(2026-09-21 起**已做**连续滚动 + fit-width,见 2.4.1;文本层仍是 follow-up)
- 不修改 `/fs/preview`、`/fs/file`、`/desktop/fs/file` 的既有响应语义
- 不改动 `packages/zn-agent-core/`(本轮全部改动在 `packages/zai/`)

## 5. 文件清单

**服务端**
- `packages/zai/src/shared/fileKind.ts` — 新增 ext 表与 5 个 kind 分支
- `packages/zai/src/server/routes/fs.ts` — 新增 `GET /fs/raw`(含嗅探、上限、错误码)
- `packages/zai/src/server/routes/desktopFs.ts` — 收编 `classifyKind` + 扩 `preview` 标志
- `packages/zai/src/shared/fs.ts` — `FilePreviewError.code` 追加 `EUNSUPPORTED | EENCRYPTED_OR_LEGACY`

**前端(新增)**
- `packages/zai/src/web/src/components/documentPreview/index.tsx`
- `.../documentPreview/DocxRenderer.tsx` / `SheetRenderer.tsx` / `PptRenderer.tsx` / `PdfRenderer.tsx` / `UnsupportedNotice.tsx`
- 对应 `*.test.tsx`

**前端(修改)**
- `packages/zai/src/web/src/components/desktop/FilePreviewBody.tsx` — switch + 本地类型
- `packages/zai/src/web/src/components/splitPane/useFsFile.ts` — preflight 放行
- `packages/zai/src/web/src/components/splitPane/FsTab.tsx` — 预览分支(或收敛为复用 `FilePreviewBody`)
- `packages/zai/src/web/src/pages/Desktop.tsx` — `:414-458` payload 构造新增文档分支并跳过 `/desktop/fs/file`
- `packages/zai/package.json` — 依赖

**测试(修改)**
- `packages/zai/test/shared/fileKind.test.ts` — 既有 ext 表 sync guard,补新扩展名断言
- `packages/zai/test/web/components/documentPreview/PdfRenderer.test.tsx` — **新增**(2026-09-21):虚拟化窗口、离屏位图归零、fit-width 与缩放夹取、页槽尺寸回填、cancel/destroy
- `packages/zai/test/web/components/documentPreview/index.test.tsx` — pdf 断言改 `waitFor`(页码要等解析完),并补 canvas `getContext` 桩(happy-dom 恒为 null)

## 6. 验收标准

- [ ] 对话里 agent 产出的 `.docx` / `.xlsx` / `.pptx` / `.pdf`,点 `[预览]` 或 Read 行的 ↗ 图标,在预览抽屉内正确渲染,不出现"此文件类型不支持内联预览"
- [ ] 分屏 FsTab 打开同四种文件,不再显示"不支持的文件类型",内容正确渲染
- [ ] `/desktop` 资源管理器双击同四种文件,弹**应用内预览浮窗**(不触发系统应用)
- [ ] PDF 是文档流:滚轮一路往下读,不点按钮;窄分屏里纸张贴合容器宽度不横向溢出;长文档滚到底再滚回,中间页仍正常显示(说明离屏释放后能重渲染)
- [ ] PDF 内存有界:在几百页的文档里从头滚到尾,任务管理器里渲染进程内存不随页数线性增长(离屏页位图已释放)
- [ ] `.doc` / `.ppt` / 加密 `.docx` 给出明确文案(旧版二进制 / 疑似加密),并保留"打开目录"按钮
- [ ] 超过对应上限的文件返回 413 并提示上限值
- [ ] 渲染期间切换文件 / 关闭抽屉,在途请求被取消(`AbortController`),控制台无卸载后 setState 警告
- [ ] docx 内的 `script` / `on*` 属性 / 远程图片引用被清洗,不产生站外请求(用带恶意关系的 docx fixture 验证)
- [ ] 5 个渲染器 chunk 均未进入主 bundle(构建产物核对)
- [ ] 相关单测全绿:`pnpm --filter @zn-ai/zai test test/shared/fileKind.test.ts test/server/routes/fs-raw.test.ts` + `components/documentPreview/*.test.tsx`
- [ ] 真实浏览器走查四种格式(需先征得同意,用 `/ego-browser` 起独立端口)

## 7. 待确认 / follow-up

1. **SheetJS 来源**:`xlsx@0.18.5`(npm)还是 cdn.sheetjs.com —— **实现第一步就验证**,阻塞表格渲染器选型。
2. **pptx 库终选**:`pptx-preview` 与备选的实测保真度对比;若都不可接受,降级为"文本大纲 + 系统应用打开"。
3. **FsTab 预览是否收敛到 `FilePreviewBody`**:消除两套预览实现的重复;本次若不做,记为 follow-up。
4. **PDF 文本层**:不做文本选择/复制;视使用反馈再定。连续滚动 + fit-width 已于 2026-09-21 落地(2.4.1)。
5. **PDF 缩放级别**:目前只有 fit-width,没有手动缩放 / 适应页面 / 实际大小;加了就要处理"缩放手势 vs 滚动"的冲突,先不做。
6. **CSV 表格视图 vs 文本视图**:本次按表格渲染;若用户更常看原始文本,考虑给 CSV 加一个视图切换。