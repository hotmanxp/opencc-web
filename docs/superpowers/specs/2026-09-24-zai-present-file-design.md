# PresentFile 内置工具设计 — 在对话流中直接展示单个文件

日期:2026-09-24
状态:设计定稿(待实施)
前置:[`2026-08-20-display-files-tool-design.md`](./2026-08-20-display-files-tool-design.md)
(本设计取代它:`DisplayFiles` 多文件 → `PresentFile` 单文件,元数据卡 → 内容内联卡)

## 1. 背景与目标

现役 `DisplayFiles` 工具只渲染**元数据卡片**(文件名 / 大小 / mtime + `[预览]` `[打开目录]`
两个按钮),用户要点一次按钮、等右侧抽屉弹出,才能看到内容。这与工具意图 ——
「Agent 直接把产物摊到用户面前」—— 隔了一层。三个具体问题:

1. **内容没进对话流**。图片、HTML、文本都要额外一跳才看得见,汇报类场景(AI 生成一张图、
   一份 HTML 报告、一个 Markdown 文档)在 transcript 里完全不可读。
2. **会掉进工具组卡**。`fileDisplayRenderer.skipOuterGroup = true` 只在「该 toolGroup 内
   每个条目都带此标记」时生效(`MessageListView.tsx:30-39`)。模型一轮里「先 Read 再
   DisplayFiles」时两条同属一个 toolGroup → 整组折叠成「2 个工具调用」,文件卡直接消失。
3. **文档类被误判**。core 侧 `classifyKind` 只认 text/image/html/binary
   (`displayFilesOpencc.ts:64-70`),`.pdf` / `.docx` 一律落到 `binary` → 卡片显示
   「二进制,无法内联预览」且预览按钮 disabled。而 `/api/fs/preview` 与
   `documentPreview/` 自 2026-09-21 起已能渲染 pdf/docx/xlsx/pptx。

**目标**:把工具收敛为「一次展示一个文件」的 `PresentFile`,在对话流内**直接渲染内容**
(图片 / HTML / 文本 / Markdown / 代码),卡片右上角 ↗ 按钮复用现有预览链路打开大尺寸预览,
且该卡片**永不进入工具折叠组卡**。

## 2. 范围与约束

**做**
- 工具改名 `PresentFile` + 单文件参数 `{ path, caption? }`。
- 卡片内联渲染内容(图片 / HTML / 文本代码 / Markdown);文档类只给类型说明 + ↗。
- 从混合 toolGroup 中把 `PresentFile` 条目**分段摘出**内联渲染。
- 服务端 `GET /api/fs/raw` 扩展支持图片(原始字节流,10 MiB 上限)。
- 大预览抽屉的图片分支改用同一字节通道(顺带让抽屉能看 > 1 MiB 的图)。

**不做(YAGNI)**
- **不保留旧工具名 `DisplayFiles` 的 registry 别名**(2026-09-24 执行期裁决:不留向后兼容 shim)。
  代价是已落盘的历史 transcript 里旧名消息退化为通用工具块 —— 接受。
- 不做内容快照(不把图片 base64 / 文本全文塞进 `tool_result`)。文件在展示后被修改,历史卡片
  会显示新内容 —— 这是懒加载方案的已知代价,接受。
- 不加「文件已变更」提示(size+mtime 指纹),无需求。
- 不做卡内全屏切换 / 卡内缩放,大尺寸一律交给 ↗ 打开的预览。
- 一次调用仍只展示**一个**文件(`paths: string[]` 移除)。

**约束**
- 工具描述与 `inputSchema.describe()` 一律用**英文**(AGENTS.md「系统提示词一律用英文」)。
  现役 `TOOL_DESCRIPTION` 是中文,属既有违规,本次一并修正。
- 内联内容**不落在 SSE / transcript 里**,只落元数据(每条约 120 字节)。
- 不限制 cwd(沿用前置设计:展示 cwd 之外的文件是合法场景)。

## 3. 架构总图

