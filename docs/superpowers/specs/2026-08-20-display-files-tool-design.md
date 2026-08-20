# display_files 内置工具设计 — 在会话中展示本地文件

日期:2026-08-20
状态:设计定稿(待实施)

## 1. 背景与目标

zai 当前 Agent 能用 Read 工具读文件、但只能把内容以纯文本行号形式塞进 transcript;Agent 无法把"生成的文件产物"主动**展示给用户**(无 UI 卡片、无右侧预览弹窗、无一键打开文件管理器)。当 Agent 完成一组写文件 / 编辑 / 报告生成任务时,用户只能滚 transcript 找路径自己拼凑体验。

目标:新增一个内置 zai-native 工具 `display_files`,Agent 调用后把一组本地文件路径以**卡片列表**渲染进对话流;每个卡片提供两个交互 —— **预览**(右侧 Drawer 按类型渲染内容)、**打开目录**(POST `/api/fs/reveal` 唤起 Finder/Explorer)。

## 2. 范围与约束

- 路径:接受任意绝对路径,**不限制 cwd**(用户在多个 PWD / 工作目录间切换时,Agent 可能展示 cwd 之外的文件)。
- 大小:单文件预览限 **1 MiB**(`1048576` 字节,`maxBytes` query 可按需调小);超过时只显示元数据,预览按钮 disabled。
- 类型支持(全部支持,**不可读类型降级为元数据 + 打开目录**):
  - 文本类:`.ts/.tsx/.js/.jsx/.mjs/.cjs/.json/.md/.markdown/.py/.go/.rs/.sh/.bash/.css/.scss/.html/.htm/.xml/.yaml/.yml/.toml/.ini/.cfg/.env/.sql` 等 + 任意 `text/*` mime → 语法高亮渲染(文本/MD 用 MarkdownText)
  - 图片:`.png/.jpg/.jpeg/.gif/.webp/.svg` + `image/*` → `<img src=data:>`
  - HTML:`.html/.htm` → sandboxed `<iframe srcDoc>`
  - 其它 / 不可读:元数据 + "请在文件管理器中打开"提示 + [打开目录] 按钮
- 单次调用最多 **20 个文件**(防 transcript 爆炸 / 误调)。
- 与现有 `/api/fs/reveal`(fs.ts:991)和 `/api/fs/open-terminal`(fs.ts:1052)复用。

## 3. 架构总图

```
LLM 调 display_files(paths: string[])
   ↓ (vendor Tool 协议 → opencc query path)
zai compat tool: displayFilesCall()  (compat/tools/displayFiles.ts)
   ├─ stat 每个 path → 元数据 (size / mtime / kind / error?)
   ├─ 安全检查:绝对路径 + 存在性 + 读权限(失败 → 结构化错误)
   └─ 返回 { content: [{ type: "json", json: { files } }] }
   ↓ (tool_result via SSE → translateRuntimeEvents)
前端 tool renderer: fileDisplayRenderer  (toolRenderers/fileDisplay.tsx)
   └─ 渲染 renderFull:
       ├─ FileCardList: 每文件一个 card(文件名/size/mtime/错误态/[预览][打开目录])
       └─ 卡片交互 dispatch 到 useAgentStore
            ├─ [打开目录] → POST /api/fs/reveal (已有)
            └─ [预览] → set previewPath → mount FilePreviewDrawer
                 └─ GET /api/fs/preview?path=... (新增,fs.ts)
                       └─ 按 mime/扩展名返回 PreviewPayload
                       └─ Drawer 按 kind 渲染:text/image/html/binary
```

## 4. 工具定义

### 4.1 文件:`packages/zn-agent-core/src/compat/tools/displayFiles.ts`(新)

