# PresentFile 单文件展示工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `DisplayFiles` 收敛为单文件展示工具 `PresentFile` —— 文件卡在对话流内直接渲染图片 / HTML / 文本内容,右上角 ↗ 复用现有预览链路开大尺寸预览,且卡片永不进入工具折叠组卡。

**Architecture:** 工具只 stat 回元数据(LLM 侧压成 `'done'`,元数据走既有 `toolUseId → wrapper JSON` 隐藏 map 到前端),内容由前端按 kind 懒加载:图片走扩展后的 `/api/fs/raw` 字节流(10 MiB),文本/HTML 走 `/api/fs/preview`,文档类不内联只给 ↗。渲染复用 `FilePreviewBody`(新增 `variant='inline'`),`MessageListView` 的 toolGroup 由「全有或全无」改为按 `skipOuterGroup` 分段摘出。

**Tech Stack:** TypeScript 5.6 / Node ≥20 / zod v4 / React 18 + AntD 5 + Tailwind / Express + SSE / Vitest 4 / pnpm workspaces

**Spec:** `docs/superpowers/specs/2026-09-24-zai-present-file-design.md`

## Global Constraints

- **系统提示词一律英文**:工具描述(`TOOL_DESCRIPTION`)、`inputSchema.describe()`、agent 描述全部英文。用户可见 UI 文案保持中文。
- **core 改动必须先 build**:任何 `packages/zn-agent-core/` 改动,在 zai 进程里生效前必须 `pnpm run build:core`(bundle + `bundle-entry.d.ts` + `opencc-src/server/*.d.ts` 都是构建产物)。
- **样式用 Tailwind utility class**:静态布局/颜色/尺寸走 className,颜色走 `text-[var(--text-primary)]` 这类 arbitrary value;AntD 语义槽位用 `styles={{...}}`;只有运行时计算值(坐标、`calc()`、视口)才用 inline style。
- **测试只跑相关文件**:`pnpm --filter @zn-ai/zai test <path>`,禁止用 `pnpm -r test` 全量当完成门禁。
- **提交格式**:`HRMSV3-ZN-WEBSITE#668 <type>(scope): 描述`(例:`HRMSV3-ZN-WEBSITE#668 feat(zai): …`)。
- **端口**:起 dev 前先 `lsof -i :<port>`;显式指定端口被占用必须报错退出,禁止静默换端口;不要 kill 920x(正式服务端口)。
- **样式/真实渲染不以单测为门禁**:内联图片、iframe 高度、代码高亮、抽屉大预览必须用真实浏览器(ego-browser)看像素证据,且**先问用户**是否要跑。
- **不写入根 `.zai/` 路径到代码**;不新增文档文件除非任务明确要求。

## File Structure

**core(`packages/zn-agent-core/`)**
- `src/opencc-src/server/presentFileOpencc.ts` — **新建**,`PresentFile` 工具定义(stat + kind 分类 + 展示通道 map)
- `src/opencc-src/server/displayFilesOpencc.ts` — **删除**(被上者取代)
- `src/opencc-src/server/mainAgents.ts` — default agent tools 槽改挂新工具
- `src/opencc-src/server/mainAgents-weixin.ts` — 注释措辞(工具名)
- `src/bundle-entry.ts` — 导出改名 `takePresentFileOutput`
- `test/unit/tools/presentFileOpencc.test.ts` — **新建**(替代 `displayFilesOpencc.test.ts`)
- `test/unit/mainAgents-office.test.ts`、`test/unit/mainAgents-weixin.test.ts`、`test/unit/mainAgents-toolFilters.test.ts` — 夹具/断言改名

**zai 服务端(`packages/zai/src/`)**
- `shared/fileKind.ts` — 落常量 `IMAGE_MAX_BYTES` / `PREVIEW_TEXT_MAX_BYTES`
- `server/routes/fs.ts` — `/api/fs/raw` 支持图片;`/api/fs/preview` 图片超限回元数据
- `server/routes/agent.ts` — 展示通道转发改名 + 工具名判断

**zai 前端(`packages/zai/src/web/src/`)**
- `components/toolRenderers/presentFile.tsx` — **新建**,卡片渲染器
- `components/toolRenderers/fileDisplay.tsx` — **删除**
- `components/toolRenderers/registry.ts` — 注册 `PresentFile`(**不保留**旧名 `DisplayFiles` 别名)
- `components/transcript/MessageListView.tsx` — toolGroup 分段摘出
- `components/desktop/FilePreviewBody.tsx` — `variant` + `rawUrl`
- `components/conversation/FilePreviewDrawer.tsx` — 图片改字节流 URL

**测试(`packages/zai/test/`、同目录 `*.test.tsx`)**
- `test/server/routes/fs-raw.test.ts`、`test/server/routes/fs.preview.test.ts`
- `test/server/mainAgents.test.ts`、`test/server/agent.test.ts`、`test/server/agentInboxIsMeta.test.ts`
- `test/web/components/toolRenderers/presentFile.test.tsx`、`test/web/components/conversation/FilePreviewDrawer.test.tsx`
- `src/web/src/components/transcript/MessageListView.test.tsx`

---

### Task 1: core — PresentFile 工具上线、DisplayFiles 退场

一次改名贯穿 core → zai server,中间态不可编译,必须同一个 commit 完成。

**Files:**
- Create: `packages/zn-agent-core/src/opencc-src/server/presentFileOpencc.ts`
- Delete: `packages/zn-agent-core/src/opencc-src/server/displayFilesOpencc.ts`
- Modify: `packages/zn-agent-core/src/opencc-src/server/mainAgents.ts:36,83-101`
- Modify: `packages/zn-agent-core/src/opencc-src/server/mainAgents-weixin.ts:8,29`
- Modify: `packages/zn-agent-core/src/bundle-entry.ts:51-54`
- Modify: `packages/zai/src/server/routes/agent.ts:42,615-627`
- Create: `packages/zn-agent-core/test/unit/tools/presentFileOpencc.test.ts`
- Delete: `packages/zn-agent-core/test/unit/tools/displayFilesOpencc.test.ts`
- Modify: `packages/zn-agent-core/test/unit/mainAgents-office.test.ts:24,59`
- Modify: `packages/zn-agent-core/test/unit/mainAgents-weixin.test.ts:5,31,53,58`
- Modify: `packages/zn-agent-core/test/unit/mainAgents-toolFilters.test.ts:18,22`
- Modify: `packages/zai/test/server/mainAgents.test.ts:344-350`
- Modify: `packages/zai/test/server/agent.test.ts:40-43,112-113,125,548-600`
- Modify: `packages/zai/test/server/agentInboxIsMeta.test.ts:72`
- Modify: `AGENTS.md:156`
- Modify: `docs/opencc-vendor-repl-execution.md:563`

**Interfaces:**
- Produces:
  - `presentFileOpenccTool: Tool`, `name === 'PresentFile'`, `inputSchema` = `z.object({ path: string(min 1), caption?: string(max 200) })`
  - `takePresentFileOutput(toolUseId: string): string | undefined`(取出即删)
  - wire:`call()` → `{ data: { output: JSON.stringify({ content: [{ type: 'json', json: { file: FileMeta, caption? } }] }) } }`,其中 `FileMeta = { path, name, size, mtime, kind, error? }`、`kind ∈ 'text'|'image'|'html'|'binary'|'docx'|'sheet'|'ppt'|'pdf'|'legacy-office'`
- Consumes: 无(本任务是最上游)

- [ ] **Step 1: 写新的工具单测(先失败)**

创建 `packages/zn-agent-core/test/unit/tools/presentFileOpencc.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  presentFileOpenccTool,
  takePresentFileOutput,
} from '../../../src/opencc-src/server/presentFileOpencc.js'

async function tmp(name: string, content: string | Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'presentfile-opencc-'))
  const p = path.join(dir, name)
  await fs.writeFile(p, content)
  return p
}

async function parseOutput(result: unknown): Promise<{ file: Record<string, any>; caption?: string }> {
  // vendor Tool.call returns { data: { output: <json-stringified wrapper> } }
  // 前端 presentFileRenderer::parsePresented 解析 wrapper.content[0].json。
  const data = (result as { data: { output: string } }).data
  const wrapper = JSON.parse(data.output)
  return wrapper.content[0].json
}

async function callTool(input: { path: string; caption?: string }) {
  // vendor Tool.call 的签名带若干可选上下文参数,单测统一补 undefined。
  return presentFileOpenccTool.call(input, {} as any, undefined as any, undefined as any, undefined as any)
}

describe('presentFileOpenccTool', () => {
  it('returns metadata for the single input path', async () => {
    const a = await tmp('a.ts', 'const x = 1\n')
    const result = await callTool({ path: a })
    const payload = await parseOutput(result)
    expect(payload.file.path).toBe(a)
    expect(payload.file.name).toBe('a.ts')
    expect(payload.file.kind).toBe('text')
    // 'const x = 1\n' = 12 bytes.
    expect(payload.file.size).toBe(12)
    expect(payload.file.error).toBeUndefined()
  })

  it('passes caption through the wrapper', async () => {
    const a = await tmp('a.ts', 'ok')
    const result = await callTool({ path: a, caption: '刚生成的架构图' })
    const payload = await parseOutput(result)
    expect(payload.caption).toBe('刚生成的架构图')
  })

  it('omits caption when not provided', async () => {
    const a = await tmp('a.ts', 'ok')
    const payload = await parseOutput(await callTool({ path: a }))
    expect(payload.caption).toBeUndefined()
  })

  it.each([
    ['page.html', 'html'],
    ['pixel.png', 'image'],
    ['shot.svg', 'image'],
    ['blob.zip', 'binary'],
    // 文档类对齐 shared/fileKind.ts —— PDF 不再被误判成 binary(本任务的核心修复)
    ['report.pdf', 'pdf'],
    ['doc.docx', 'docx'],
    ['book.xlsx', 'sheet'],
    ['deck.pptx', 'ppt'],
    ['legacy.doc', 'legacy-office'],
  ])('classifies %s as kind %s', async (name, kind) => {
    const p = await tmp(name, 'x')
    const payload = await parseOutput(await callTool({ path: p }))
    expect(payload.file.kind).toBe(kind)
  })

  it('returns ENOENT error for a missing path', async () => {
    const payload = await parseOutput(await callTool({ path: '/this/does/not/exist.txt' }))
    expect(payload.file.error.code).toBe('ENOENT')
    expect(payload.file.kind).toBe('binary')
  })

  it('returns EISDIR error for a directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'presentfile-opencc-dir-'))
    const payload = await parseOutput(await callTool({ path: dir }))
    expect(payload.file.error.code).toBe('EISDIR')
  })

  it('rejects an empty path — input schema is min(1)', () => {
    const schema = presentFileOpenccTool.inputSchema as any
    expect(schema.safeParse({ path: '' }).success).toBe(false)
  })

  it('rejects a caption longer than 200 chars', () => {
    const schema = presentFileOpenccTool.inputSchema as any
    expect(schema.safeParse({ path: '/a.ts', caption: 'x'.repeat(201) }).success).toBe(false)
    expect(schema.safeParse({ path: '/a.ts', caption: 'x'.repeat(200) }).success).toBe(true)
  })

  it('exposes tool name PresentFile and is read-only', () => {
    expect(presentFileOpenccTool.name).toBe('PresentFile')
    expect(presentFileOpenccTool.isReadOnly()).toBe(true)
    expect(presentFileOpenccTool.isConcurrencySafe()).toBe(true)
    expect(presentFileOpenccTool.isDestructive()).toBe(false)
  })

  it('describes itself in English (AGENTS.md: prompts must be English)', async () => {
    const desc = await presentFileOpenccTool.description()
    expect(desc).toContain('Present one local file')
    expect(desc).not.toMatch(/[\u4e00-\u9fa5]/)
  })

  it('mapToolResultToToolResultBlockParam returns literal "done" so the model never sees file metadata', () => {
    const block = presentFileOpenccTool.mapToolResultToToolResultBlockParam(
      { output: '{"content":[{"type":"json","json":{"file":{"path":"/a.ts"}}}]}' },
      'toolu_test_001',
    )
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_test_001',
      content: 'done',
    })
    expect((block as { content: string }).content).not.toContain('path')
  })

  it('stashes the wrapper by toolUseId while still returning "done" (frontend display channel)', () => {
    const toolUseId = 'toolu_stash_001'
    const wrapper = '{"content":[{"type":"json","json":{"file":{"path":"/a.ts"}}}]}'
    presentFileOpenccTool.mapToolResultToToolResultBlockParam({ output: wrapper }, toolUseId)
    expect(takePresentFileOutput(toolUseId)).toBe(wrapper)
    // 取出即删
    expect(takePresentFileOutput(toolUseId)).toBeUndefined()
  })

  it('takePresentFileOutput returns undefined for unknown ids or non-string outputs', () => {
    presentFileOpenccTool.mapToolResultToToolResultBlockParam({ output: undefined }, 'toolu_noop_001')
    expect(takePresentFileOutput('toolu_noop_001')).toBeUndefined()
    expect(takePresentFileOutput('toolu_never_called')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/zn-agent-core && pnpm test test/unit/tools/presentFileOpencc.test.ts
```
Expected: FAIL —— `Failed to resolve import ".../presentFileOpencc.js"`。