```
LLM 调 PresentFile(path, caption?)
   ↓ vendor Tool 协议
presentFileOpencc.ts (zn-agent-core)
   ├─ stat(path) → FileMeta{path,name,size,mtime,kind,error?}   kind 与 shared/fileKind.ts 对齐
   └─ call 返回 { data: { output: JSON({ content:[{type:'json', json:{ file, caption }}] }) } }
   ↓
mapToolResultToToolResultBlockParam
   ├─ 回灌 LLM 的 content = 'done'            (省上下文,不变)
   └─ wrapper JSON 按 toolUseId 存入内存 map   (takePresentFileOutput 取出即删)
   ↓ SSE runtime.tool_result (routes/agent.ts:615-627 替换 output)
前端 useAgentStore.messages
   ↓
MessageListView (collapsed 分支)
   └─ splitToolGroupEntries() → inline 段(MessageBubble) / card 段(ToolGroupCard)
        └─ MessageBubble → ToolCallBlock → renderer.renderFull(msg)  ← 整块接管
             └─ PresentFileCard
                  ├─ 头部:kind 图标 + 文件名 + [↗] [📂]
                  ├─ 元数据行:size · mtime · path
                  ├─ caption(有则显示)
                  └─ 内联区:按 kind 走 FilePreviewBody(variant='inline')
                       ├─ image     → <img src="/api/fs/raw?path=…">       (≤ 10 MiB)
                       ├─ html      → <iframe sandbox="allow-scripts">     (≤ 1 MiB)
                       ├─ text/md   → 前 20 行 + [展开全部]                 (≤ 1 MiB)
                       ├─ docx/sheet/ppt/pdf/legacy-office → 不内联,只 ↗
                       └─ binary / error → 一行说明
                  └─ [↗] → openFilePathPreview(path) → 分屏 / 桌面浮窗 / FilePreviewDrawer
```

## 4. 工具层(`packages/zn-agent-core/src/opencc-src/server/`)

### 4.1 文件改名与定义

`displayFilesOpencc.ts` → **`presentFileOpencc.ts`**(内容整体重写,保留 stat/错误归一化)。导出:

```ts
export const presentFileOpenccTool = buildTool({
  name: 'PresentFile',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  get inputSchema() { return inputSchema },
  maxResultSizeChars: 20_000,
  async call({ path, caption }) {
    const file = await statOneFile(path)
    const output = JSON.stringify({
      content: [{ type: 'json' as const, json: { file, caption } }],
    })
    return { data: { output } }
  },
  // …renderToolUseMessage / renderToolResultMessage 同现状(返回 null)
  // mapToolResultToToolResultBlockParam:暂存 wrapper,回灌 'done'(见 §4.3)
  // toAutoClassifierInput / checkPermissions / userFacingName 同现状
})
```

```ts
const inputSchema = z.object({
  path: z.string().min(1).describe('Absolute path of the local file to present.'),
  caption: z
    .string()
    .max(200)
    .optional()
    .describe('Optional one-line note shown above the preview (e.g. what this file is).'),
})

const TOOL_DESCRIPTION =
  'Present one local file directly to the user in this conversation, rendered inline: ' +
  'images, HTML pages, text/code/Markdown and documents are shown as a card with an inline ' +
  'preview and an "open large preview" button. Use it to hand over an artifact (a generated ' +
  'report, chart, image, exported file) instead of only writing its path. Images larger than ' +
  '10 MiB, text/HTML larger than 1 MiB and unsupported binaries show metadata only.'
```

**变更点**(相对现役实现):

| 项 | 现状 | 现设计 |
|---|---|---|
| 名字 | `DisplayFiles` | `PresentFile` |
| 参数 | `paths: string[1..20]` | `path: string` + `caption?: string` |
| 输出 | `{ content:[{ json:{ files:[…] } }] }` | `{ content:[{ json:{ file, caption } }] }` |
| kind 分类 | text/image/html/binary | 与 `shared/fileKind.ts` 完全对齐(含 docx/sheet/ppt/pdf/legacy-office) |
| 语言 | 中文描述 | 英文描述 + 英文 schema describe |

### 4.2 kind 分类对齐

`presentFileOpencc.ts` 内的 `classifyKind` 扩展为与 `packages/zai/src/shared/fileKind.ts:118-129`
同一套规则(该文件是浏览器安全的纯字符串实现,zn-agent-core 因 bundle 单向依赖不能 import 它,
仍按前置设计的「两份字面量 + 关键扩展名双向断言」保持同步):