```ts
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import { makeTool } from './makeTool.js'

const DisplayFilesInput = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1, 'paths 不能为空')
    .max(20, '单次最多 20 个文件')
    .describe('一组待展示的本地文件绝对路径。'),
})

type FileMeta = {
  path: string
  name: string  // basename
  size: number
  mtime: number  // ms epoch
  kind: 'text' | 'image' | 'html' | 'binary'
  error?: { code: 'ENOENT' | 'EACCES' | 'EISDIR' | 'EPERM'; message: string }
}

async function statOneFile(absPath: string): Promise<FileMeta> {
  const name = basename(absPath)
  try {
    const s = await stat(absPath)
    if (s.isDirectory()) {
      return {
        path: absPath, name, size: 0, mtime: s.mtimeMs,
        kind: 'binary',
        error: { code: 'EISDIR', message: '路径是目录,不是文件' },
      }
    }
    return {
      path: absPath, name,
      size: s.size, mtime: s.mtimeMs,
      kind: classifyKind(absPath),  // 见 §4.2
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    return {
      path: absPath, name, size: 0, mtime: 0,
      kind: 'binary',
      error: {
        code: (err.code as FileMeta['error'] extends infer T ? T extends { code: infer C } ? C : never : never) || 'EPERM',
        message: err.message || String(e),
      },
    }
  }
}

export const displayFilesTool = makeTool({
  name: 'DisplayFiles',
  description:
    '把一组本地文件路径在当前会话中展示给用户:每个文件带 [预览] 与 [打开目录] 按钮。' +
    '适合在完成文件编辑/生成/汇报任务后,把产物路径列给用户。' +
    '文件大于 1 MiB 时仅展示元数据,不会内联预览。单次最多 20 个文件。',
  inputSchema: DisplayFilesInput,
  async call({ paths }) {
    const files = await Promise.all(paths.map(statOneFile))
    return {
      content: [{ type: 'json' as const, json: { files } }],
    }
  },
})
```

### 4.2 kind 分类规则(`classifyKind`)

按扩展名(忽略大小写):
- `image/*`:`.png .jpg .jpeg .gif .webp .svg .bmp .ico`
- `html`:`.html .htm`
- `text`:已知文本扩展名(§2 列表)+ mime `text/*` + 无扩展名且 stat 后 ASCII 启发式(前 1KB 全部 ASCII)
- 其它:`binary`

注:不在工具里读内容,避免大文件 IO 与 transcript 膨胀。

### 4.3 注册

`packages/zn-agent-core/src/compat/tools/index.ts`:
- 行 36 区域增加 `import { displayFilesTool } from './displayFiles.js'`
- `buildDefaultTools()`(行 491)返回的 `tools` 数组里 `subagentControlTool`(行 509)之后追加 `displayFilesTool as Tool`

> 不走 `getOpenccBuiltinTools()` —— 那是 vendor 工具 + wrapper 的入口(`builtin.ts:77`)。zai-native 工具统一进 `buildDefaultTools()`(与 `bashTool` / `fileReadTool` / `taskTools` / `subagentControlTool` 同路径)。

## 5. 前端渲染

### 5.1 renderer 文件:`packages/zai/src/web/src/components/toolRenderers/fileDisplay.tsx`(新)

走 `renderFull` —— 整块接管渲染(header + card list + 错误态),参考 `Edit/Write` 走 `diff.tsx` 的 `renderFull` 模式(types.ts:17)。

```tsx
import React from "react"
import type { ToolRenderer } from "./types.js"
import { useAgentStore } from "../../store/useAgentStore.js"

export const fileDisplayRenderer: ToolRenderer = {
  preview(input) {
    const paths = Array.isArray(input.paths) ? input.paths : []
    return `展示 ${paths.length} 个文件`
  },
  renderFull(msg) {
    const result = parseResult(msg)
    return <FileCardList files={result.files} />
  },
}
```

- `parseResult(msg)` 从 `msg.toolResult` 抽出 `{files: FileMeta[]}`
- `FileCardList`:每文件一个 `<Card>`,显示 name / size(人类可读)/ mtime / 错误 Tag;无错误且 size ≤ 1 MiB → [预览] 启用,否则 disabled;[打开目录] 总是启用
- [预览] onClick → `useAgentStore.getState().openFilePreview(path)`
- [打开目录] onClick → `fetch('/api/fs/reveal', { method: 'POST', body: JSON.stringify({ path }) })`,无 loading(走 fire-and-forget,与现有 FsContextMenu 一致)

### 5.2 registry 注册

`packages/zai/src/web/src/components/toolRenderers/registry.ts`:
- 行 1-9 import 区域增加 `import { fileDisplayRenderer } from "./fileDisplay.js"`
- `registry` 对象(行 11-20)增加 `DisplayFiles: fileDisplayRenderer,`

### 5.3 Drawer 组件:`packages/zai/src/web/src/components/conversation/FilePreviewDrawer.tsx`(新)