- [ ] **Step 3: 写工具实现**

创建 `packages/zn-agent-core/src/opencc-src/server/presentFileOpencc.ts`:

```ts
/**
 * presentFileOpencc — vendor-shape 内置工具:把**一个**本地文件直接展示在
 * 当前对话里。
 *
 * 前端渲染见 packages/zai/src/web/src/components/toolRenderers/presentFile.tsx
 * (图片 / HTML / 文本·Markdown·代码在卡片内联渲染;文档类与二进制只给元数据
 * + 右上角 ↗ 大预览)。设计:
 * docs/superpowers/specs/2026-09-24-zai-present-file-design.md。
 *
 * 取代 2026-08-20 的 DisplayFiles(多文件元数据卡):
 *   - 单文件(一次只展示一个,避免 transcript 膨胀)
 *   - kind 分类补齐文档类(docx/sheet/ppt/pdf/legacy-office),PDF / Word
 *     不再被误判成 binary
 *   - 工具描述与 schema 描述改英文(AGENTS.md:系统提示词一律英文)
 *
 * 实现位置在 opencc-src/ 而不是 compat/tools/:复用 vendor 的 buildTool +
 * zod v4 schema(直接进 zodToJsonSchema → API 请求),与 BashTool 并列成为
 * 真正的内置工具。
 */
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../Tool.js'

// 扩展名分类规则必须与 packages/zai/src/shared/fileKind.ts 保持一致 ——
// zn-agent-core 不能反向 import zai(bundle 单向依赖),两份 Set 字面量各自
// 维护;presentFileOpencc.test.ts 与 zai 侧的 fileKind 测试对关键扩展名
// (png/html/ts/md/pdf/docx)双向断言,作为规则同步的护栏。
const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.xml',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.sql', '.graphql', '.gql',
  '.env', '.gitignore', '.gitattributes', '.lock', '.log',
])
const HTML_EXTS = new Set(['.html', '.htm'])
const IMAGE_EXTS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}
const DOCX_EXTS = new Set(['.docx', '.docm'])
// SheetJS 能读的表格格式(见 2026-09-21 文档预览设计 §2.7)。
const SHEET_EXTS = new Set(['.xlsx', '.xlsm', '.xlsb', '.xls', '.ods', '.csv'])
const PPT_EXTS = new Set(['.pptx', '.pptm'])
const PDF_EXTS = new Set(['.pdf'])
// 旧版二进制 Office(BIFF/OLE)与 ODF —— 浏览器端无渲染库。
const LEGACY_OFFICE_EXTS = new Set(['.doc', '.ppt', '.rtf', '.odt', '.odp'])

/** 与 packages/zai/src/shared/fileKind.ts 的 FilePreviewKind 同构。 */
type FilePreviewKind =
  | 'text' | 'image' | 'html' | 'binary'
  | 'docx' | 'sheet' | 'ppt' | 'pdf' | 'legacy-office'

function classifyKind(absPath: string): FilePreviewKind {
  const ext = extname(absPath).toLowerCase()
  if (ext in IMAGE_EXTS) return 'image'
  if (HTML_EXTS.has(ext)) return 'html'
  if (TEXT_EXTS.has(ext)) return 'text'
  if (DOCX_EXTS.has(ext)) return 'docx'
  if (SHEET_EXTS.has(ext)) return 'sheet'
  if (PPT_EXTS.has(ext)) return 'ppt'
  if (PDF_EXTS.has(ext)) return 'pdf'
  if (LEGACY_OFFICE_EXTS.has(ext)) return 'legacy-office'
  return 'binary'
}

type FileErrorCode = 'ENOENT' | 'EACCES' | 'EISDIR' | 'EPERM' | 'EBUSY' | 'ELOOP'

interface FileMeta {
  path: string
  name: string
  size: number
  mtime: number
  kind: FilePreviewKind
  error?: { code: FileErrorCode; message: string }
}

function normalizeErrno(code: string | undefined): FileErrorCode {
  switch (code) {
    case 'ENOENT':
    case 'EACCES':
    case 'EISDIR':
    case 'EPERM':
    case 'EBUSY':
    case 'ELOOP':
      return code
    default:
      return 'EPERM'
  }
}

async function statOneFile(absPath: string): Promise<FileMeta> {
  const name = basename(absPath)
  try {
    const s = await stat(absPath)
    if (s.isDirectory()) {
      return {
        path: absPath,
        name,
        size: 0,
        mtime: s.mtimeMs,
        kind: 'binary',
        error: { code: 'EISDIR', message: '路径是目录,不是文件' },
      }
    }
    return {
      path: absPath,
      name,
      size: s.size,
      mtime: s.mtimeMs,
      kind: classifyKind(absPath),
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    return {
      path: absPath,
      name,
      size: 0,
      mtime: 0,
      kind: 'binary',
      error: {
        code: normalizeErrno(err.code),
        message: err.message || String(e),
      },
    }
  }
}

const TOOL_DESCRIPTION =
  'Present one local file directly to the user in this conversation. The file is ' +
  'rendered inline as a card: images, HTML pages, text / code / Markdown get an ' +
  'inline preview, and every kind gets an "open large preview" button. Use it to ' +
  'hand over an artifact (generated report, chart, image, export) instead of only ' +
  'writing its path in the reply. Images larger than 10 MiB, text / HTML larger ' +
  'than 1 MiB and unsupported binaries show metadata only. Present one file per call.'

const inputSchema = z.object({
  path: z.string().min(1).describe('Absolute path of the local file to present.'),
  caption: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Optional one-line note shown above the preview, e.g. what this file is. Max 200 characters.',
    ),
})

// 前端展示数据暂存 (zai patch):mapToolResultToToolResultBlockParam 回灌给
// LLM 的 content 是 'done',但前端 presentFileRenderer 渲染卡片需要这段
// wrapper JSON —— 两者都源自 tool_result content,不能兼顾。这里把 wrapper
// 按 toolUseId 暂存,zai server 转发 runtime.tool_result 时
// takePresentFileOutput 取出(取出即删);LLM 消息历史里的 content 保持
// 'done' 不变(省上下文)。
const presentFileOutputsByToolUse = new Map<string, string>()

export function takePresentFileOutput(toolUseId: string): string | undefined {
  const output = presentFileOutputsByToolUse.get(toolUseId)
  if (output !== undefined) {
    presentFileOutputsByToolUse.delete(toolUseId)
  }
  return output
}

/** vendor-shape Tool,直接挂入 mainAgent.tools 槽(见 mainAgents.ts)。 */
export const presentFileOpenccTool = buildTool({
  name: 'PresentFile',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  async description() {
    return TOOL_DESCRIPTION
  },
  async prompt() {
    return TOOL_DESCRIPTION
  },
  get inputSchema() {
    return inputSchema
  },
  maxResultSizeChars: 20_000,
  async call({ path, caption }) {
    const file = await statOneFile(path)
    const output = JSON.stringify({
      content: [{ type: 'json' as const, json: { file, caption } }],
    })
    return { data: { output } }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  // zai patch:不把 stat 结果回灌给 LLM —— 前端已按元数据渲染卡片,LLM 拿到
  // 这些 JSON 只会浪费上下文。统一返回 'done' 让模型立刻停;wrapper 暂存进
  // 上面的 map 供 SSE → 前端展示通道使用。
  mapToolResultToToolResultBlockParam(
    content: { output?: string },
    toolUseID: string,
  ) {
    if (typeof content?.output === 'string') {
      presentFileOutputsByToolUse.set(toolUseID, content.output)
    }
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: 'done',
    }
  },
  toAutoClassifierInput() {
    return ''
  },
  checkPermissions(input) {
    return Promise.resolve({
      behavior: 'allow' as const,
      updatedInput: input,
      decisionReason: {
        type: 'mode' as const,
        mode: 'bypassPermissions' as const,
      },
    })
  },
  userFacingName: () => 'PresentFile',
})
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/zn-agent-core && pnpm test test/unit/tools/presentFileOpencc.test.ts
```
Expected: PASS(全部用例)。

- [ ] **Step 5: 删除旧工具与旧测试,改名导出与挂载点**