`.docx/.docm → docx`、`.xlsx/.xlsm/.xlsb/.xls/.ods/.csv → sheet`、`.pptx/.pptm → ppt`、
`.pdf → pdf`、`.doc/.ppt/.rtf/.odt/.odp → legacy-office`,其余规则不变。

> 注意 `.csv` 归 `sheet`:内联区不渲染文档类,但 ↗ 打开的抽屉会用 SheetJS 渲染它 —— 与
> `/api/fs/preview` 的现有分类一致,不吃「文本卡」分支。

### 4.3 前端展示通道(保留现有机制,改名)

LLM 侧继续拿 `'done'`(省上下文);前端要的元数据走模块内 map:

```ts
const presentFileOutputsByToolUse = new Map<string, string>()
export function takePresentFileOutput(toolUseId: string): string | undefined  // 取出即删
```

同步改:
- `packages/zn-agent-core/src/bundle-entry.ts:51-54`(导出改名)
- `packages/zai/src/server/routes/agent.ts:42`(import)、`:615-627`(`toolName === 'PresentFile'`)

### 4.4 注册

`packages/zn-agent-core/src/opencc-src/server/mainAgents.ts`:
- `:36` import 改为 `presentFileOpenccTool`
- `:87-101` default agent 的 tools 槽改挂新工具(查重按 `presentFileOpenccTool.name`)
- `:110-113` weixin agent 的注释同步措辞(仍是「无 Web UI,不挂」;微信侧交付走 `SendFileToUser`)

office / agent-creator / task-factory / task-intake 槽不变。

## 5. 服务端:`GET /api/fs/raw` 支持图片

`packages/zai/src/server/routes/fs.ts:1166-1241`。

- 白名单:`if (!isDocumentKind(kind) && kind !== 'image') → 415`(其余不变 —— 白名单仍保证
  该路由不会退化成任意文件下载口)。
- 上限:图片用新增的 `IMAGE_MAX_BYTES = 10 * 1024 * 1024`,文档类仍走 `DOCUMENT_MAX_BYTES[kind]`。
- `Content-Type`:`kind === 'image' ? (mimeFromExt(abs) ?? 'application/octet-stream') : 'application/octet-stream'`。
- 其余不动:容器嗅探仅对文档类执行;`X-File-Size` / `X-File-Mtime` / `Cache-Control: no-store`
  保留;仍 `createReadStream` 流式(不 `readFile` 全量进内存)。

**常量落点**:`IMAGE_MAX_BYTES` 与 `INLINE_TEXT_LINES` 之外的展示阈值集中放
`packages/zai/src/shared/fileKind.ts`(与 `DOCUMENT_MAX_BYTES` 同样被前后端共用,避免漂移):

```ts
/** 图片内联 / 字节通道上限(前端内联 preflight 与 /api/fs/raw 共用)。 */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024
```

### 5.1 `GET /api/fs/preview` 图片超限改为「只回元数据」

`packages/zai/src/server/routes/fs.ts:1090-1102`。现役行为:图片 > 1 MiB → 413。改为沿用
**文档类已有先例**(`:1065-1079`)—— 超限时去掉 `content`,只回元数据:

```ts
if (kind === 'image') {
  const mime = mimeFromExt(abs) ?? 'application/octet-stream'
  if (info.size > maxBytes) {
    res.json({ kind, mime, size: info.size, mtime: info.mtimeMs } satisfies FilePreviewPayload)
    return
  }
  const buf = await readFile(abs)
  res.json({ kind, mime, content: buf.toString('base64'), size: info.size, mtime: info.mtimeMs })
  return
}
```

为什么:抽屉需要 size/mtime/mime 渲染标题,而图片字节已改走 `/api/fs/raw`(§8)。若继续 413,
抽屉就得为图片另找一条元数据来源 —— 这正是「本地判 kind」方案要付的重复成本,放弃。

text/html 分支 **不变**(> 上限仍 413,抽屉显示既有的错误 Alert);desktop 调用方仍能拿到
≤ 1 MiB 图片的 base64 `content`(`dataUrl` 回退路径),零回归。

## 6. 前端:PresentFileCard 内联渲染

### 6.1 文件与注册