- Antd `Drawer`,`placement="right"`,width `720`,可拖动;Esc 关闭
- props:`path: string | null, onClose: () => void`(单一来源 state,放 `useAgentStore`,不持有局部)
- 内部 state:`{ loading: boolean, error: string | null, payload: PreviewPayload | null }`
- 打开时(`path` 变化触发 `useEffect`):`fetch('/api/fs/preview?path=' + encodeURIComponent(path))`,默认 `maxBytes=1048576`
- 渲染分支:
  - `loading` → `<Spin />`
  - `error` → `<Alert type="error" message={error} />`
  - `payload.kind === 'text'` → `<SyntaxHighlighter language={detectLanguage(path)}>...</SyntaxHighlighter>`,文本 > 200 行截断 + "展开" 链接
  - `payload.kind === 'image'` → `<img src={\`data:${payload.mime};base64,${payload.content}\`} style={{ maxWidth: '100%' }} />`
  - `payload.kind === 'html'` → `<iframe srcDoc={payload.content} sandbox="" title={basename(path)} style={{ width: '100%', height: '100%', border: 0 }} />`(空 sandbox:禁止 scripts / forms / popups / 同源)
  - `payload.kind === 'binary'` → 显示 size / mtime + "此文件类型不支持内联预览" + [打开目录] 按钮(复用 `/api/fs/reveal`)
- 标题:`{basename(path)} ({humanSize})`
- 文件过大(413)时 Drawer 仍开,显示元数据 + [打开目录]

### 5.4 store 接线

`packages/zai/src/web/src/store/useAgentStore.ts`:
- state:`filePreviewPath: string | null`
- actions:`openFilePreview(path: string)` / `closeFilePreview()`
- 持久化:不持久化(刷新会话后默认 `null`,下次调 `display_files` 才会有路径)

### 5.5 root mount

- `packages/zai/src/web/src/pages/Agent.tsx`(行 513-515 附近)挂 `<FilePreviewDrawer />`,与 TaskDrawer/ApproveDrawer/SettingsDrawer 同位置(单例)
- `packages/zai/src/web/src/pages/MobileAgent.tsx`(行 79-81 附近)同样挂载(mobile 路径独立 — `/m` 路由,见 AGENTS.md "移动端路由访问路径")

## 6. 后端:新增 `GET /api/fs/preview`

### 6.1 路由位置

`packages/zai/src/server/routes/fs.ts` —— 与 `fsRouter.post('/fs/reveal', ...)`(行 991)等并列,在 `platformCommands` 之后。

### 6.2 行为

```ts
const PREVIEW_DEFAULT_MAX = 1_048_576  // 1 MiB

fsRouter.get('/fs/preview', async (req, res) => {
  const { cwd } = ctx(req)
  const raw = typeof req.query.path === 'string' ? req.query.path : ''
  if (!raw) { res.status(400).json({ error: { code: 'EBADREQ', message: 'path 必填' } }); return }
  const abs = path.resolve(raw)
  const maxBytes = clampInt(req.query.maxBytes, 1024, PREVIEW_DEFAULT_MAX, PREVIEW_DEFAULT_MAX)

  let stat
  try { stat = await fs.promises.stat(abs) }
  catch (e) { return mapStatError(res, e) }  // 404/403/... → 4xx + JSON

  if (stat.isDirectory()) {
    res.status(400).json({ error: { code: 'EISDIR', message: '路径是目录' } }); return
  }
  if (stat.size > maxBytes) {
    res.status(413).json({ error: { code: 'ETOOBIG', message: `文件 ${stat.size} 字节,超过 ${maxBytes}`, meta: { size: stat.size } } })
    return
  }
  const kind = classifyKindFromExt(abs)
  if (kind === 'image') {
    const buf = await fs.promises.readFile(abs)
    const mime = mimeFromExt(abs) ?? 'application/octet-stream'
    res.json({ kind, mime, content: buf.toString('base64'), size: stat.size, mtime: stat.mtimeMs })
    return
  }
  if (kind === 'html' || kind === 'text') {
    const text = await fs.promises.readFile(abs, 'utf8')
    res.json({ kind, mime: kind === 'html' ? 'text/html' : 'text/plain', content: text, size: stat.size, mtime: stat.mtimeMs })
    return
  }
  // binary
  res.json({ kind: 'binary', size: stat.size, mtime: stat.mtimeMs, ext: path.extname(abs) })
})
```