```bash
git rm packages/zn-agent-core/src/opencc-src/server/displayFilesOpencc.ts \
       packages/zn-agent-core/test/unit/tools/displayFilesOpencc.test.ts
```

`packages/zn-agent-core/src/bundle-entry.ts:51-54` 改为:

```ts
// zai patch:PresentFile 前端展示通道 —— wrapper JSON 按 toolUseId 暂存,
// zai server 转发 runtime.tool_result 时从主入口取出(见
// routes/agent.ts translateRuntimeEvents 的 tool_use:done case)。
export { takePresentFileOutput } from './opencc-src/server/presentFileOpencc.js'
```

`packages/zn-agent-core/src/opencc-src/server/mainAgents.ts`:

```ts
// :36
import { presentFileOpenccTool } from './presentFileOpencc.js'
```

```ts
// :83-101 —— 注释与槽体
/** 内置 agents。default 不改 systemPrompt / mcp,仅通过 tools 槽挂入
 *  presentFileOpenccTool(把单个本地文件以卡片渲染进对话)。
 *  office / agent-creator 不挂 —— 它们面向文档/agent 创作场景,
 *  PresentFile 跟场景无关。 */
export function getBuiltinMainAgents(): MainAgentConfig[] {
  return [
    {
      name: 'default',
      description: '系统默认 —— 代码编写、程序处理',
      tools: (origin: Tool[]) => {
        // origin 已是 vendor 内置 + MCP + 权限过滤后的最终池。
        // 先剔除内网不可用工具(WebFetch),再 append PresentFile;
        // append 前查重(若 origin 已有同名,跳过;防御);即时生效。
        const pool = filterBannedTools(origin)
        if (pool.some((t) => t.name === presentFileOpenccTool.name)) {
          return pool
        }
        return [...pool, presentFileOpenccTool]
      },
    },
    officeMainAgent,
    agentCreatorMainAgent,
    taskFactoryMainAgent,
    taskIntakeMainAgent,
    // zai patch (2026-09-04, quick-intake):与 taskIntakeMainAgent 并列,
    // 供「快速创建」弹窗(mainAgent: 'task-intake-quick')使用,跳过 brainstorming。
    taskIntakeQuickMainAgent,
    // zai patch (2026-09-13, weixin-bot):微信通道专用 —— 指派型调度助手。
    // 微信会话是长期固定 session,主上下文靠「子 agent 派发」保命;
    // 无 Web UI(PresentFile 不挂);cron 三件套全量开放。
    weixinMainAgent,
  ]
}
```

`packages/zn-agent-core/src/opencc-src/server/mainAgents-weixin.ts:8,29` 两处注释里的 `DisplayFiles` 改 `PresentFile`(纯注释,不改逻辑)。

- [ ] **Step 6: 改 zai server 的展示通道转发**

`packages/zai/src/server/routes/agent.ts`:

```ts
// :42
  takePresentFileOutput,
```

```ts
// :615-627
        // PresentFile 前端展示通道:LLM 消息历史里的 tool_result content 是
        // 'done'(工具 mapToolResultToToolResultBlockParam 省上下文),但前端
        // presentFileRenderer 渲染文件卡片靠 SSE output 里的 wrapper JSON ——
        // 两者源自同一份 content,不能两全。zai-agent-core 把 wrapper 按
        // toolUseId 暂存,takePresentFileOutput 取出即删;命中就替换 output,
        // 无暂存(异常路径)回退到 content 原值。
        let toolOutput = (ev.output as unknown) ?? "";
        if (toolName === "PresentFile") {
          const wrapped = takePresentFileOutput(id);
          if (typeof wrapped === "string") {
            toolOutput = wrapped;
          }
        }
```

- [ ] **Step 7: 改受影响的测试夹具与断言**

逐处把 `DisplayFiles` / `displayFiles` 换成 `PresentFile` / `presentFile`(语义不变,只是工具名):

- `packages/zn-agent-core/test/unit/mainAgents-office.test.ts`:24 `{ name: 'PresentFile' }`;:59 `const dropped = ['WebFetch', 'PresentFile', 'Workflow', 'EnterWorktree', 'LSP']`
- `packages/zn-agent-core/test/unit/mainAgents-weixin.test.ts`:5 注释、:31 `{ name: 'PresentFile' }`、:53 用例名、:58 `expect(names).not.toContain('PresentFile')`
- `packages/zn-agent-core/test/unit/mainAgents-toolFilters.test.ts`:18 `it('default tools slot strips WebFetch but keeps PresentFile', …)`、:22 `expect(names).toContain('PresentFile')`
- `packages/zai/test/server/mainAgents.test.ts`:344 用例名、:350 `'PresentFile'`
- `packages/zai/test/server/agent.test.ts`:变量 `mockTakeDisplayFilesOutput` → `mockTakePresentFileOutput`(40-43、112-113、125),用例名(548-549),`name: 'DisplayFiles'` → `'PresentFile'`(557、562、599-600 的注释与用例名)
- `packages/zai/test/server/agentInboxIsMeta.test.ts`:72 `takePresentFileOutput: () => undefined,`

- [ ] **Step 8: 跑受影响测试**

```bash
cd packages/zn-agent-core && pnpm test test/unit/tools/presentFileOpencc.test.ts test/unit/mainAgents-office.test.ts test/unit/mainAgents-weixin.test.ts test/unit/mainAgents-toolFilters.test.ts
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm --filter @zn-ai/zai test test/server/mainAgents.test.ts test/server/agent.test.ts test/server/agentInboxIsMeta.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 9: 同步文档指向**

- `AGENTS.md:156`:`| PresentFile 单文件展示工具 | docs/superpowers/specs/2026-09-24-zai-present-file-design.md |`
- `docs/opencc-vendor-repl-execution.md:563`:`takeDisplayFilesOutput` → `takePresentFileOutput`

- [ ] **Step 10: 类型检查 + 提交**

```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm run build:core && pnpm -r exec tsc --noEmit
```
Expected: 无类型错误(`build:core` 会重建 bundle 与 `bundle-entry.d.ts`;`dist/opencc-src/server/displayFilesOpencc.d.ts` 应随删除消失)。

```bash
git add -A packages/zn-agent-core packages/zai/src/server/routes/agent.ts packages/zai/test/server AGENTS.md docs/opencc-vendor-repl-execution.md
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): DisplayFiles 收敛为单文件 PresentFile 工具"
```

---

### Task 2: 服务端 — `/api/fs/raw` 支持图片字节流

**Files:**
- Modify: `packages/zai/src/shared/fileKind.ts`(追加常量)
- Modify: `packages/zai/src/server/routes/fs.ts:1166-1241`
- Test: `packages/zai/test/server/routes/fs-raw.test.ts`

**Interfaces:**
- Produces: `GET /api/fs/raw?path=<abs>` 对 `image` kind 返回 200 + `Content-Type: image/png|image/svg+xml|…` + 原始字节;超过 `IMAGE_MAX_BYTES`(10 MiB)→ 413;非「文档类 ∪ 图片」扩展名仍 415
- Produces(常量):`IMAGE_MAX_BYTES`、`PREVIEW_TEXT_MAX_BYTES` 从 `shared/fileKind.ts` 导出
- Consumes: Task 1 无依赖

- [ ] **Step 1: 写失败测试**

在 `packages/zai/test/server/routes/fs-raw.test.ts` 的 `describe('GET /api/fs/raw', …)` 内追加:

```ts
  it('streams image bytes with the right Content-Type for .png', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const p = join(cwd, 'pixel.png');
    writeFileSync(p, png);
    const res = await request(app).get('/api/fs/raw').query({ path: p }).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(res.body as Buffer, png)).toBe(0);
  });

  it('serves .svg as image/svg+xml', async () => {
    const p = join(cwd, 'icon.svg');
    writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const res = await request(app).get('/api/fs/raw').query({ path: p });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
  });

  it('returns 413 for an image above IMAGE_MAX_BYTES (10 MiB)', async () => {
    const p = join(cwd, 'huge.png');
    writeFileSync(p, Buffer.alloc(0));
    truncateSync(p, 10 * 1024 * 1024 + 1);
    const res = await request(app).get('/api/fs/raw').query({ path: p });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('ETOOBIG');
  });

  it('still refuses non-image, non-document extensions with 415', async () => {
    const p = join(cwd, 'blob.zip');
    writeFileSync(p, 'PK');
    const res = await request(app).get('/api/fs/raw').query({ path: p });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('EUNSUPPORTED');
  });
```

> `truncateSync` 与 `binaryParser` 已在该文件顶部导入/定义,无需新增 import。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @zn-ai/zai test test/server/routes/fs-raw.test.ts
```
Expected: FAIL —— `.png` 用例得到 415(`EUNSUPPORTED`)。

- [ ] **Step 3: 加常量**

`packages/zai/src/shared/fileKind.ts` 的 `DOCUMENT_MAX_BYTES`(:88-93)之后追加:

```ts
/**
 * 图片内联 / 字节通道上限(byte)。前端内联 preflight 与 /api/fs/raw 共用同一份
 * —— 与 DOCUMENT_MAX_BYTES 同样的「一处定义、两侧引用」原则,避免漂移。
 */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024

/**
 * text / html 走 /api/fs/preview(JSON + base64)时的默认上限(byte)。
 * 前端内联 preflight 用它决定「要不要拉内容」,服务端用它做 413 判定。
 */
export const PREVIEW_TEXT_MAX_BYTES = 1_048_576
```

- [ ] **Step 4: 改 `/api/fs/raw`**

`packages/zai/src/server/routes/fs.ts:17-18` 的 import 增加两个符号:

```ts
import {
  classifyKind, DOCUMENT_MAX_BYTES, IMAGE_MAX_BYTES, isDocumentKind, isPreviewableKind, mimeFromExt,
} from '../../shared/fileKind.js';
```

把 `/fs/raw` 里从 `const kind = classifyKind(abs)`(:1177)到 413 上限判定结束(:1206)的整段替换为:

```ts
  const kind = classifyKind(abs)
  if (!isDocumentKind(kind) && kind !== 'image') {
    // 白名单同时保证 /fs/raw 不会退化成「任意文件下载口」。
    res.status(415).json({
      error: { code: 'EUNSUPPORTED', message: `该类型不走字节通道:${extname(abs) || '(无扩展名)'}` },
    } satisfies { error: FilePreviewError })
    return
  }
  let info
  try {
    info = await stat(abs)
  } catch (err) {
    mapStatError(res, err)
    return
  }
  if (info.isDirectory()) {
    res.status(400).json({ error: { code: 'EISDIR', message: '路径是目录' } } satisfies { error: FilePreviewError })
    return
  }
  const isImage = kind === 'image'
  const limit = Math.min(
    isImage ? IMAGE_MAX_BYTES : (DOCUMENT_MAX_BYTES[kind] ?? RAW_MAX_BYTES),
    RAW_MAX_BYTES,
  )
  if (info.size > limit) {
    res.status(413).json({
      error: {
        code: 'ETOOBIG',
        message: `文件 ${info.size} 字节,超过上限 ${limit}`,
        meta: { size: info.size },
      },
    } satisfies { error: FilePreviewError })
    return
  }
```