- 新文件 `packages/zai/src/web/src/components/toolRenderers/presentFile.tsx`,
  导出 `presentFileRenderer`(取代 `fileDisplay.tsx` / `fileDisplayRenderer`)。
- `registry.ts:9,15`:只注册 `PresentFile: presentFileRenderer` —— **不保留**旧名 `DisplayFiles`
  别名(历史 transcript 里旧名消息走 `genericRenderer`,不再出文件卡)。

### 6.2 wire shape 归一化

```ts
type PresentedFile = {
  path: string; name: string; size: number; mtime: number
  kind: FilePreviewKind          // 与 shared/fileKind.ts 同一联合类型
  error?: { code: string; message: string }
  caption?: string
}
function parsePresented(msg): PresentedFile[]   // 新 shape → [file];旧 shape {files:[…]} → 每项一张卡
```

旧 shape(`content[0].json.files`)按数组渲染成多张新卡 —— 单份渲染代码,历史卡片也升级成新样式。

### 6.3 卡片结构

```
┌──────────────────────────────────────────────────────┐
│ [kind图标] report.html                      [↗] [📂] │
│ 12.4 KB · 2026-09-24 15:02 · /Users/x/report.html    │
│ 刚生成的季度报告                                       │  ← caption,可选
├──────────────────────────────────────────────────────┤
│ 内联渲染区                                             │
└──────────────────────────────────────────────────────┘
```

- 头部:kind 图标(lucide)+ 文件名(`Typography.Text strong`);右上角两个 `IconButton`
  (`aria-label` 齐全):**↗ = 大预览**,**📂 = 打开目录**。
- 元数据行:`size · mtime · path`(path 省略号截断 + `title` 全路径)。
- **卡内内容区不响应点击**(避免误触),大预览只有 ↗ 一个入口。
- 实现用 Tailwind utility class(AGENTS.md 样式规范);颜色一律走 CSS 变量。

### 6.4 内联区各 kind

| kind | 内联内容 | 前置条件 | 超限 / 失败降级 |
|---|---|---|---|
| `image` | `<img src="/api/fs/raw?path=…">`,居中 `object-contain`,`max-h-[320px] md:max-h-[420px]` | `size ≤ IMAGE_MAX_BYTES` 且无 error | 元数据行 + 一行提示;↗ disabled |
| `html` | `<iframe sandbox="allow-scripts">`,`h-[320px] md:h-[420px]`,内容走 `/api/fs/preview` 的 `content` → `srcDoc` | `size ≤ 1 MiB` | 元数据行 + 提示;↗ 可用 |
| `text` | `.md/.markdown` → `MarkdownText`;其余 → 语法高亮代码块。前 **20 行** + `[展开全部(N 行)]`(卡内展开,容器 `max-h` + 内部滚动) | `size ≤ 1 MiB` | 元数据行 + 提示;↗ 可用 |
| `docx`/`sheet`/`ppt`/`pdf` | **不内联**:一行类型说明(如「PDF 文档 · 点击 ↗ 预览」) | — | — |
| `legacy-office` | 一行说明「旧版/不支持格式,点击 ↗ 查看详情」 | — | — |
| `binary` | 一行「此文件类型不支持内联预览」 | — | — |
| 任意 + `error` | 红色 `Tag`(文案复用现有 `errorLabel`)+ 不拉内容 | — | ↗ disabled(📂 保留) |

- **拉取时机**:卡片挂载后按 `path + kind + size` 判定,仅在可内联时 fetch;卸载 / path 变化用
  `cancelled` 标志 + `AbortController` 取消(防竞态与「卸载后 setState」)。
- 内联 fetch 失败(网络 / 413 / 404):内联区降级为一行提示 + `[重试]`(局部 nonce 重跑),
  **不影响头部 ↗**。
- 移动端:靠 Tailwind 响应式(`md:` = 768px,与 `useIsMobile.ts` 的 `MOBILE_BREAKPOINT` 一致),
  不引入 JS 分支。

### 6.5 复用方式:`FilePreviewBody` 增加 `variant`

`packages/zai/src/web/src/components/desktop/FilePreviewBody.tsx` 加可选 prop:

```ts
export function FilePreviewBody({ payload, variant = 'drawer' }:
  { payload: FilePreviewPayload; variant?: 'drawer' | 'inline' })
```