- 错误统一 JSON:`{ error: { code, message, meta? } }`
- `mapStatError`:ENOENT → 404 + code='ENOENT';EACCES/EPERM → 403 + code='EACCES';其它 500 + code='EIO'
- `classifyKindFromExt`:`classifyKind` 与 §4.2 同样的逻辑,共享规则(可抽到 `packages/zai/src/shared/fs.ts` 或新文件 `packages/zai/src/shared/fileKind.ts`)
- 复用现有 `ctx(req)` 取 cwd(虽然不限 cwd,但 log 一下利于排查)

### 6.3 类型

`packages/zai/src/shared/fs.ts`(现有)增加:

```ts
export type FilePreviewKind = 'text' | 'image' | 'html' | 'binary'
export interface FilePreviewPayload {
  kind: FilePreviewKind
  mime?: string
  content?: string  // text/html → 原文;image → base64
  size: number
  mtime: number
  ext?: string  // binary 时返回
}
export interface FilePreviewError { code: 'ENOENT' | 'EACCES' | 'EISDIR' | 'ETOOBIG' | 'EBADREQ' | 'EIO'; message: string; meta?: { size?: number } }
```

zod schema 同名导出供前端 fetch 类型校验(可选,前端用 ts 类型断言即可)。

## 7. 错误处理矩阵

| 场景 | 工具层(`display_files`) | 预览 API(`/fs/preview`) | UI 行为 |
|------|--------|-----------|---------|
| 路径不存在 | `error.code='ENOENT'` | 404 | 卡片红 Tag "文件不存在",[预览] disabled |
| 无权限 | `error.code='EACCES'` | 403 | 卡片红 Tag "无权限" |
| 是目录 | `error.code='EISDIR'` | 400 | 卡片红 Tag "是目录",[打开目录] 仍可用 |
| 文件 > 1 MiB | 元数据 `size` 透传 | 413 | [预览] disabled + tooltip "文件过大,请在文件管理器中打开" |
| 未识别二进制 | — | 200 + kind=binary | [预览] Drawer 显示元数据 + [打开目录] |
| `path` query 缺失 | — | 400 | Drawer 不打开 / Alert |
| 前端 fetch 失败 | — | network error | Drawer `<Alert type="error" message={String(err)} />` |
| HTML 预览脚本 | — | (sandbox 限制) | iframe `sandbox=""` 禁止一切,等同纯静态渲染 |

## 8. 持久化与 transcript

- 工具结果(`{files: FileMeta[]}`,每条约 100 字节)随 `tool_result` 进 transcript(已有持久化路径,**无需新代码**)
- 20 个文件上限:极端 20 × 100 字节 ≈ 2 KiB,远低于 transcript 单条 30 KiB 阈值
- 刷新会话:transcript 重放 → fileDisplayRenderer 重新渲染卡片列表;若文件已删,卡片红 Tag "文件不存在",[打开目录] 仍可点(若目录也在则报错,不强求)
- 文件**内容不持久化**,通过 `/fs/preview` 按需 fetch —— 文件改动后预览即时反映新内容
- 多会话并发:Drawer 是单例,store 持有 `filePreviewPath`,新 Agent 调用覆写前一个 path;用户当前打开的 Drawer 显示新文件(若用户在 Drawer 里再调别的 display_files,Drawer 替换内容)

## 9. 测试计划

### 9.1 单元测试

- `packages/zn-agent-core/test/unit/tools/displayFiles.test.ts`
  - 多文件 stat、错误结构化(ENOENT/EACCES/EISDIR)
  - paths 长度校验(0 / 21 报错)
  - kind 分类(图片/HTML/文本/二进制扩展名各一)
- `packages/zn-agent-core/test/unit/tools/buildDefaultToolsIncludesDisplayFiles.test.ts`
  - `buildDefaultTools()` 数组包含 `DisplayFiles`,与 `taskTools` 同模式
- `packages/zai/test/server/routes/fs.preview.test.ts`
  - 各类 kind 返回正确(图片 → base64,HTML → 原文,binary → 元数据)
  - 超 maxBytes → 413
  - 路径不存在 → 404
  - 目录 → 400
  - `maxBytes` query 参数 clamp 到 [1024, 1048576]