容器嗅探(:1207-1225)加一道图像豁免 —— 图片不经 OOXML 解析,`.svg` 等文本格式也照发:

```ts
  if (!isImage) {
    // 容器前置嗅探:加密的 .docx/.xlsx 和旧版 .doc/.xls/.ppt 都是 OLE,
    // 不拦就得让用户先下几十 MB 再在浏览器端报一个没头没尾的解析错误。
    let container: SniffedContainer
    try {
      container = sniffContainer(await readMagic(abs))
    } catch (err) {
      mapStatError(res, err)
      return
    }
    if (container === 'ole') {
      res.status(415).json({
        error: {
          code: 'EENCRYPTED_OR_LEGACY',
          message: '这是旧版二进制格式或受密码保护的文档,无法在浏览器内解析',
          container: 'ole',
        },
      } satisfies { error: FilePreviewError })
      return
    }
  }
  res.setHeader('Content-Type', isImage ? (mimeFromExt(abs) ?? 'application/octet-stream') : 'application/octet-stream')
```

其余(`Content-Length` / `X-File-Size` / `X-File-Mtime` / `Cache-Control` / `createReadStream` 流式下发)保持不变。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @zn-ai/zai test test/server/routes/fs-raw.test.ts
```
Expected: PASS(新增 4 例 + 原有文档类用例)。

- [ ] **Step 6: 提交**

```bash
git add packages/zai/src/shared/fileKind.ts packages/zai/src/server/routes/fs.ts packages/zai/test/server/routes/fs-raw.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): /api/fs/raw 支持图片字节流(10 MiB 上限)"
```

---

### Task 3: 服务端 — `/api/fs/preview` 图片超限回元数据

**Files:**
- Modify: `packages/zai/src/server/routes/fs.ts:1080-1102`
- Test: `packages/zai/test/server/routes/fs.preview.test.ts`

**Interfaces:**
- Produces: `GET /api/fs/preview?path=<img>` 对 `image` kind —— `size ≤ maxBytes` 仍回 `content`(base64);`size > maxBytes` 改为 **200 + `{kind,mime,size,mtime}`(无 `content`)**,不再 413。text/html 与其它 kind 的 413 行为不变。
- Consumes: Task 2 的 `PREVIEW_TEXT_MAX_BYTES`(仅命名对齐,行为不变)

- [ ] **Step 1: 写失败测试**

在 `packages/zai/test/server/routes/fs.preview.test.ts` 内追加:

```ts
  it('returns image metadata (no content, no 413) when the image exceeds the cap', async () => {
    const p = join(cwd, 'big.png');
    writeFileSync(p, Buffer.alloc(0));
    truncateSync(p, 1024 * 1024 + 1);
    const res = await request(app).get('/api/fs/preview').query({ path: p });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('image');
    expect(res.body.mime).toBe('image/png');
    expect(res.body.content).toBeUndefined();
    expect(res.body.size).toBe(1024 * 1024 + 1);
  });
```

该文件顶部 import 需补 `truncateSync`:

```ts
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @zn-ai/zai test test/server/routes/fs.preview.test.ts
```
Expected: FAIL —— 现状返回 413。

- [ ] **Step 3: 改路由**

`packages/zai/src/server/routes/fs.ts` —— 把图片分支移到共享 413 检查**之前**,并让它自己处理超限。`:1080-1102` 替换为:

```ts
  if (kind === 'image') {
    // 图片走「有内容就给 base64、超限只给元数据」——与文档类同一先例。
    // 前端的大图渲染走 /api/fs/raw 字节流(见 2026-09-24 PresentFile 设计),
    // 这里 413 只会让抽屉拿不到 size/mime 去渲染标题。
    const mime = mimeFromExt(abs) ?? 'application/octet-stream'
    if (info.size > maxBytes) {
      const payload: FilePreviewPayload = {
        kind,
        mime,
        size: info.size,
        mtime: info.mtimeMs,
      }
      res.json(payload)
      return
    }
    const buf = await readFile(abs)
    const payload: FilePreviewPayload = {
      kind,
      mime,
      content: buf.toString('base64'),
      size: info.size,
      mtime: info.mtimeMs,
    }
    res.json(payload)
    return
  }
  if (info.size > maxBytes) {
    res.status(413).json({
      error: {
        code: 'ETOOBIG',
        message: `文件 ${info.size} 字节,超过 ${maxBytes}`,
        meta: { size: info.size },
      },
    } satisfies { error: FilePreviewError })
    return
  }
```

同时删掉原来位于 413 检查**之后**的旧图片分支(`:1090-1102`)。

另把 `:1014` 的常量接到 shared 上,消除两处字面量:

```ts
import { PREVIEW_TEXT_MAX_BYTES } from '../../shared/fileKind.js';  // 并入既有 fileKind import 块
const PREVIEW_DEFAULT_MAX = PREVIEW_TEXT_MAX_BYTES
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @zn-ai/zai test test/server/routes/fs.preview.test.ts test/server/routes/fs-raw.test.ts test/server/routes/fs-file-html.test.ts
```
Expected: PASS(既有「.txt > 1 MiB → 413」「小 maxBytes clamp」等用例不受影响)。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/routes/fs.ts packages/zai/test/server/routes/fs.preview.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 fix(zai): 预览接口对超限图片回元数据而非 413"
```

---

### Task 4: 前端 — `FilePreviewBody` 内联变体 + 抽屉图片走字节流

**Files:**
- Modify: `packages/zai/src/web/src/components/desktop/FilePreviewBody.tsx`
- Modify: `packages/zai/src/web/src/components/conversation/FilePreviewDrawer.tsx:137-154`
- Test: `packages/zai/test/web/components/conversation/FilePreviewDrawer.test.tsx`

**Interfaces:**
- Produces:
  - `FilePreviewPayload` 新增 `rawUrl?: string`
  - `type FilePreviewVariant = 'drawer' | 'inline'`
  - `FilePreviewBody({ payload, variant }: { payload: FilePreviewPayload; variant?: FilePreviewVariant })` — `drawer` 为默认,4 个既有调用方零改动
  - 图片取值优先级 `rawUrl ?? dataUrl`;inline 时图片/iframe 高度 `max-h-[320px] md:max-h-[420px]` / `h-[320px] md:h-[420px]`,文本行数上限 20(`drawer` 仍 200)
- Consumes: Task 2 的 `/api/fs/raw` 图片通道

- [ ] **Step 1: 改抽屉测试(先失败)**

`packages/zai/test/web/components/conversation/FilePreviewDrawer.test.tsx` 的图片用例改成断言字节流 URL:

```tsx
  it('renders image via <img> pointing at the /api/fs/raw byte channel', async () => {
    mockFetch({ kind: 'image', mime: 'image/png', content: 'AAAA', size: 3, mtime: 0 })
    useAgentStore.setState({ filePreviewPath: '/a.png' })
    render(<FilePreviewDrawer />)
    // happy-dom doesn't infer implicit `img` role for HTMLImageElement, so
    // findByRole('img') matches the AntD close-icon span (role="img").
    // Query by alt text instead, which is unique to the actual <img>.
    const img = await screen.findByAltText('a.png')
    expect(img.tagName.toLowerCase()).toBe('img')
    expect(img.getAttribute('src')).toBe('/api/fs/raw?path=%2Fa.png')
  })

  it('renders a >1 MiB image from metadata-only preview payload', async () => {
    // Task 3 之后 /api/fs/preview 对超限图片返回元数据(无 content),
    // 抽屉仍要能显示图片 —— 靠 /api/fs/raw 字节通道。
    mockFetch({ kind: 'image', mime: 'image/png', size: 2 * 1024 * 1024, mtime: 0 })
    useAgentStore.setState({ filePreviewPath: '/huge.png' })
    render(<FilePreviewDrawer />)
    const img = await screen.findByAltText('huge.png')
    expect(img.getAttribute('src')).toBe('/api/fs/raw?path=%2Fhuge.png')
    expect(screen.getByText(/2.00 MB/)).toBeInTheDocument()
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @zn-ai/zai test test/web/components/conversation/FilePreviewDrawer.test.tsx
```
Expected: FAIL —— 现状 `src` 是 `data:image/png;base64,AAAA`。

- [ ] **Step 3: 改 `FilePreviewBody`**

`packages/zai/src/web/src/components/desktop/FilePreviewBody.tsx`:

(a) payload 类型加字段:

```ts
export type FilePreviewPayload = {
  kind: FilePreviewKind
  /** 完整路径(用于 ext 推断 → MarkdownText/CodeBlock 分支 + 语言检测;
   *  文档类 kind 同时是 /api/fs/raw 的取字节路径,必须是绝对路径) */
  path: string
  /** text/html mime(可选,image 必填) */
  mime?: string
  /** text 模式:UTF-8 内容;html 模式:UTF-8 内容(可选) */
  content?: string
  /** image 模式:base64 data URL(desktop 调用方走这条) */
  dataUrl?: string
  /** image 模式:原始字节通道 URL(`/api/fs/raw?path=…`)。与 dataUrl 二选一,
   *  两者都有时优先用 rawUrl —— 大图不必经 base64 解码,也不会被 1 MiB 挡住。 */
  rawUrl?: string
  size: number
  mtime: number | string
  /** binary 模式:扩展名前缀(eg. ".zip") */
  ext?: string
}

/** drawer = 右侧抽屉 / 浮窗(默认,沿用旧行为);inline = 对话流卡片内联。 */
export type FilePreviewVariant = 'drawer' | 'inline'
```

(b) 行数上限:

```ts
const PREVIEW_LINE_LIMIT = 200
/** inline 变体的代码/Markdown 默认展示行数 —— 卡内要短,展开全部仍在卡内。 */
const INLINE_LINE_LIMIT = 20
```

(c) `TextPreview` 接收 `lineLimit`:

```tsx
function TextPreview({ path, content, lineLimit }: { path: string; content: string; lineLimit: number }) {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const isMd = ext === 'md' || ext === 'markdown'
  const { head, truncated } = truncateLines(content, lineLimit)
  const [expanded, setExpanded] = useState(false)
  const display = !truncated || expanded ? content : head
  // …以下 MarkdownText / CodeBlock 两个分支保持原样
```

(d) `ImagePreview` 支持 rawUrl / inline / 加载失败:

```tsx
function ImagePreview({
  dataUrl,
  rawUrl,
  path,
  inline,
}: {
  dataUrl?: string
  rawUrl?: string
  path: string
  inline: boolean
}) {
  const [failed, setFailed] = useState(false)
  const name = path.split(/[\\/]/).pop() ?? path
  const src = rawUrl ?? dataUrl
  if (!src) return <Alert type="error" message="缺少图片数据" />
  if (failed) {
    return <Alert data-testid="preview-image-error" type="error" message="图片加载失败" />
  }
  return (
    <div data-testid="preview-image" className="flex justify-center">
      <img
        src={src}
        alt={name}
        onError={() => setFailed(true)}
        className={
          inline
            ? 'max-w-full max-h-[320px] md:max-h-[420px] object-contain rounded'
            : 'max-w-full max-h-[70vh] object-contain'
        }
      />
    </div>
  )
}
```

(e) `HtmlPreview` 支持 inline 高度:

```tsx
function HtmlPreview({ dataUrl, content, inline }: { dataUrl?: string; content?: string; inline: boolean }) {
  // 服务端 /fs/preview 返回 html 时 content 是 utf-8 字符串,
  // desktopFs 的 dataUrl 是 base64(text/html)。两种都接受。
  const src = dataUrl
  const srcDoc = !dataUrl ? content : undefined
  return (
    <iframe
      data-testid="preview-html"
      src={src}
      srcDoc={srcDoc}
      // allow-scripts 让预览的 HTML 能执行自身 JS(data:/srcDoc 文档处于独立
      // origin,不给 allow-same-origin,无法访问宿主页面)。与 FsTab 预览一致。
      sandbox="allow-scripts"
      title="html-preview"
      className={inline ? 'w-full h-[320px] md:h-[420px] border-0' : 'w-full h-full min-h-[320px] border-0'}
    />
  )
}
```

(f) 主体分派:

```tsx
export function FilePreviewBody({
  payload,
  variant = 'drawer',
}: {
  payload: FilePreviewPayload
  variant?: FilePreviewVariant
}) {
  const inline = variant === 'inline'
  switch (payload.kind) {
    case 'image':
      return (
        <ImagePreview
          dataUrl={payload.dataUrl}
          rawUrl={payload.rawUrl}
          path={payload.path}
          inline={inline}
        />
      )
    case 'html':
      return <HtmlPreview dataUrl={payload.dataUrl} content={payload.content} inline={inline} />
    case 'binary':
      return <BinaryPreview ext={payload.ext} path={payload.path} />
    case 'text':
      return payload.content != undefined
        ? (
          <TextPreview
            path={payload.path}
            content={payload.content}
            lineLimit={inline ? INLINE_LINE_LIMIT : PREVIEW_LINE_LIMIT}
          />
        )
        : <Alert type="error" message="缺少文本内容" />
    case 'docx':
    case 'sheet':
    case 'ppt':
    case 'pdf':
    case 'legacy-office':
      // 文档类的字节不在 payload 里 —— DocumentPreview 自己按 path 走
      // /api/fs/raw(见 components/documentPreview/index.tsx)。
      return <DocumentPreview path={payload.path} kind={payload.kind} />
  }
}
```

- [ ] **Step 4: 改抽屉的图片构造**

`packages/zai/src/web/src/components/conversation/FilePreviewDrawer.tsx:137-154` —— 把渲染分支里那段 `(() => { … })()` 的**函数体**(从 `const dataUrl = …` 到 `return <FilePreviewBody payload={payload} />`)整体替换为:

```tsx
        // image 的字节走 /api/fs/raw(能看 > 1 MiB 的大图,也省一次 base64
        // 解码);content 只在 ≤ 1 MiB 时由 /api/fs/preview 回带,dataUrl 保留
        // 作为 desktop 调用方的回退。text / html 仍从 content 渲染。
        const isImage = wire.kind === 'image'
        const dataUrl = isImage && wire.content
          ? `data:${wire.mime ?? 'application/octet-stream'};base64,${wire.content}`
          : undefined
        const rawUrl = isImage
          ? `/api/fs/raw?path=${encodeURIComponent(path!)}`
          : undefined
        const payload: FilePreviewPayload = {
          kind: wire.kind,
          path: path!,
          mime: wire.mime,
          content: wire.content,
          dataUrl,
          rawUrl,
          size: wire.size,
          mtime: wire.mtime,
          ext: wire.ext,
        }
        return <FilePreviewBody payload={payload} />
```

即整段保持原有的 IIFE 外形(`})() : (() => { … })()`),只换函数体。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @zn-ai/zai test test/web/components/conversation/FilePreviewDrawer.test.tsx test/web/components/documentPreview/index.test.tsx src/web/src/components/splitPane/FsTab.test.tsx src/web/src/pages/Desktop.test.tsx
```
Expected: PASS(desktop / FsTab 的 `dataUrl` 调用方未受影响)。

- [ ] **Step 6: 提交**

```bash
git add packages/zai/src/web/src/components/desktop/FilePreviewBody.tsx packages/zai/src/web/src/components/conversation/FilePreviewDrawer.tsx packages/zai/test/web/components/conversation/FilePreviewDrawer.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 预览管线支持字节流图片与 inline 变体"
```

---

### Task 5: 前端 — PresentFileCard 骨架与交互

本任务交付「能替代旧卡片」的最小可用版本:头部 / 元数据 / caption / 错误态 / ↗ / 📂 / 文档与二进制的说明行。图片与文本的内联内容在 Task 6 接上。

**Files:**
- Create: `packages/zai/src/web/src/components/toolRenderers/presentFile.tsx`
- Delete: `packages/zai/src/web/src/components/toolRenderers/fileDisplay.tsx`
- Delete: `packages/zai/test/web/components/toolRenderers/fileDisplay.test.tsx`
- Modify: `packages/zai/src/web/src/components/toolRenderers/registry.ts:9,15`
- Create: `packages/zai/test/web/components/toolRenderers/presentFile.test.tsx`
- Modify: `packages/zai/src/web/src/components/transcript/MessageListView.test.tsx:128-218`
  (只改夹具名 + 两条用例 —— 删掉 `fileDisplay.tsx` 后这两条会变红;**混合组**那条保持旧期望不动,留给 Task 7 翻)

**Interfaces:**
- Produces: `presentFileRenderer: ToolRenderer`(`skipOuterGroup: true`,`renderFull(msg)`);`parsePresented(msg): PresentedFile[]`(模块内,只认单文件 shape `{file, caption}`);`PresentedFile = { path, name, size, mtime, kind: FilePreviewKind, error?, caption? }`
- Consumes: Task 4 的 `FilePreviewBody` / `FilePreviewPayload`;`useFilePathActions`(`src/web/src/hooks/useFilePathActions.js`);`callFsCommand`(`src/web/src/lib/openFilePath.js`)

- [ ] **Step 1: 写失败测试**

创建 `packages/zai/test/web/components/toolRenderers/presentFile.test.tsx`:

```tsx
// @vitest-environment happy-dom
import '@testing-library/jest-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'

// ↗ 走 useFilePathActions → lib/openFilePath 的 /fs/resolve 链路;测试里
// 只关心「点 ↗ 会触发预览入口」,把整条链路 mock 成可控 spy。
const previewSpy = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../../../src/web/src/hooks/useFilePathActions.js', () => ({
  useFilePathActions: () => ({
    preview: previewSpy,
    pickerOpen: false,
    setPickerOpen: () => {},
    pickerCandidates: [],
    pickCandidate: () => {},
    menuItems: [],
  }),
}))

import { presentFileRenderer } from '../../../../src/web/src/components/toolRenderers/presentFile.js'

function makeMsg(file: Record<string, unknown>, caption?: string) {
  // wire shape: 工具输出 JSON 字符串,包了 Anthropic 风格 content block
  // { content: [{ type: 'json', json: { file, caption } }] }。浏览器侧
  // useAgentStore 把它存到 msg.output(字符串)。
  return {
    type: 'tool_use:done' as const,
    toolUseId: 'tu-1',
    name: 'PresentFile',
    input: { path: file.path, caption },
    output: JSON.stringify({ content: [{ type: 'json', json: { file, caption } }] }),
  } as any
}