- `drawer`(默认)= 现有行为,**4 个现有调用方零改动**。
- `inline`:
  - `image`:优先用 payload 里的 `rawUrl`(§8),`dataUrl` 作为兼容回退;
  - `html`:容器固定高(不依赖父级 `h-full`);
  - `text`:代码块默认截断行数 20 而非 200;`[展开全部]` 仍在卡内。
- 内联卡片的 body 就是 `<FilePreviewBody variant="inline" payload={…} />` —— 内联与大预览
  共用同一套 text/代码高亮/Markdown/iframe/binary 实现,视觉与行为天然一致。

### 6.6 ↗ 动作

复用 `useFilePathActions` / `openFilePathPreview`(`lib/openFilePath.ts:91`),与 Markdown 路径
chip、「本轮产物」块的语义完全一致:

```
↗ → openFilePathPreview(path)
      ├─ /api/fs/resolve 解析(绝对路径直接命中;相对路径按 sessionCwd/实例 cwd 兜底)
      ├─ 多候选 → 卡内 Popover 候选列表(同 TurnArtifactsBlock 的 picker)
      └─ exact  → 派 FILE_PREVIEW_OPEN_EVENT(Desktop 认领)→ 未认领则 store.openFilePreview
```

📂 走 `callFsCommand('reveal')`,错误文案用 `message.error` 提示(不留静默失败)。

## 7. 前端:永不进工具折叠组卡

`packages/zai/src/web/src/components/transcript/MessageListView.tsx`。

现状 `shouldSkipOuterGroup(toolCalls)`(:30-39)是**全有或全无**判定。改为**分段**:

```ts
type GroupSegment =
  | { kind: 'inline'; entries: ToolGroupEntry[] }   // 自包含展示工具,直接内联
  | { kind: 'card';   entries: ToolGroupEntry[] }   // 其余工具,进 ToolGroupCard

/** 按 renderer.skipOuterGroup 把同一 toolGroup 的条目切成保序段。 */
function splitToolGroupEntries(entries: ToolGroupEntry[]): GroupSegment[]
```

判定规则(与现状一致,单条粒度):
- `getRenderer(name).skipOuterGroup === true` **且** `status === 'done'` → inline 候选;
- 其余(含 `pending` / `error` / `invalid` / `denied`,以及所有未标标记的工具)→ card。

**pending 仍进组卡**(设计决策):流式期间显示「N 个工具调用 · 工具调用中…」,`done` 后卡片
摘出内联。避免模型「调工具 → 结果回来」之间(几十 ms)闪一个半成品骨架卡。

渲染:
- inline 段 → 逐条 `MessageBubble`(与 expanded 视图视觉一致);
- card 段 → `ToolGroupCard`;
- 段 key 沿用首条 entry 的 `eventId`(现状做法),保证新消息 append 不重挂载、`ToolGroupCard`
  的折叠态与卡片内展开态都不丢。

expanded 分支(`:83-113`)不动 —— 它本来就逐条渲染 `MessageBubble`。

## 8. 大预览抽屉:图片改字节流

`packages/zai/src/web/src/components/conversation/FilePreviewDrawer.tsx`。

- 抽屉保留「一次 fetch `/api/fs/preview` 拿 kind / size / mime」的既有链路(§5.1 已让超限图片
  也只回元数据),只改**渲染分支**:
  - `image` → 图片 URL 用 `/api/fs/raw?path=…`(能看 > 1 MiB 的大图,省一次 base64 往返),
    `/api/fs/preview` 回带的 `content` 不再使用;
  - `text` / `html` → 沿用 `content`(1 MiB 上限,超限仍是既有的错误 Alert);
  - `docx`/`sheet`/`ppt`/`pdf`/`legacy-office` → `DocumentPreview`(走 `/api/fs/raw`,已有);
  - `binary` → Binary 分支(已有)。
- `FilePreviewPayload` 增加可选 `rawUrl?: string`;`FilePreviewBody` 的 image 分支
  `dataUrl ?? rawUrl`(desktop 的 `dataUrl` 调用方不变)。
- 移动端 `isMobile` 分支、`destroyOnClose`、宽度全屏切换、标题(size)行为全部不变。