- `packages/zai/test/web/components/toolRenderers/fileDisplay.test.tsx`
  - renderFull 渲染 card list
  - 错误态不渲染 [预览]
  - size > 1 MiB 时 [预览] disabled
  - [打开目录] 调用 fetch 正确
- `packages/zai/test/web/components/conversation/FilePreviewDrawer.test.tsx`
  - 各 kind 渲染分支(image → img,html → iframe,text → SyntaxHighlighter,binary → 元数据)
  - HTML iframe sandbox 属性为空
  - Esc 关闭触发 onClose
  - 413 显示元数据 + [打开目录]

### 9.2 浏览器验收(强制项)

按 AGENTS.md "真实浏览器验收" 节:

1. `pnpm run build:core`(改 core 后必须先 build)
2. `pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715`(独立端口,避免 920x 正式服务)
3. `/ego-browser` 真实浏览器,对话中让 Agent "把 /tmp/test.txt 显示出来",Agent 调 `display_files` → 验证:
   - 卡片渲染:文件名 / size / mtime
   - [预览] → Drawer 弹窗 → SyntaxHighlighter 渲染代码
   - [打开目录] → Finder 打开(可能无 GUI,验证 fetch 调用即可)
   - 路径不存在 → 卡片红 Tag
   - 图片/HTML/MD 各类型分别验证
   - `/m` 路由同步验证(mobile 独立路径)

## 10. 风险与取舍

- **不复用 FsTab 内部 `FilePreview`**(fs.ts:468):它深度耦合 FsTab 的 `useFsFile` hook 与 `htmlMode` / `pendingLine` 状态;抽出成本高、风险大。本设计在 FilePreviewDrawer 内自写轻量版(用 `syntaxHighlighter` + Antd `Drawer` + `<iframe>` + `<img>`,与现有组件 1:1 对应)。后续可独立优化合并。
- **HTML 预览空 sandbox**:安全性最高(等同纯静态),但 `<script>` / `<link>` / `<form>` 全部失效 —— 用户主动展示的本地 HTML 通常是文档/报告,可接受。若日后需要支持富 HTML 预览,改为 `sandbox="allow-same-origin"` 并加 CSP 头(`frame-src` 仅 `data:`)。
- **1 MiB 硬上限**:满足常见代码 / 配置 / 小文档预览;图片也可;大报告(PDF 二进制本就不支持)只能走打开目录。可调,但需评估 transcript 体积与 Drawer 渲染性能。
- **路径不限制 cwd**:模型可信(走 vendor Tool 协议的 LLM 调用),但用户审查 tool call 时可见 —— AGENTS.md "强制开发规则" 已要求 `/ego-browser` 走完用户路径,真实点击验证路径展示。
- **`buildDefaultTools()` 修改**:与 §4.3 同位置,与最近 `subagentControlTool` 改动同源 —— 已有 taskTools / subagentControlTool 两次先例,模式稳定。
- **新工具名 `DisplayFiles` 与 vendor `Read` 重名风险**:vendor 工具名是 `Read`(小写,已注册),我用 PascalCase `DisplayFiles` 区分;`getRenderer` 按字符串精确匹配,无冲突。
- **没有专门的设计用于 sub-agent 路径**:子 Agent 调 display_files 时,工具结果通过 SSE 流回主对话 —— 现有 vendor 事件链路(transcript + renderer)自动处理,无需额外接线。

## 11. worktree 与实施起点

实施前:

```bash
git worktree add ../opencc-web-display-files -b feat/display-files-tool HEAD
```

- 基于 `HEAD`(最近 commit,不含 main 上 `@`-mention in-progress 未提交工作)
- 命名沿用仓库现有约定(`opencc-web-<topic>` / `feat/<topic>`-tool 模式)

实施期间:
- 修改 `packages/zn-agent-core/src/compat/tools/` → **必须 `pnpm run build:core`** 后再启 zai 验证
- 修改 `packages/zai/src/web/src/` → 纯前端,无需 build:core
- 修改 `packages/zai/src/server/routes/` → 服务端源码,无需 build:core,但 zai dev 会热重载

实施完成后(本 spec 不写实施细节,交由 writing-plans skill 出实施计划)。