describe('presentFileRenderer.renderFull', () => {
  beforeEach(() => previewSpy.mockClear())

  it('renders name, size, path and caption', () => {
    const msg = makeMsg(
      { path: '/tmp/report.html', name: 'report.html', size: 2048, mtime: 0, kind: 'html' },
      '刚生成的季度报告',
    )
    const { container } = render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(screen.getByText('report.html')).toBeInTheDocument()
    expect(container.textContent).toContain('2.0 KB')
    expect(container.textContent).toContain('/tmp/report.html')
    expect(container.textContent).toContain('刚生成的季度报告')
  })

  it('hides caption when absent', () => {
    const msg = makeMsg({ path: '/tmp/a.ts', name: 'a.ts', size: 10, mtime: 0, kind: 'text' })
    const { container } = render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(container.querySelector('[data-testid="present-file-caption"]')).toBeNull()
  })

  it('shows a red tag and disables the ↗ button for errored files', () => {
    const msg = makeMsg({
      path: '/nope.txt', name: 'nope.txt', size: 0, mtime: 0, kind: 'binary',
      error: { code: 'ENOENT', message: 'not found' },
    })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(screen.getByText('文件不存在')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '大尺寸预览' })).toBeDisabled()
  })

  it('keeps 打开目录 enabled for errored files', () => {
    const msg = makeMsg({
      path: '/nope.txt', name: 'nope.txt', size: 0, mtime: 0, kind: 'binary',
      error: { code: 'ENOENT', message: 'not found' },
    })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(screen.getByRole('button', { name: '打开目录' })).toBeEnabled()
  })

  it('triggers the preview action on ↗ click', () => {
    const msg = makeMsg({ path: '/tmp/a.ts', name: 'a.ts', size: 10, mtime: 0, kind: 'text' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    fireEvent.click(screen.getByRole('button', { name: '大尺寸预览' }))
    expect(previewSpy).toHaveBeenCalledTimes(1)
  })

  it('opens the file manager through the resolve → reveal chain on 打开目录 click', async () => {
    // 📂 走 lib/openFilePath 的 callFsCommand:先 POST /api/fs/resolve 解析路径,
    // 再 POST /api/fs/reveal —— 两步都要 mock 成成功,否则解析失败不会发 reveal。
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input)
      if (url.includes('/api/fs/resolve')) {
        return { ok: true, status: 200, json: async () => ({ ok: 'exact', abs: '/tmp/a.ts' }) } as any
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as any
    })
    const msg = makeMsg({ path: '/tmp/a.ts', name: 'a.ts', size: 10, mtime: 0, kind: 'text' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    fireEvent.click(screen.getByRole('button', { name: '打开目录' }))
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/fs/reveal',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    fetchSpy.mockRestore()
  })

  it('disables ↗ for images above 10 MiB', () => {
    const msg = makeMsg({
      path: '/tmp/huge.png', name: 'huge.png', size: 10 * 1024 * 1024 + 1, mtime: 0, kind: 'image',
    })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(screen.getByRole('button', { name: '大尺寸预览' })).toBeDisabled()
  })

  it('renders a doc type notice instead of inline content for documents', () => {
    const msg = makeMsg({ path: '/tmp/r.pdf', name: 'r.pdf', size: 1024, mtime: 0, kind: 'pdf' })
    const { container } = render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(container.textContent).toContain('PDF 文档')
    expect(screen.getByRole('button', { name: '大尺寸预览' })).toBeEnabled()
  })

  it('renders a notice for binary and disables ↗', () => {
    const msg = makeMsg({ path: '/tmp/a.zip', name: 'a.zip', size: 100, mtime: 0, kind: 'binary' })
    const { container } = render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(container.textContent).toContain('不支持内联预览')
    expect(screen.getByRole('button', { name: '大尺寸预览' })).toBeDisabled()
  })

  it('renders one card per file for the single-file wire shape', () => {
    const msg = makeMsg({ path: '/a.ts', name: 'a.ts', size: 100, mtime: 0, kind: 'text' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getAllByTestId('present-file-card')).toHaveLength(1)
  })

  it('returns null when the output carries no file', () => {
    const msg = { type: 'tool_use:done', output: 'done' } as any
    expect(presentFileRenderer.renderFull!(msg)).toBeNull()
  })
})

describe('presentFileRenderer.preview', () => {
  it('summarizes the presented path', () => {
    expect(presentFileRenderer.preview({ path: '/tmp/a.ts' } as any)).toBe('展示 a.ts')
  })
})

describe('presentFileRenderer.skipOuterGroup', () => {
  it('标记为 true,让 compact 视图不把卡片塞进工具组卡', () => {
    expect(presentFileRenderer.skipOuterGroup).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @zn-ai/zai test test/web/components/toolRenderers/presentFile.test.tsx
```
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写卡片骨架**

创建 `packages/zai/src/web/src/components/toolRenderers/presentFile.tsx`:

```tsx
/**
 * presentFileRenderer — PresentFile 工具的 React 渲染。
 *
 * 工具一次展示一个文件(设计见
 * docs/superpowers/specs/2026-09-24-zai-present-file-design.md):卡片在对话流内
 * 直接渲染内容,右上角 ↗ 复用现有预览链路(/fs/resolve → 分屏 / 桌面浮窗 /
 * FilePreviewDrawer)开大尺寸预览。走 renderFull 整块接管渲染(与 Edit/Write 的
 * diffRenderer 同模式)。
 *
 * 只在 registry 里注册 PresentFile(不保留旧名 DisplayFiles 别名 —— 执行期裁决),
 * parsePresented 因此只认单文件 shape `{ file, caption }`。
 */
import React from 'react'
import { Card, Tag, Tooltip, Typography } from 'antd'
import IconButton from '../IconButton.js'
import {
  ArrowUpRightIcon,
  CodeIcon,
  FileImageIcon,
  FileQuestionIcon,
  FileTextIcon,
  FileTypeIcon,
  FolderOpenIcon,
} from 'lucide-react'
import type { ToolRenderer } from './types.js'
import { IMAGE_MAX_BYTES, PREVIEW_TEXT_MAX_BYTES, type FilePreviewKind } from '@shared/fileKind.js'
import { useFilePathActions } from '../../hooks/useFilePathActions.js'
import { callFsCommand } from '../../lib/openFilePath.js'

type FileErrorCode = 'ENOENT' | 'EACCES' | 'EISDIR' | 'EPERM' | 'EBUSY' | 'ELOOP'

type PresentedFile = {
  path: string
  name: string
  size: number
  mtime: number
  kind: FilePreviewKind
  error?: { code: FileErrorCode; message: string }
  caption?: string
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function errorLabel(code: string): string {
  switch (code) {
    case 'ENOENT': return '文件不存在'
    case 'EACCES':
    case 'EPERM': return '无权限'
    case 'EISDIR': return '是目录'
    case 'ETOOBIG': return '文件过大'
    default: return code
  }
}

function kindIcon(kind: FilePreviewKind): React.ReactNode {
  switch (kind) {
    case 'text': return <FileTextIcon />
    case 'image': return <FileImageIcon />
    case 'html': return <CodeIcon />
    case 'docx':
    case 'sheet':
    case 'ppt':
    case 'pdf':
    case 'legacy-office': return <FileTypeIcon />
    default: return <FileQuestionIcon />
  }
}

function kindLabel(kind: FilePreviewKind): string {
  switch (kind) {
    case 'docx': return 'Word 文档'
    case 'sheet': return '表格'
    case 'ppt': return '演示文稿'
    case 'pdf': return 'PDF 文档'
    case 'legacy-office': return '旧版 / 不支持格式的文档'
    case 'binary': return '二进制文件'
    default: return ''
  }
}

/**
 * 解析单文件 wire shape:`{ file, caption }`。
 * 返回数组是为了 renderFull 的 map 统一 —— 单文件工具恒定 0 或 1 张卡。
 */
function parsePresented(msg: any): PresentedFile[] {
  const out = msg?.output
  if (typeof out !== 'string') return []
  try {
    const wrapper = JSON.parse(out)
    const block = Array.isArray(wrapper?.content) ? wrapper.content[0] : null
    const json = block?.json
    if (!json) return []
    const caption = typeof json.caption === 'string' ? json.caption : undefined
    if (json.file && typeof json.file.path === 'string') {
      return [{ ...json.file, caption }]
    }
    return []
  } catch {
    return []
  }
}

/** 该文件能否内联渲染内容(大小 / 错误 / 类型三重判定)。 */
function inlineStatus(file: PresentedFile): 'ok' | 'toolarge' | 'unsupported' {
  if (file.kind === 'text' || file.kind === 'html') {
    return file.size <= PREVIEW_TEXT_MAX_BYTES ? 'ok' : 'toolarge'
  }
  if (file.kind === 'image') {
    return file.size <= IMAGE_MAX_BYTES ? 'ok' : 'toolarge'
  }
  return 'unsupported'
}

function PresentedFileCard({ file }: { file: PresentedFile }) {
  // 只取用到的四个 —— menuItems / setPickerOpen 留给"本轮产物"块与路径 chip
  // 使用(卡片只暴露 ↗ 与 📂,不做右键菜单)。
  const { preview, pickerOpen, pickerCandidates, pickCandidate } =
    useFilePathActions(file.path)
  const status = inlineStatus(file)
  // ↗ 的可用性:错误态、二进制、以及 > 10 MiB 的图片都禁用(大图连抽屉也读不到
  // —— /api/fs/raw 同样卡 10 MiB,给它一个打不开的入口不如直接说清楚)。
  const canPreview =
    !file.error &&
    file.kind !== 'binary' &&
    !(status === 'toolarge' && file.kind === 'image')

  const previewTooltip = file.error
    ? errorLabel(file.error.code)
    : file.kind === 'binary'
      ? '二进制文件,无法预览'
      : status === 'toolarge' && file.kind === 'image'
        ? '图片超过 10 MiB,请在文件管理器中打开'
        : status === 'toolarge'
          ? '文件较大,打开大尺寸预览'
          : '大尺寸预览'

  return (
    <Card size="small" className="mb-2" data-testid="present-file-card" data-file-path={file.path}>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[var(--text-secondary)]">{kindIcon(file.kind)}</span>
          <Typography.Text strong className="!text-[13px] truncate">
            {file.name}
          </Typography.Text>
          {file.error && <Tag color="error">{errorLabel(file.error.code)}</Tag>}
          <span className="ml-auto flex items-center gap-1 shrink-0">
            <Tooltip title={previewTooltip}>
              <IconButton
                size="small"
                aria-label="大尺寸预览"
                icon={<ArrowUpRightIcon />}
                disabled={!canPreview}
                onClick={() => void preview()}
              />
            </Tooltip>
            <Tooltip title="打开目录">
              <IconButton
                size="small"
                aria-label="打开目录"
                icon={<FolderOpenIcon />}
                onClick={() => void callFsCommand('reveal', file.path).then((r) => {
                  // 不留静默失败(spec §6.6):失败用 message.error 告知
                  if (!r.ok) message.error(r.error)
                })}
              />
            </Tooltip>
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--text-dim-65)]">
          <span>{humanSize(file.size)}</span>
          {file.mtime > 0 && <span>{new Date(file.mtime).toLocaleString()}</span>}
          <Typography.Text
            type="secondary"
            className="!text-xs"
            ellipsis={{ tooltip: file.path }}
          >
            {file.path}
          </Typography.Text>
        </div>
        {file.caption && (
          <div
            data-testid="present-file-caption"
            className="text-xs italic text-[var(--text-secondary)]"
          >
            {file.caption}
          </div>
        )}
        <PresentedFileBody file={file} status={status} />
      </div>
      {pickerOpen && (
        <div
          data-testid="file-path-picker"
          className="mt-1 flex flex-col gap-[2px] max-h-[280px] overflow-auto"
        >
          <div className="text-xs text-[var(--text-dim-70)] px-1 py-1">
            找到 {pickerCandidates.length} 个匹配,选择要预览的文件:
          </div>
          {pickerCandidates.map((c) => (
            <button
              key={c.abs}
              type="button"
              className="text-left text-xs px-2 py-1 rounded hover:bg-[var(--bg-faint-05)] font-[ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace]"
              onClick={(e) => {
                e.stopPropagation()
                pickCandidate(c)
              }}
            >
              {c.rel}
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}

/** 不可内联时的说明文案(二进制 / 旧版文档 / 文档类 / 超大文件)。 */
function inlineNotice(file: PresentedFile, status: 'toolarge' | 'unsupported'): string {
  if (file.kind === 'binary') return '此文件类型不支持内联预览'
  if (file.kind === 'legacy-office') return '旧版 / 不支持的文档格式 · 点击右上角 ↗ 查看详情'
  if (status === 'toolarge') {
    // 超大图片的 ↗ 也是禁用的(字节通道同样卡 10 MiB),所以不给"点 ↗"的指引。
    return file.kind === 'image'
      ? '图片超过 10 MiB,请在文件管理器中打开'
      : '文件较大,点击右上角 ↗ 预览'
  }
  return `${kindLabel(file.kind)} · 点击右上角 ↗ 预览`
}

/** 非内联 kind 的说明行(图片 / 文本 / HTML 的内容在 Task 6 接上)。 */
function PresentedFileBody({ file, status }: { file: PresentedFile; status: 'ok' | 'toolarge' | 'unsupported' }) {
  if (file.error) return null
  if (status === 'ok') return null
  return (
    <div className="text-xs text-[var(--text-dim-65)]">{inlineNotice(file, status)}</div>
  )
}

export const presentFileRenderer: ToolRenderer = {
  // 自包含展示类工具:collapsed 视图下不进 ToolGroupCard 外壳
  // (MessageListView 的 splitToolGroupEntries 据此摘出)。
  skipOuterGroup: true,
  preview(input) {
    const p = input.path
    if (typeof p !== 'string' || p.length === 0) return ''
    return `展示 ${p.split(/[\\/]/).pop() ?? p}`
  },
  renderFull(msg) {
    const files = parsePresented(msg)
    if (files.length === 0) return null
    return (
      <div data-testid="present-file-list">
        {files.map((f) => (
          <PresentedFileCard key={f.path} file={f} />
        ))}
      </div>
    )
  },
}
```

> 本任务只交付卡片骨架与交互;图片 / 文本 / HTML 的内联内容在 Task 6 接上。
> 候选多匹配的 picker 直接渲染在卡内(与「本轮产物」块的 picker 同形),
> 右键菜单(在文件管理器中显示 / 复制路径)保留给 Markdown 路径 chip,
> 卡片本身只暴露 ↗ 与 📂 两个按钮。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @zn-ai/zai test test/web/components/toolRenderers/presentFile.test.tsx
```
Expected: PASS。

- [ ] **Step 5: 注册 renderer 并删除旧文件**

`packages/zai/src/web/src/components/toolRenderers/registry.ts`:

```ts
import { presentFileRenderer } from "./presentFile.js"
```

```ts
const registry: Record<string, ToolRenderer> = {
  Agent: agentRenderer,
  Bash: bashRenderer,
  // 只注册新名 —— 不保留旧名 DisplayFiles 别名(执行期裁决:不留兼容 shim;
  // 历史 transcript 里的旧名消息走 genericRenderer)。
  PresentFile: presentFileRenderer,
  // Edit / Write 走 DiffBlock 一体渲染 (整接管 renderFull), 不再各自写输入/输出.
  Edit: diffRenderer,
  Glob: globRenderer,
  Grep: grepRenderer,
  Read: readRenderer,
  Write: diffRenderer,
}
```

```bash
git rm packages/zai/src/web/src/components/toolRenderers/fileDisplay.tsx \
       packages/zai/test/web/components/toolRenderers/fileDisplay.test.tsx
```

- [ ] **Step 6: 把 MessageListView 的两条旧用例改成新工具名(否则删掉 fileDisplay.tsx 后会变红)**

`packages/zai/src/web/src/components/transcript/MessageListView.test.tsx` 的 `describe("MessageListView — skipOuterGroup 路由", …)` 里:

1. 把 `displayFilesDone(toolUseId)` 夹具改名为 `presentFileDone(toolUseId)` 并换成单文件 shape:

```tsx
  function presentFileDone(toolUseId: string): AgentMessage {
    return toolMsg(
      "tool_use:done",
      toolUseId,
      "PresentFile",
      { path: "/a.ts" },
      JSON.stringify({
        content: [
          {
            type: "json",
            json: {
              file: { path: "/a.ts", name: "a.ts", size: 100, mtime: 0, kind: "text" },
              caption: "刚生成的产物",
            },
          },
        ],
      }),
    )
  }
```

2. 用例「collapsed: DisplayFiles toolGroup 跳过 ToolGroupCard 外壳…」改为:

```tsx
  test("collapsed: PresentFile toolGroup 跳过 ToolGroupCard 外壳, 直接渲染文件卡", () => {
    collapsed.value = true
    const { container } = render(<MessageListView messages={[presentFileDone("tu-pf-1")]} />)
    expect(container.querySelector(".ant-card-head")).not.toBeInTheDocument()
    expect(screen.queryByText(/个工具调用/)).not.toBeInTheDocument()
    expect(screen.getByTestId("present-file-card")).toBeInTheDocument()
    expect(screen.getByText("a.ts")).toBeInTheDocument()
  })
```

3. 用例「collapsed: pending DisplayFiles 仍渲染 ToolGroupCard」改为:

```tsx
  test("collapsed: pending PresentFile 仍渲染 ToolGroupCard (状态优先)", () => {
    collapsed.value = true
    const { container } = render(
      <MessageListView
        messages={[toolMsg("tool_use:start", "tu-pf-1", "PresentFile", { path: "/a.ts" })]}
      />,
    )
    expect(container.querySelector(".ant-card-head")).toBeInTheDocument()
    expect(screen.getByText(/个工具调用/)).toBeInTheDocument()
    expect(screen.queryByTestId("present-file-card")).toBeNull()
  })
```

4. **混合组那条用例(「DisplayFiles + Bash 混合 toolGroup 整组回退到 ToolGroupCard」)保持旧期望不动** —— Task 7 引入分段摘出后才翻,归 Task 7 改。

- [ ] **Step 7: 跑测试确认通过**

```bash
pnpm --filter @zn-ai/zai test test/web/components/toolRenderers/presentFile.test.tsx src/web/src/components/transcript/MessageListView.test.tsx
```
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add packages/zai/src/web/src/components/toolRenderers packages/zai/test/web/components/toolRenderers packages/zai/src/web/src/components/transcript/MessageListView.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): PresentFile 卡片骨架与 ↗ 预览入口"
```

---

### Task 6: 前端 — 卡片内联内容渲染

**Files:**
- Modify: `packages/zai/src/web/src/components/toolRenderers/presentFile.tsx`
- Test: `packages/zai/test/web/components/toolRenderers/presentFile.test.tsx`

**Interfaces:**
- Produces: 卡片内联区 —— `image` → `<img src="/api/fs/raw?path=…">`;`text`/`html` → 一次 `/api/fs/preview` + `<FilePreviewBody variant="inline">`;失败给一行提示 + `[重试]`
- Consumes: Task 4 的 `FilePreviewBody`(`variant='inline'`、`payload.rawUrl`);Task 2/3 的服务端通道

- [ ] **Step 1: 写失败测试**

在 `presentFile.test.tsx` 追加:

```tsx
describe('presentFileRenderer 内联渲染', () => {
  beforeEach(() => previewSpy.mockClear())

  it('renders an inline <img> straight from the byte channel for images (no fetch)', () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const msg = makeMsg({ path: '/tmp/pixel.png', name: 'pixel.png', size: 2048, mtime: 0, kind: 'image' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    const img = screen.getByAltText('pixel.png')
    expect(img.getAttribute('src')).toBe('/api/fs/raw?path=%2Ftmp%2Fpixel.png')
    // 图片有元数据即可渲染,不需要预取内容
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('falls back to a notice for images above 10 MiB', () => {
    const msg = makeMsg({
      path: '/tmp/huge.png', name: 'huge.png', size: 10 * 1024 * 1024 + 1, mtime: 0, kind: 'image',
    })
    const { container } = render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(screen.queryByAltText('huge.png')).toBeNull()
    expect(container.textContent).toContain('图片超过 10 MiB')
  })

  it('fetches /api/fs/preview and renders inline code for text files', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ kind: 'text', mime: 'text/plain', content: 'const x = 1\n', size: 12, mtime: 0 }),
    } as any)
    const msg = makeMsg({ path: '/tmp/a.ts', name: 'a.ts', size: 12, mtime: 0, kind: 'text' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(await screen.findByTestId('preview-code')).toBeInTheDocument()
    expect(screen.getByText(/const x = 1/)).toBeInTheDocument()
  })

  it('renders inline iframe for html files', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ kind: 'html', mime: 'text/html', content: '<h1>x</h1>', size: 8, mtime: 0 }),
    } as any)
    const msg = makeMsg({ path: '/tmp/p.html', name: 'p.html', size: 8, mtime: 0, kind: 'html' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    const iframe = await screen.findByTestId('preview-html')
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
  })

  it('does not fetch content for text files above 1 MiB', () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const msg = makeMsg({
      path: '/tmp/big.ts', name: 'big.ts', size: 1024 * 1024 + 1, mtime: 0, kind: 'text',
    })
    const { container } = render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(container.textContent).toContain('文件较大')
    fetchSpy.mockRestore()
  })

  it('shows an inline error with retry when the preview fetch fails', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 413,
      json: async () => ({ error: { code: 'ETOOBIG', message: '文件过大' } }),
    } as any)
    const msg = makeMsg({ path: '/tmp/a.ts', name: 'a.ts', size: 12, mtime: 0, kind: 'text' })
    render(<>{presentFileRenderer.renderFull!(msg)}</>)
    expect(await screen.findByTestId('present-file-inline-error')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @zn-ai/zai test test/web/components/toolRenderers/presentFile.test.tsx
```
Expected: FAIL —— 新增用例找不到 `preview-code` / `preview-html` / `<img>`。

- [ ] **Step 3: 实现内联区**

先把 `presentFile.tsx` 顶部的 import 扩成内联所需(React hooks、`Button`、`FilePreviewBody`):

```tsx
import React, { useEffect, useState } from 'react'
import { Button, Card, Tag, Tooltip, Typography } from 'antd'
// …其余 import 不变
import { FilePreviewBody, type FilePreviewPayload } from '../desktop/FilePreviewBody.js'
```

再追加 hook 与内联体,并把 `PresentedFileBody` 换成完整版:

```tsx
/** 拉取 text / html 的内容(图片不需要 —— 字节由 /api/fs/raw 直供)。 */
function usePreviewContent(path: string, enabled: boolean) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [payload, setPayload] = useState<FilePreviewPayload | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      setError(null)
      setPayload(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setPayload(null)
    fetch(`/api/fs/preview?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (cancelled) return
        if (!r.ok) {
          setError(body?.error?.message ?? `HTTP ${r.status}`)
        } else {
          setPayload(body as FilePreviewPayload)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [path, enabled, nonce])

  return { loading, error, payload, retry: () => setNonce((n) => n + 1) }
}

function PresentedFileBody({
  file,
  status,
}: {
  file: PresentedFile
  status: 'ok' | 'toolarge' | 'unsupported'
}) {
  // 图片:元数据足够,字节由 /api/fs/raw 直接给 <img>,不必预取。
  // text / html:需要内容,按需 fetch(超限则完全不发请求)。
  const needsFetch = status === 'ok' && (file.kind === 'text' || file.kind === 'html')
  const { loading, error, payload, retry } = usePreviewContent(file.path, needsFetch)

  if (file.error) return null

  if (status !== 'ok') {
    return (
      <div className="text-xs text-[var(--text-dim-65)]">{inlineNotice(file, status)}</div>
    )
  }

  if (file.kind === 'image') {
    return (
      <FilePreviewBody
        variant="inline"
        payload={{
          kind: 'image',
          path: file.path,
          rawUrl: `/api/fs/raw?path=${encodeURIComponent(file.path)}`,
          size: file.size,
          mtime: file.mtime,
        }}
      />
    )
  }

  if (loading) {
    return (
      <div data-testid="present-file-inline-loading" className="py-1 text-xs text-[var(--text-dim-65)]">
        加载中…
      </div>
    )
  }
  if (error) {
    return (
      <div
        data-testid="present-file-inline-error"
        className="flex items-center gap-2 text-xs text-[var(--text-dim-65)]"
      >
        <span className="truncate">{error}</span>
        <Button size="small" type="link" onClick={retry}>
          重试
        </Button>
      </div>
    )
  }
  if (!payload) return null

  return (
    <FilePreviewBody
      variant="inline"
      payload={{
        kind: payload.kind,
        path: file.path,
        mime: payload.mime,
        content: payload.content,
        size: payload.size,
        mtime: payload.mtime,
        ext: payload.ext,
      }}
    />
  )
}
```

同时删掉 Task 5 骨架里那段占位的同名 `PresentedFileBody`(只保留这一份)。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @zn-ai/zai test test/web/components/toolRenderers/presentFile.test.tsx
```
Expected: PASS(含 Task 5 的全部用例)。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm -r exec tsc --noEmit
```
Expected: 无错误(未使用的 import 需清掉)。

```bash
git add packages/zai/src/web/src/components/toolRenderers/presentFile.tsx packages/zai/test/web/components/toolRenderers/presentFile.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): PresentFile 卡片内联渲染图片/HTML/文本"
```

---

### Task 7: 前端 — 混合工具组中摘出 PresentFile

**Files:**
- Modify: `packages/zai/src/web/src/components/transcript/MessageListView.tsx:12-39,169-203`
- Modify: `packages/zai/src/web/src/components/transcript/MessageListView.test.tsx:128-218`

**Interfaces:**
- Produces: `splitToolGroupEntries(entries: ToolGroupEntry[]): GroupSegment[]`,其中 `GroupSegment = { kind: 'inline' | 'card'; entries: ToolGroupEntry[] }` —— 按 `getRenderer(name).skipOuterGroup === true && status === 'done'` 保序分段
- Consumes: Task 5 的 `presentFileRenderer.skipOuterGroup`(夹具 `presentFileDone` 与「跳过外壳 / pending 保留外壳」两条用例已在 Task 5 改好,本任务只翻混合组那条)

- [ ] **Step 1: 改测试(先失败)**

把 `MessageListView.test.tsx` 里**唯一**那条混合组用例改成新期望(Task 5 已把夹具与另两条用例改好):

```tsx
  test("collapsed: PresentFile + Bash 混合 toolGroup 被拆成「组卡 + 文件卡」", () => {
    collapsed.value = true
    const { container } = render(
      <MessageListView
        messages={[
          toolMsg("tool_use:start", "tu-bash-1", "Bash", { command: "ls" }),
          toolMsg("tool_use:done", "tu-bash-1", "Bash", undefined, "ok"),
          presentFileDone("tu-pf-1"),
        ]}
      />,
    )
    // Bash 仍进组卡 —— 夹具含 Bash 的 start + done 两条,deriveTranscriptNodes
    // 不合并配对,所以摘出 PresentFile 后组卡是「2 个」;断言 2(而非改造前的 3)
    // 即证明摘出生效。文件卡独立内联。
    expect(container.querySelector(".ant-card-head")).toBeInTheDocument()
    expect(screen.getByText(/2 个工具调用/)).toBeInTheDocument()
    expect(screen.getByTestId("present-file-card")).toBeInTheDocument()
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/transcript/MessageListView.test.tsx
```
Expected: FAIL —— 混合组用例仍得到单个「3 个工具调用」组卡、无文件卡。

- [ ] **Step 3: 实现分段**

`MessageListView.tsx` 用分段替换「全有或全无」判定(:12-39):

```tsx
// toolGroup 内的 status 是否需要保留 ToolGroupCard 外壳(展示状态提示)。
// pending/error/invalid/denied 都保留外壳。
const STATUS_KEEPS_SHELL: ReadonlySet<ToolGroupStatus> = new Set([
  'pending',
  'error',
  'invalid',
  'denied',
])

/** 同一 toolGroup 拆出来的渲染段:inline 直接内联,card 进 ToolGroupCard。 */
type GroupSegment =
  | { kind: 'inline'; entries: ToolGroupEntry[] }
  | { kind: 'card'; entries: ToolGroupEntry[] }

/**
 * 把 toolGroup 的条目按「是否自包含展示工具」切成保序段。
 *
 * 判定单条粒度(与旧 shouldSkipOuterGroup 同规则,但不再要求整组一致):
 * - renderer.skipOuterGroup === true 且 status === 'done' → inline
 * - 其余(含 pending/error/invalid/denied,以及未标标记的工具)→ card
 *
 * 这样「模型一轮里先 Read 再 PresentFile」不会因为组内有别的工具而把
 * 文件卡整组吞进折叠卡(2026-09-24 PresentFile 设计 §7)。
 */
function splitToolGroupEntries(entries: ToolGroupEntry[]): GroupSegment[] {
  const segs: GroupSegment[] = []
  for (const e of entries) {
    const name = (e.message as { name?: unknown }).name
    const selfContained =
      typeof name === 'string' &&
      name.length > 0 &&
      getRenderer(name).skipOuterGroup === true &&
      !STATUS_KEEPS_SHELL.has(e.status)
    const kind: GroupSegment['kind'] = selfContained ? 'inline' : 'card'
    const last = segs[segs.length - 1]
    if (last && last.kind === kind) last.entries.push(e)
    else segs.push({ kind, entries: [e] })
  }
  return segs
}
```

collapsed 分支的 toolGroup 渲染(:169-203)改为:

```tsx
        if (node.kind === 'toolGroup') {
          // 外层 Fragment 必须带 key —— 它在下面的 flatMap 里会被放进数组
          // ([el] 或 [el, ...产物块]),无 key 会触发 React 的列表 key 警告。
          el = (
            <React.Fragment
              key={`grp-${node.toolCalls[0]?.message.eventId ?? node.startIndex}`}
            >
              {splitToolGroupEntries(node.toolCalls).map((seg) => {
                // key 用段内首条 entry 的 eventId(而非下标区间):新消息 append
                // 不改变已有段的 key → 不重挂载,组卡折叠态与卡内展开态都不丢。
                const firstId =
                  ((seg.entries[0]?.message as any).eventId as string) ??
                  `seg-${seg.entries[0]?.index ?? 0}`
                if (seg.kind === 'inline') {
                  return (
                    <span key={`seg-inline-${firstId}`}>
                      {seg.entries.map((e) => {
                        const evtId = ((e.message as any).eventId as string) ?? `tool-${e.index}`
                        return (
                          <MessageBubble
                            key={evtId}
                            msg={e.message}
                            streaming={e.status === 'pending'}
                          />
                        )
                      })}
                    </span>
                  )
                }
                return <ToolGroupCard key={`seg-card-${firstId}`} entries={seg.entries} />
              })}
            </React.Fragment>
          )
        } else if (node.kind === 'thinking') {
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/transcript/MessageListView.test.tsx test/web/transcript/ToolGroupCard.test.tsx
```
Expected: PASS(既有跳过外壳 / Bash 组卡 / 本轮产物块用例全部保持绿色)。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/components/transcript/MessageListView.tsx packages/zai/src/web/src/components/transcript/MessageListView.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 fix(zai): 混合工具组中摘出 PresentFile 卡片,不再被折叠卡吞掉"
```

---

### Task 8: 真实浏览器验收(需先征得用户同意)

**Files:** 无代码改动(验证任务)

**Interfaces:**
- Consumes: Task 1-7 的全部产物

- [ ] **Step 1: 询问用户**

按 AGENTS.md「真实浏览器验收(非必须,先询问)」:先问用户是否现在跑 ego-browser 验收;用户确认后再继续。**不要 kill 920x 端口上的服务进程。**

- [ ] **Step 2: 重建 core 并起独立端口 dev**

```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy
lsof -i :8102 -i :7715   # 先确认空闲;被占用就换端口,不要静默递增
pnpm run build:core
pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715
```

- [ ] **Step 3: 逐项走用户路径(用 ego-browser)**

1. 准备素材:`/tmp/pf/` 下放一张小 PNG、一张 **> 1 MiB** 的大图、一个 `.html`、一个 `.md`、一个 `.ts`、一个 `.pdf`、一个 `.zip`。
2. 在 `/agent` 依次让 Agent 调 PresentFile 展示上述文件,逐项确认:
   - 图片在卡内直接显示(大图也显示),尺寸不超过渲染区、`object-contain`;
   - HTML iframe 高度正确、可滚动,`sandbox="allow-scripts"`;
   - `.md` 走 Markdown 渲染、`.ts` 走语法高亮,默认 20 行 + 「展开全部」在卡内展开;
   - `.pdf` 只给「PDF 文档 · 点击右上角 ↗ 预览」说明行;`.zip` 给「不支持内联预览」且 ↗ disabled;
   - caption 显示在元数据行下方。
3. 点 ↗ → 桌面端右侧 720px 抽屉 → 点宽度全屏 → 大图 / PDF / HTML 正常;Esc 关闭。
4. 到 `/m` 路由重复一次(底部抽屉、卡内联布局在窄屏下不溢出)。
5. 混合场景:同一轮里让 Agent 先 Read 再 PresentFile → 「1 个工具调用 · Read」组卡与文件卡**并列**出现。
6. 失败路径:展示一个不存在的路径(卡片红 Tag「文件不存在」+ ↗ disabled)、一个目录(「是目录」)。
7. 每项留证据:`rect` / `getComputedStyle` 数值或截图对比(AGENTS.md:样式类改动不以 happy-dom 单测结论为准)。

- [ ] **Step 4: 报告结论**

把「已验证项 / 未验证项 / 环境阻塞」写清楚,不要用「应该没问题」代替证据。若发现样式问题,回到 Task 5/6 修完再重跑本任务。

---

## 附:本计划的边界

- `packages/zai/test/web/components/conversation/FilePreviewDrawer.test.tsx` 里既有「docx/sheet/ppt/pdf 外派 DocumentPreview」等用例**不动**(Task 3 后 `/api/fs/preview` 仍对文档类回元数据)。
- 历史 spec / plan(`docs/superpowers/specs/2026-08-20-display-files-tool-design.md`、`plans/2026-08-20-display-files-tool-plan.md`)是记录,不追溯改写;只在 `AGENTS.md` 文档入口表指向新 spec。
- 不做内容快照(不把图片/文本塞进 `tool_result`)、不做「文件已变更」提示、不做卡内全屏切换 —— 见 spec §2「不做」。