## 9. 兼容与迁移

| 对象 | 处理 |
|---|---|
| 前端 registry 旧名 `DisplayFiles` | **不保留**(执行期裁决)。历史消息走 `genericRenderer`,退化为通用工具块 |
| 旧 wire shape `{ files: [FileMeta…] }` | **不兼容**(别名已移除,renderer 只认 `{ file, caption }`) |
| tool_use 消息的 `name` | 历史消息里是 `DisplayFiles`,不再有专用渲染 —— 无需改历史数据 |
| core 旧导出 `displayFilesOpenccTool` | 删除(工具池只挂新工具) |
| `takeDisplayFilesOutput` | 改名 `takePresentFileOutput`,同步 `bundle-entry.ts` / `routes/agent.ts` |
| `dist/opencc-src/server/displayFilesOpencc.d.ts` | 构建产物,`pnpm run build:core` 后自动消失 |
| `fileDisplay.tsx` / `fileDisplay.test.tsx` | 改为 `presentFile.tsx` / `presentFile.test.tsx` |

## 10. 错误处理矩阵

| 场景 | 工具层 | 卡片表现 |
|---|---|---|
| 路径不存在 `ENOENT` | `error.code='ENOENT'` | 红 Tag「文件不存在」;↗ disabled;📂 保留 |
| 无权限 `EACCES/EPERM` | 同上 | 红 Tag「无权限」 |
| 是目录 `EISDIR` | 同上 | 红 Tag「是目录」;📂 保留 |
| 图片 > 10 MiB | 元数据透传 `size` | 元数据行;↗ disabled(提示用文件管理器) |
| 文本 / HTML > 1 MiB | 元数据透传 | 元数据行 + 提示;↗ 可用(抽屉走既有 413 错误 Alert) |
| 图片 > 1 MiB(≤ 10 MiB) | 元数据透传 | 卡片内联正常;抽屉经 §5.1 的元数据响应 + `/api/fs/raw` 正常显示 |
| 文档 > 各自上限 | 元数据透传 | 不内联;↗ → 抽屉 `UnsupportedNotice` / 错误 |
| 二进制 | kind=binary | 一行「不支持内联预览」;↗ disabled |
| 内联 fetch 失败 / 413 / 404 | — | 内联区一行提示 + `[重试]`;头部 ↗ 不受影响 |
| `caption` 超 200 字 | schema 校验失败 → tool_use:error | 卡片不渲染(走既有工具错误块) |

## 11. 测试计划

### 11.1 单元测试(只跑相关文件)

- `packages/zn-agent-core/test/unit/tools/presentFileOpencc.test.ts`(由现
  `displayFilesOpencc.test.ts` 改写)
  - 单文件 stat;错误结构化(ENOENT/EACCES/EISDIR)
  - kind 分类:**png / html / ts / md / pdf / docx / xlsx / pptx / legacy-office** 各一(与
    zai 侧 `shared/fileKind` 的同步护栏 —— 关键扩展名两边都断言)
  - `caption` 透传与缺失
  - map 暂存:命中后 `takePresentFileOutput` 返回 wrapper 且**取出即删**
- 受影响的名字断言:`packages/zn-agent-core/test/unit/mainAgents-*.test.ts`、
  `packages/zai/test/server/mainAgents.test.ts`、`agent.test.ts`、`agentInboxIsMeta.test.ts`
- `packages/zai/test/server/routes/fs.raw.test.ts`(新增或并入既有 fs 路由测试)
  - 图片 200 + `Content-Type: image/png`;`.svg` → `image/svg+xml`
  - 图片 > 10 MiB → 413;`.zip` → 415;文档分支回归不变
- `packages/zai/test/server/routes/fs.preview.test.ts`(既有文件补充)
  - 图片 ≤ 1 MiB → 仍回 base64 `content`(回归)
  - 图片 > 1 MiB → **200 + 元数据(无 `content`)**,不再 413
  - text > 1 MiB → 仍 413(回归)
- `packages/zai/test/web/toolRenderers/presentFile.test.tsx`(由 `fileDisplay.test.tsx` 改写)
  - 各 kind 内联分支(图片 `src` 指向 `/api/fs/raw`、iframe `sandbox`、文本 20 行 + 展开全部、
    文档类不内联、binary / error 降级)
  - `caption` 渲染;↗ 触发 `openFilePathPreview`(mock 模块);📂 调 `/api/fs/reveal`
  - 旧 wire shape `{files:[…]}` 归一化渲染
- `packages/zai/src/web/src/components/transcript/MessageListView.test.tsx`
  - 混合组:`[Read, PresentFile]` → 组卡 + 内联卡,顺序保持;`[PresentFile, PresentFile]` → 无组卡
  - `pending` 的 PresentFile 仍在组卡内;`done` 后摘出
- `packages/zai/test/web/components/conversation/FilePreviewDrawer.test.tsx`
  - 图片分支改用 `/api/fs/raw` URL;text/html 仍走 `/api/fs/preview`;文档分支不变

### 11.2 真实浏览器验收(非单测门禁)

按 AGENTS.md:改 core → `pnpm run build:core`;起独立端口
`pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715`;`/ego-browser` 走完用户路径:

1. 让 Agent 依次 PresentFile 一张 PNG(含 > 1 MiB 的大图)、一个 HTML、一个 `.md`、一个 `.ts`、
   一个 PDF、一个 `.zip` —— 逐项验证:图片真的渲染出来、iframe 高度与滚动、代码高亮、20 行截断
   与展开、文档类只给说明、binary 降级。
2. ↗ → 右侧 720px 抽屉 → 宽度全屏 → 大图显示正常;`/m` 路由底部抽屉同样验证。
3. 混合场景:「先 Read 再 PresentFile」同一轮 → 组卡 + 文件卡并列出现,文件卡未被吃掉。
4. 失败路径:不存在的路径、目录、超大图片。
5. 全部用像素级证据(rect / getComputedStyle / 截图)确认,样式类改动不以 happy-dom 单测结论。

## 12. 风险与取舍

- **懒加载的内容与展示时刻可能不一致**:文件在事后被改动/删除,历史卡片会显示新内容或报错。
  接受 —— 换取 SSE/transcript 零膨胀;若日后要快照语义,再评估把内容指纹或内容本体写进
  `tool_result`(届时需改持久化)。
- **`/api/fs/raw` 扩展图片**:该路由的原始定位是「文档字节通道」,白名单是其安全边界的核心。
  扩展后白名单变成「文档类扩展名 + 图片扩展名」,仍不接受任意路径 —— 权限模型与
  `/api/fs/preview` 一致(zai 只监听 localhost,读本机文件等同 `cat`)。
- **SVG 走 `image`**:内联 `<img>` 渲染 SVG **不执行**其中脚本(与 HTML 的 `allow-scripts`
  iframe 不同),安全性优于当 HTML 处理;这也是 `classifyKind` 既有语义。
- **HTML iframe `allow-scripts`**:沿用 `FilePreviewBody` 既有 sandbox(`data:`/`srcDoc` 独立
  origin,无 `allow-same-origin`),不新开权限。
- **抽屉图片分支改造**:接触 `FilePreviewDrawer` + `FilePreviewBody`(desktop / FsTab 共用),
  用可选 prop + 默认值控制爆炸半径,并保持 `dataUrl` 回退路径,现有调用方零改动。
- **改 core 的构建成本**:`mainAgents.ts` / `presentFileOpencc.ts` / `bundle-entry.ts` 均属
  core → 验证前必须 `pnpm run build:core`,否则 ego-browser 会复现旧行为(AGENTS.md 明示)。
- **被移除的多文件能力**:模型若原来一次展示 20 个文件,现在要调 20 次。工具描述已写明
  「展示单个文件」,且多文件展示本来就会撑爆 transcript;这是本次收敛的预期代价。

## 13. 实施注意

- 改动落点分三层:core(工具 + 绑定)、zai 服务端(`/api/fs/raw`、`routes/agent.ts`)、zai 前端
  (renderer / MessageListView / FilePreviewBody / FilePreviewDrawer / registry)。
- 实施顺序建议:core 工具与改名 → 服务端字节通道 → 前端卡片与分段摘出 → 抽屉图片改造 → 兼容与测试。
- 本 spec 不写实施步骤,交由 writing-plans skill 产出实施计划。