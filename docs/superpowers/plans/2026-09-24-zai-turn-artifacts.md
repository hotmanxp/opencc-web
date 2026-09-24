# zai Web UI 对话「本轮产物」块 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 每轮对话结束后，在该轮消息段末尾渲染一个「本轮产物」块，列出本轮生成/修改的文件，点击任一行复用现有预览链路打开文件。

**Architecture:** 纯前端渲染期派生。新增一个无副作用的纯函数 `deriveTurnArtifacts` 从 `useAgentStore.messages` 按 `user.text` 切分轮次并提取写入类工具的文件路径；`MessageListView` 的 expanded / collapsed 两个渲染分支按「该轮最后一条消息的下标」查表插入 `<TurnArtifactsBlock>`。预览动作（resolve → 打开 / 多候选 picker / 右键菜单）从 `FilePathChip` 抽成 `useFilePathActions` hook 供两处共用。

**Tech Stack:** TypeScript 5.6 · React 18.3 · Zustand · AntD 5.22 · Tailwind 3.4 · Vitest 4.1 + happy-dom + @testing-library/react

**Spec:** `docs/superpowers/specs/2026-09-24-zai-turn-artifacts-design.md`

## Global Constraints

- **不动后端、不动 `packages/zn-agent-core/`**：本计划全部改动在 `packages/zai/src/web/` 与 `packages/zai/test/`，**不需要** `pnpm run build:core`。
- **样式一律 Tailwind utility class**：禁止新增 `style={{...}}`。CSS 变量走 arbitrary value（`text-[var(--text-primary)]`、`bg-[var(--bg-faint-05)]`）。仅 `AGENTS.md` 列出的 7 类合法场景例外（运行时计算值 / `calc()`+`env()` / AntD `styles` 语义槽位 / 事件驱动 DOM 修改 / keyframes / `writingMode`+复杂 `backdropFilter`+SVG 内联属性 / AntD 单组件 `style`）。
- **UI 文案用中文**；本计划不新增任何 LLM 系统提示词。
- **测试粒度**：只跑被改动的测试文件，禁止 `pnpm -r test` 全量。
- **样式改动不用单测当门禁**：本计划最后一节走真实浏览器验收（`AGENTS.md` 规则）。
- **commit 格式**：`HRMSV3-ZN-WEBSITE#668 <type>(scope): 描述`。
- **happy-dom 限制**：不渲染真实 CSS cascade、读不到 React 写入的 inline style、不做布局计算。测试只断言渲染行为与文字，不断言样式值。
- **启动 dev 前先 `lsof -i :<port>` 确认端口空闲**；显式指定端口被占用会 EADDRINUSE 退出，不要静默换端口。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/zai/src/web/src/components/transcript/deriveTurnArtifacts.ts` | Create | 轮次切分 + 产物提取纯函数、`ArtifactFile` / `TurnArtifacts` 类型、写入类工具白名单 |
| `packages/zai/src/web/src/hooks/useFilePathActions.tsx` | Create | 「点开一个文件路径」的动作复用层：resolve → 打开 / 多候选 picker / 右键菜单 |
| `packages/zai/src/web/src/components/transcript/TurnArtifactsBlock.tsx` | Create | 产物块组件（块头 + 文件行） |
| `packages/zai/src/web/src/components/markdown/FilePathChip.tsx` | Modify | 动作逻辑改为调用 `useFilePathActions`，渲染分支不变 |
| `packages/zai/src/web/src/components/transcript/MessageListView.tsx` | Modify | 两个渲染分支按锚点下标插入产物块 |
| `packages/zai/test/web/transcript/deriveTurnArtifacts.test.ts` | Create | 纯函数单测 |
| `packages/zai/test/web/transcript/TurnArtifactsBlock.test.tsx` | Create | 组件测 |
| `packages/zai/test/web/markdown/FilePathChip.test.tsx` | Create | hook 抽取后的行为回归测（该类原无测试） |
| `packages/zai/src/web/src/components/transcript/MessageListView.test.tsx` | Modify | store mock 补 `status` 字段 + 新增产物块插入用例 |

---

### Task 1: `deriveTurnArtifacts` 纯函数

**Files:**
- Create: `packages/zai/src/web/src/components/transcript/deriveTurnArtifacts.ts`
- Test: `packages/zai/test/web/transcript/deriveTurnArtifacts.test.ts`

**Interfaces:**
- Consumes: `AgentMessage` / `AgentStatus`（`packages/zai/src/web/src/store/useAgentStore.ts` 已有导出，:94 与 :96）
- Produces:
  - `ARTIFACT_WRITE_TOOLS: Readonly<Record<string, { label: string; pathKey: string }>>`
  - `interface ArtifactFile { path: string; label: string; count: number; written: boolean }`
  - `interface TurnArtifacts { endIndex: number; turnKey: string; files: ArtifactFile[] }`
  - `function deriveTurnArtifacts(messages: AgentMessage[], opts: { status: AgentStatus }): TurnArtifacts[]`

- [ ] **Step 1: 写失败的测试**

创建 `packages/zai/test/web/transcript/deriveTurnArtifacts.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentStatus } from '../../../src/web/src/store/useAgentStore.js'
import {
  ARTIFACT_WRITE_TOOLS,
  deriveTurnArtifacts,
} from '../../../src/web/src/components/transcript/deriveTurnArtifacts.js'

// Lightweight factory — only fields the derivation reads.
function userMsg(eventId: string, text: string): AgentMessage {
  return { type: 'user.text', text, eventId, sessionId: 's1', ts: 1, turnIndex: 0 } as AgentMessage
}

function toolMsg(
  type: string,
  name: string,
  input: Record<string, unknown>,
): AgentMessage {
  return {
    type,
    name,
    input,
    eventId: `evt-${name}-${type}-${JSON.stringify(input)}`,
    sessionId: 's1',
    ts: 1,
    turnIndex: 0,
  } as unknown as AgentMessage
}

function assistantMsg(eventId: string, text: string): AgentMessage {
  return { type: 'assistant.text', text, eventId, sessionId: 's1', ts: 1, turnIndex: 0 } as AgentMessage
}

const idle: AgentStatus = 'idle'

describe('deriveTurnArtifacts — 轮次切分', () => {
  it('无 user.text 时返回空数组', () => {
    const msgs = [assistantMsg('a1', 'hi'), toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' })]
    expect(deriveTurnArtifacts(msgs, { status: idle })).toEqual([])
  })

  it('单轮:锚点 = 该轮最后一条消息的下标', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
      assistantMsg('a1', 'done'),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out).toHaveLength(1)
    expect(out[0]!.endIndex).toBe(2)
    expect(out[0]!.turnKey).toBe('u1')
  })

  it('多轮:每轮各自的锚点与 turnKey', () => {
    const msgs = [
      userMsg('u1', 'first'),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
      assistantMsg('a1', 'done1'),
      userMsg('u2', 'second'),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/b.ts' }),
      assistantMsg('a2', 'done2'),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out.map((t) => [t.endIndex, t.turnKey])).toEqual([[2, 'u1'], [5, 'u2']])
    expect(out[0]!.files.map((f) => f.path)).toEqual(['/tmp/a.ts'])
    expect(out[1]!.files.map((f) => f.path)).toEqual(['/tmp/b.ts'])
  })

  it('产物只含本轮文件,不跨轮累加', () => {
    const msgs = [
      userMsg('u1', 'first'),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
      userMsg('u2', 'second'),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/b.ts' }),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out[1]!.files.map((f) => f.path)).toEqual(['/tmp/b.ts'])
  })

  it('数组被裁剪后不以 user.text 开头时,开头那段残留消息不产出', () => {
    // 对应 spec §3.5:AgentConversation 按 maxVisibleMessages 裁剪后,
    // 老轮次的锚点可能整个落到可视区之外 —— 被切掉头部的残段没有 user.text
    // 作为起点,不构成一轮,自然不渲染产物块。
    const msgs = [
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
      assistantMsg('a1', 'done'),
      userMsg('u2', 'second'),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/b.ts' }),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out).toHaveLength(1)
    expect(out[0]!.files.map((f) => f.path)).toEqual(['/tmp/b.ts'])
  })
})

describe('deriveTurnArtifacts — 结算时机', () => {
  it('最后一轮处于 streaming 时不产出', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
    ]
    expect(deriveTurnArtifacts(msgs, { status: 'streaming' })).toEqual([])
  })

  it('被下一轮顶掉的轮次即使仍在 streaming 也产出', () => {
    const msgs = [
      userMsg('u1', 'first'),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
      userMsg('u2', 'second'),
    ]
    const out = deriveTurnArtifacts(msgs, { status: 'streaming' })
    expect(out).toHaveLength(1)
    expect(out[0]!.turnKey).toBe('u1')
  })

  it('aborted / error 轮次照常产出', () => {
    const msgs = [userMsg('u1', 'go'), toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' })]
    expect(deriveTurnArtifacts(msgs, { status: 'aborted' })).toHaveLength(1)
    expect(deriveTurnArtifacts(msgs, { status: 'error' })).toHaveLength(1)
  })

  it('没有文件改动的轮次不产出', () => {
    const msgs = [userMsg('u1', 'hi'), assistantMsg('a1', 'hello')]
    expect(deriveTurnArtifacts(msgs, { status: idle })).toEqual([])
  })
})

describe('deriveTurnArtifacts — 提取规则', () => {
  it('白名单只含写入类工具', () => {
    expect(Object.keys(ARTIFACT_WRITE_TOOLS).sort()).toEqual([
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Write',
    ])
  })

  it('只读工具(Read / Grep / Glob)不计入', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Read', { file_path: '/tmp/a.ts' }),
      toolMsg('tool_use:start', 'Grep', { path: '/tmp' }),
      toolMsg('tool_use:start', 'Glob', { path: 'src/**/*.ts' }),
      assistantMsg('a1', 'done'),
    ]
    expect(deriveTurnArtifacts(msgs, { status: idle })).toEqual([])
  })

  it('NotebookEdit 取 notebook_path', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'NotebookEdit', { notebook_path: '/tmp/n.ipynb' }),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out[0]!.files[0]).toMatchObject({ path: '/tmp/n.ipynb', label: '编辑', written: false })
  })

  it('tool_use:done / tool_use:error 也计入(input 仍在)', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:done', 'Write', { file_path: '/tmp/a.ts' }),
      toolMsg('tool_use:error', 'Edit', { file_path: '/tmp/b.ts' }),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out[0]!.files.map((f) => f.path)).toEqual(['/tmp/a.ts', '/tmp/b.ts'])
  })

  it('路径为空串或非字符串时跳过', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Write', { file_path: '' }),
      toolMsg('tool_use:start', 'Edit', { file_path: 42 }),
      toolMsg('tool_use:start', 'Write', {}),
    ]
    expect(deriveTurnArtifacts(msgs, { status: idle })).toEqual([])
  })
})

describe('deriveTurnArtifacts — 去重与徽标', () => {
  it('同一路径合并一行,保持首次出现顺序,count 累加', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/b.ts' }),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/a.ts' }),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/b.ts' }),
    ]
    const out = deriveTurnArtifacts(msgs, { status: idle })
    expect(out[0]!.files).toEqual([
      { path: '/tmp/b.ts', label: '编辑', count: 2, written: false },
      { path: '/tmp/a.ts', label: '编辑', count: 1, written: false },
    ])
  })

  it('出现过 Write 就是「写入」徽标,与出现顺序无关', () => {
    const writeFirst = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/a.ts' }),
    ]
    expect(deriveTurnArtifacts(writeFirst, { status: idle })[0]!.files[0]).toMatchObject({
      label: '写入',
      written: true,
      count: 2,
    })

    const writeLast = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Edit', { file_path: '/tmp/a.ts' }),
      toolMsg('tool_use:start', 'Write', { file_path: '/tmp/a.ts' }),
    ]
    expect(deriveTurnArtifacts(writeLast, { status: idle })[0]!.files[0]).toMatchObject({
      label: '写入',
      written: true,
      count: 2,
    })
  })

  it('路径原样保留,不做规范化(不同写法视为两个条目)', () => {
    const msgs = [
      userMsg('u1', 'go'),
      toolMsg('tool_use:start', 'Edit', { file_path: 'src/a.ts' }),
      toolMsg('tool_use:start', 'Edit', { file_path: './src/a.ts' }),
    ]
    expect(deriveTurnArtifacts(msgs, { status: idle })[0]!.files).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm --filter @zn-ai/zai test test/web/transcript/deriveTurnArtifacts.test.ts
```
Expected: FAIL — `Failed to resolve import ".../deriveTurnArtifacts.js"`（文件尚不存在）。

- [ ] **Step 3: 写最小实现**

创建 `packages/zai/src/web/src/components/transcript/deriveTurnArtifacts.ts`：

```ts
/**
 * deriveTurnArtifacts —— 从 transcript 的 AgentMessage[] 派生「每一轮改了哪些文件」。
 *
 * 纯函数、无副作用、不读 store —— 数据源就是 useAgentStore.messages，
 * 因此 SSE 实时流与刷新后的历史回放走的是同一条路径,派生结果天然一致。
 * 设计见 docs/superpowers/specs/2026-09-24-zai-turn-artifacts-design.md。
 */
import type { AgentMessage, AgentStatus } from '../../store/useAgentStore.js'

/**
 * 写入类工具白名单 —— 只有这些工具的调用会计入「本轮产物」。
 *
 * 不能用「input 里有 path / file_path 就算」的泛化规则: Read / Grep / Glob
 * 同样带 path 字段,泛化会把只读调用误报成产物。新增写入类工具时在这里加一行。
 */
export const ARTIFACT_WRITE_TOOLS: Readonly<
  Record<string, { label: string; pathKey: string }>
> = {
  Write: { label: '写入', pathKey: 'file_path' },
  Edit: { label: '编辑', pathKey: 'file_path' },
  MultiEdit: { label: '编辑', pathKey: 'file_path' },
  NotebookEdit: { label: '编辑', pathKey: 'notebook_path' },
}

/** 携带工具调用 input 的消息类型 —— start 是首次出现,done/error 是同一 entry 被 tool_result 覆盖后的形态。 */
const TOOL_TYPES: ReadonlySet<string> = new Set([
  'tool_use:start',
  'tool_use:done',
  'tool_use:error',
])

export interface ArtifactFile {
  /** 工具输入里的路径原文,未做规范化 —— 解析交给点击时的 /api/fs/resolve */
  path: string
  /** 展示徽标文案 */
  label: string
  /** 本轮出现次数(UI 在 > 1 时显示 ×N) */
  count: number
  /** 该路径本轮是否出现过 Write —— 驱动徽标配色 */
  written: boolean
}

export interface TurnArtifacts {
  /** 该轮最后一条消息在传入数组中的下标(产物块的锚点) */
  endIndex: number
  /** 该轮首条 user.text 的 eventId —— 用作 React key,保证新消息到达不重置折叠态 */
  turnKey: string
  files: ArtifactFile[]
}

function pathOf(msg: AgentMessage): Omit<ArtifactFile, 'count'> | null {
  if (!TOOL_TYPES.has(String(msg.type))) return null
  const name = (msg as { name?: unknown }).name
  if (typeof name !== 'string') return null
  const spec = ARTIFACT_WRITE_TOOLS[name]
  if (!spec) return null
  const input = (msg as { input?: unknown }).input
  if (input === null || typeof input !== 'object') return null
  const raw = (input as Record<string, unknown>)[spec.pathKey]
  if (typeof raw !== 'string' || raw.length === 0) return null
  return { path: raw, label: spec.label, written: name === 'Write' }
}

export function deriveTurnArtifacts(
  messages: AgentMessage[],
  opts: { status: AgentStatus },
): TurnArtifacts[] {
  const out: TurnArtifacts[] = []
  // 当前轮区间: start 指向该轮首条 user.text 的下标,-1 表示尚未进入任何一轮
  let start = -1
  let turnKey = ''

  const finalize = (end: number, closed: boolean) => {
    if (start < 0 || !closed || end < start) return
    const files: ArtifactFile[] = []
    const byPath = new Map<string, ArtifactFile>()
    for (let i = start; i <= end; i++) {
      const hit = pathOf(messages[i]!)
      if (!hit) continue
      const existing = byPath.get(hit.path)
      if (existing) {
        existing.count += 1
        // 该路径本轮只要出现过 Write,徽标就是「写入」(与出现顺序无关)
        if (hit.written) {
          existing.written = true
          existing.label = '写入'
        }
        continue
      }
      const file: ArtifactFile = { ...hit, count: 1 }
      byPath.set(hit.path, file)
      files.push(file)
    }
    if (files.length > 0) out.push({ endIndex: end, turnKey, files })
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (String(m.type) === 'user.text') {
      // 上一轮在 i - 1 结束,且已被新轮顶掉 → 视为已结束
      finalize(i - 1, true)
      start = i
      turnKey = String((m as { eventId?: unknown }).eventId ?? `turn-${i}`)
    }
  }
  // 最后一轮:只有不在流式中才算结束(aborted / error / idle 都算)
  finalize(messages.length - 1, opts.status !== 'streaming')

  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm --filter @zn-ai/zai test test/web/transcript/deriveTurnArtifacts.test.ts
```
Expected: PASS — 16 个用例全绿。

- [ ] **Step 5: 类型检查**

Run:
```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy/packages/zai && pnpm exec tsc --noEmit -p tsconfig.json
```
Expected: 无新增错误。（若 `tsconfig.json` 不含 `test/`，此步只覆盖 `src/`；测试文件的类型由 vitest 运行时校验。）

- [ ] **Step 6: Commit**

```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy
git add packages/zai/src/web/src/components/transcript/deriveTurnArtifacts.ts \
        packages/zai/test/web/transcript/deriveTurnArtifacts.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 新增 deriveTurnArtifacts 派生每轮产物文件列表"
```

---

### Task 2: 抽取 `useFilePathActions`（含 `FilePathChip` 回归测试）

**Files:**
- Create: `packages/zai/src/web/src/hooks/useFilePathActions.tsx`
- Modify: `packages/zai/src/web/src/components/markdown/FilePathChip.tsx`（全文重写，渲染分支与类名逐字保留）
- Test: `packages/zai/test/web/markdown/FilePathChip.test.tsx`

**Interfaces:**
- Consumes: `openFilePathPreview` / `callFsCommand` / `FILE_PREVIEW_OPEN_EVENT` / `FilePreviewOpenDetail` / `FsResolveCandidate`（`packages/zai/src/web/src/lib/openFilePath.ts`，已在 :21-129 定义）
- Produces:
  - `interface FilePathActions`（下述）
  - `function useFilePathActions(path: string): FilePathActions`
    - `preview(e?: { stopPropagation: () => void }): Promise<void>`
    - `pickerOpen: boolean` / `setPickerOpen(open: boolean): void`
    - `pickerCandidates: FsResolveCandidate[]`
    - `pickCandidate(candidate: FsResolveCandidate): void`
    - `menuItems: MenuProps['items']`

> **为什么是 `.tsx`**：`menuItems` 携带 JSX 图标。`src/web/src/hooks/` 目前全是 `.ts`，这是该目录第一个 `.tsx` hook，属预期。

- [ ] **Step 1: 写失败的回归测试**

创建 `packages/zai/test/web/markdown/FilePathChip.test.tsx`：

```tsx
// @vitest-environment happy-dom
// 抽取 useFilePathActions 之前 FilePathChip 没有测试。这个文件是行为回归护栏:
// 抽取后 chip 的 resolve / 多候选 picker / 右键菜单必须与抽取前逐位一致。
import { describe, expect, test, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { message } from 'antd'
import { FilePathChip } from '../../../src/web/src/components/markdown/FilePathChip.js'

const openFilePathPreview = vi.hoisted(() => vi.fn())
const callFsCommand = vi.hoisted(() => vi.fn())

vi.mock('../../../src/web/src/lib/openFilePath.js', () => ({
  FILE_PREVIEW_OPEN_EVENT: 'zai:file-preview-open',
  openFilePathPreview,
  callFsCommand,
}))

// pickCandidate 会写 store 并派 window 事件 —— 这里只验证 picker 弹出,
// 不做候选点击,因此只需要一个不会在渲染期被调用的 store stub。
vi.mock('../../../src/web/src/store/useAgentStore.js', () => ({
  useAgentStore: Object.assign(() => undefined, {
    getState: () => ({ openFilePreview: vi.fn() }),
  }),
}))

beforeEach(() => {
  openFilePathPreview.mockReset()
  callFsCommand.mockReset()
})

describe('FilePathChip', () => {
  test('命中唯一路径时直接打开预览,不弹 picker', async () => {
    openFilePathPreview.mockResolvedValue({ ok: 'exact', abs: '/abs/a.ts' })
    render(<FilePathChip path="src/a.ts" />)
    fireEvent.click(screen.getByTestId('file-path-chip'))
    await waitFor(() => expect(openFilePathPreview).toHaveBeenCalledWith('src/a.ts'))
    expect(screen.queryByTestId('file-path-picker')).not.toBeInTheDocument()
  })

  test('命中多个候选时弹出 picker,列出全部候选', async () => {
    openFilePathPreview.mockResolvedValue({
      ok: 'multiple',
      candidates: [
        { abs: '/p1/a.ts', rel: 'p1/a.ts' },
        { abs: '/p2/a.ts', rel: 'p2/a.ts' },
      ],
    })
    render(<FilePathChip path="a.ts" />)
    fireEvent.click(screen.getByTestId('file-path-chip'))
    expect(await screen.findByTestId('file-path-picker')).toBeInTheDocument()
    expect(screen.getAllByTestId('file-path-picker-item')).toHaveLength(2)
  })

  test('解析失败时 message.error,不弹 picker', async () => {
    const errSpy = vi.spyOn(message, 'error').mockImplementation(() => undefined as never)
    openFilePathPreview.mockResolvedValue({ ok: false, code: 'ENOENT', error: '文件不存在' })
    render(<FilePathChip path="nope.ts" />)
    fireEvent.click(screen.getByTestId('file-path-chip'))
    await waitFor(() => expect(errSpy).toHaveBeenCalledWith('文件不存在'))
    expect(screen.queryByTestId('file-path-picker')).not.toBeInTheDocument()
    errSpy.mockRestore()
  })

  test('右键菜单含预览 / 在文件管理器中显示 / 在终端中打开 / 复制路径', async () => {
    render(<FilePathChip path="src/a.ts" />)
    fireEvent.contextMenu(screen.getByTestId('file-path-chip'))
    expect(await screen.findByText('预览')).toBeInTheDocument()
    expect(screen.getByText('在文件管理器中显示')).toBeInTheDocument()
    expect(screen.getByText('在终端中打开')).toBeInTheDocument()
    expect(screen.getByText('复制路径')).toBeInTheDocument()
  })

  test('右键「在文件管理器中显示」走 callFsCommand(reveal)', async () => {
    callFsCommand.mockResolvedValue({ ok: true, abs: '/abs/a.ts' })
    render(<FilePathChip path="src/a.ts" />)
    fireEvent.contextMenu(screen.getByTestId('file-path-chip'))
    fireEvent.click(await screen.findByText('在文件管理器中显示'))
    await waitFor(() => expect(callFsCommand).toHaveBeenCalledWith('reveal', 'src/a.ts'))
  })
})
```

> 注：本文件不需要额外 import `FsResolveResult` —— 断言全部走 `mockResolvedValue` 传入的对象字面量，类型由 `vi.fn()` 的 `any` 承接。

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm --filter @zn-ai/zai test test/web/markdown/FilePathChip.test.tsx
```
Expected: FAIL — `Failed to resolve import ".../FilePathChip.js"`（chip 存在，但若 mock 的模块路径解析不到会先报错）。确认失败原因是「测试文件尚未能跑通」而非「断言不成立」。

- [ ] **Step 3: 创建 `useFilePathActions`**

创建 `packages/zai/src/web/src/hooks/useFilePathActions.tsx`（动作逻辑从 `FilePathChip.tsx:29-117` 原样搬过来）：

```tsx
/**
 * useFilePathActions —— 「点开一个文件路径」的动作复用层。
 *
 * 从 markdown/FilePathChip 抽出,供两处共用:
 *   1. Markdown 正文/行内代码里识别出的路径 chip
 *   2. 对话「本轮产物」块的文件行
 * 两处的预览语义必须一致(同一个 /fs/resolve 入口、同一套多候选 picker、
 * 同一个右键菜单),所以动作逻辑只能有一份。
 *
 * 路径解析由服务端 /api/fs/resolve 完成,细节见 lib/openFilePath.ts。
 */
import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { message, type MenuProps } from 'antd'
import { CodeIcon, CopyIcon, EyeIcon, FolderIcon } from 'lucide-react'
import { useAgentStore } from '../store/useAgentStore.js'
import {
  FILE_PREVIEW_OPEN_EVENT,
  callFsCommand,
  openFilePathPreview,
  type FilePreviewOpenDetail,
  type FsResolveCandidate,
} from '../lib/openFilePath.js'

export interface FilePathActions {
  /** 打开预览。传入点击事件时会先 stopPropagation,避免被外层整块点击(折叠/展开)吃掉。 */
  preview: (e?: Pick<ReactMouseEvent, 'stopPropagation'>) => Promise<void>
  /** 命中多个候选时的 picker 开合态(受控) */
  pickerOpen: boolean
  setPickerOpen: (open: boolean) => void
  pickerCandidates: FsResolveCandidate[]
  pickCandidate: (candidate: FsResolveCandidate) => void
  /** 右键菜单项:预览 / 在文件管理器中显示 / 在终端中打开 / 复制路径 */
  menuItems: MenuProps['items']
}

export function useFilePathActions(path: string): FilePathActions {
  const [busy, setBusy] = useState(false)
  // 命中多个候选时打开的 picker —— 受控,触发源是 preview() 的解析结果
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerCandidates, setPickerCandidates] = useState<FsResolveCandidate[]>([])

  const preview = useCallback(
    async (e?: Pick<ReactMouseEvent, 'stopPropagation'>) => {
      // 消息气泡外层可能有整块点击(折叠/展开),别让它把这次点击吃掉
      e?.stopPropagation()
      if (busy) return
      // 已开着候选弹层时再点 → 开关切换(直接收起,不重新 resolve 闪旧列表)
      if (pickerOpen) {
        setPickerOpen(false)
        return
      }
      setBusy(true)
      try {
        const result = await openFilePathPreview(path)
        if (result.ok === 'multiple') {
          setPickerCandidates(result.candidates)
          setPickerOpen(true)
        } else if (!result.ok) {
          message.error(result.error)
          setPickerOpen(false)
        }
      } finally {
        setBusy(false)
      }
    },
    [path, busy, pickerOpen],
  )

  const pickCandidate = useCallback((candidate: FsResolveCandidate) => {
    setPickerOpen(false)
    const detail: FilePreviewOpenDetail = { path: candidate.abs }
    window.dispatchEvent(
      new CustomEvent<FilePreviewOpenDetail>(FILE_PREVIEW_OPEN_EVENT, { detail }),
    )
    if (!detail.handled) useAgentStore.getState().openFilePreview(candidate.abs)
  }, [])

  const fsCommand = useCallback(
    (cmd: 'reveal' | 'open-terminal', okText: string) => {
      void callFsCommand(cmd, path).then((r) => {
        if (r.ok) message.success(okText)
        else message.error(r.error)
      })
    },
    [path],
  )

  const menuItems = useMemo<MenuProps['items']>(
    () => [
      {
        key: 'preview',
        icon: <EyeIcon />,
        label: '预览',
        onClick: () => {
          void preview()
        },
      },
      { type: 'divider' as const },
      {
        key: 'reveal',
        icon: <FolderIcon />,
        label: '在文件管理器中显示',
        onClick: () => fsCommand('reveal', '已在文件管理器中打开'),
      },
      {
        key: 'open-terminal',
        icon: <CodeIcon />,
        label: '在终端中打开',
        onClick: () => fsCommand('open-terminal', '已打开终端'),
      },
      { type: 'divider' as const },
      {
        key: 'copy',
        icon: <CopyIcon />,
        label: '复制路径',
        onClick: () => {
          navigator.clipboard
            .writeText(path)
            .then(() => message.success('已复制路径'))
            .catch(() => message.warning('复制失败,请手动选中'))
        },
      },
    ],
    [path, fsCommand, preview],
  )

  return { preview, pickerOpen, setPickerOpen, pickerCandidates, pickCandidate, menuItems }
}
```

- [ ] **Step 4: 改写 `FilePathChip.tsx` 调用 hook**

用以下内容**整体替换** `packages/zai/src/web/src/components/markdown/FilePathChip.tsx`（渲染结构与类名与改动前逐字一致，只把动作逻辑换成 hook）：

```tsx
/**
 * FilePathChip —— Markdown 正文 / 行内代码里识别出的文件路径。
 *
 * 点击 → 走 /fs/resolve 多级解析;命中 1 个直接打开预览,命中多个弹候选选择器,
 * 全无则 message.error。右键 → 预览 / 在文件管理器中显示 / 在终端中打开 /
 * 复制路径(后两个也是先 resolve 再走 /fs/{reveal|open-terminal})。
 *
 * 检测逻辑在 lib/filePathDetect.ts,服务端 cascade 在 lib/openFilePath.ts,
 * 动作编排在 hooks/useFilePathActions.tsx —— 这里只负责渲染 chip 外壳。
 */
import React from 'react'
import { Dropdown, Popover } from 'antd'
import { FileTextIcon } from 'lucide-react'
import { useFilePathActions } from '../../hooks/useFilePathActions.js'

function FilePathChipInner({ path }: { path: string }) {
  const { preview, pickerOpen, setPickerOpen, pickerCandidates, pickCandidate, menuItems } =
    useFilePathActions(path)

  const pickerContent = (
    <div
      data-testid="file-path-picker"
      className="flex flex-col gap-[2px] max-h-[280px] overflow-auto"
    >
      <div className="text-xs text-[var(--text-dim-70,#888)] px-1 py-1">
        找到 {pickerCandidates.length} 个匹配,选择要预览的文件:
      </div>
      {pickerCandidates.map((c) => (
        <button
          key={c.abs}
          type="button"
          data-testid="file-path-picker-item"
          data-file-path={c.abs}
          className="text-left text-xs px-2 py-1 rounded hover:bg-[var(--bg-faint-05)] font-[ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace] text-[var(--text-primary,#ddd)]"
          onClick={(e) => {
            e.stopPropagation()
            pickCandidate(c)
          }}
        >
          {c.rel}
        </button>
      ))}
    </div>
  )

  return (
    <Popover
      open={pickerOpen}
      // 只接受 close:打开必须在 resolve 命中 multiple 后由 preview() 控制,
      // 否则 trigger click 会让弹层带着上次的旧候选列表先闪出来。
      // trigger 用 ['click'] 而不是 [] —— 空数组时 antd 不注册 outside-click
      // 监听,点弹层外永远不触发 onOpenChange(false),弹层关不掉。
      onOpenChange={(o) => {
        if (!o) setPickerOpen(false)
      }}
      trigger={['click']}
      content={pickerContent}
      placement="bottom"
      destroyTooltipOnHide
    >
      <Dropdown trigger={['contextMenu']} menu={{ items: menuItems }} destroyPopupOnHide>
        <button
          type="button"
          data-testid="file-path-chip"
          data-file-path={path}
          title="点击预览 · 右键更多操作 · 命中多个会弹选择"
          onClick={preview}
          className="inline-flex items-center gap-[3px] align-baseline text-[0.9em] font-[ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace] text-[#a78bfa] bg-[var(--bg-faint-05)] border border-[var(--border-light)] rounded-[4px] py-[1px] px-[6px] cursor-pointer hover:border-[#a78bfa]"
        >
          <FileTextIcon className="text-[0.85em] opacity-70" />
          {path}
        </button>
      </Dropdown>
    </Popover>
  )
}

export const FilePathChip = React.memo(FilePathChipInner)
```

- [ ] **Step 5: 跑测试确认通过**

Run:
```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm --filter @zn-ai/zai test test/web/markdown/FilePathChip.test.tsx
```
Expected: PASS — 5 个用例全绿。

- [ ] **Step 6: 跑 Markdown 相关既有测试确认无回归**

Run:
```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm --filter @zn-ai/zai test test/web/linkify.test.ts test/web/toolRenderers
```
Expected: PASS（无新增失败）。

- [ ] **Step 7: Commit**

```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy
git add packages/zai/src/web/src/hooks/useFilePathActions.tsx \
        packages/zai/src/web/src/components/markdown/FilePathChip.tsx \
        packages/zai/test/web/markdown/FilePathChip.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 refactor(zai): 抽出 useFilePathActions 供路径 chip 与产物块共用"
```

---

### Task 3: `TurnArtifactsBlock` 组件

**Files:**
- Create: `packages/zai/src/web/src/components/transcript/TurnArtifactsBlock.tsx`
- Test: `packages/zai/test/web/transcript/TurnArtifactsBlock.test.tsx`

**Interfaces:**
- Consumes: `ArtifactFile`（Task 1 产出）、`useFilePathActions`（Task 2 产出）
- Produces: `function TurnArtifactsBlock({ files }: { files: ArtifactFile[] }): JSX.Element`
  - 根节点 `data-testid="turn-artifacts-block"`
  - 块头 `data-testid="turn-artifacts-header"`
  - 每个文件行 `data-testid="turn-artifact-row"`，带 `data-file-path`

- [ ] **Step 1: 写失败的测试**

创建 `packages/zai/test/web/transcript/TurnArtifactsBlock.test.tsx`：

```tsx
// @vitest-environment happy-dom
// 注: happy-dom 不做真实 CSS 布局,这里只验证渲染行为与文字,不断言样式值。
import { describe, expect, test, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { message } from 'antd'
import { TurnArtifactsBlock } from '../../../src/web/src/components/transcript/TurnArtifactsBlock.js'
import type { ArtifactFile } from '../../../src/web/src/components/transcript/deriveTurnArtifacts.js'

const openFilePathPreview = vi.hoisted(() => vi.fn())

vi.mock('../../../src/web/src/lib/openFilePath.js', () => ({
  FILE_PREVIEW_OPEN_EVENT: 'zai:file-preview-open',
  openFilePathPreview,
  callFsCommand: vi.fn(),
}))

// 行点击路径只用到 store 的 getState().openFilePreview,渲染期不读 store。
vi.mock('../../../src/web/src/store/useAgentStore.js', () => ({
  useAgentStore: Object.assign(() => undefined, {
    getState: () => ({ openFilePreview: vi.fn() }),
  }),
}))

function file(path: string, over: Partial<ArtifactFile> = {}): ArtifactFile {
  return { path, label: '编辑', count: 1, written: false, ...over }
}

beforeEach(() => {
  openFilePathPreview.mockReset()
})

describe('TurnArtifactsBlock — 渲染', () => {
  test('块头显示文件数,行显示 basename', () => {
    render(<TurnArtifactsBlock files={[file('/abs/dir/SettingsDrawer.tsx'), file('/abs/dir/a.ts')]} />)
    expect(screen.getByTestId('turn-artifacts-block')).toBeInTheDocument()
    expect(screen.getByText('本轮产物 · 2 个文件')).toBeInTheDocument()
    expect(screen.getByText('SettingsDrawer.tsx')).toBeInTheDocument()
    expect(screen.getByText('a.ts')).toBeInTheDocument()
  })

  test('写入 / 编辑徽标分别渲染,出现次数 > 1 时显示 ×N', () => {
    render(
      <TurnArtifactsBlock
        files={[
          file('/abs/a.ts', { label: '写入', written: true }),
          file('/abs/b.ts', { label: '编辑', count: 3 }),
        ]}
      />,
    )
    expect(screen.getByText('写入')).toBeInTheDocument()
    expect(screen.getByText('编辑')).toBeInTheDocument()
    expect(screen.getByText('×3')).toBeInTheDocument()
  })

  test('count === 1 时不显示 ×N 角标', () => {
    render(<TurnArtifactsBlock files={[file('/abs/a.ts')]} />)
    expect(screen.queryByText(/^×/)).not.toBeInTheDocument()
  })
})

describe('TurnArtifactsBlock — 折叠', () => {
  const many = Array.from({ length: 9 }, (_, i) => file(`/abs/f${i}.ts`))

  test('超过 8 个文件时默认折叠,块头仍显示总数', () => {
    render(<TurnArtifactsBlock files={many} />)
    expect(screen.getByText('本轮产物 · 9 个文件')).toBeInTheDocument()
    expect(screen.queryAllByTestId('turn-artifact-row')).toHaveLength(0)
  })

  test('点击块头展开后列出全部文件', () => {
    render(<TurnArtifactsBlock files={many} />)
    fireEvent.click(screen.getByTestId('turn-artifacts-header'))
    expect(screen.getAllByTestId('turn-artifact-row')).toHaveLength(9)
  })

  test('恰好 8 个文件时默认展开', () => {
    render(<TurnArtifactsBlock files={many.slice(0, 8)} />)
    expect(screen.getAllByTestId('turn-artifact-row')).toHaveLength(8)
  })
})

describe('TurnArtifactsBlock — 预览动作', () => {
  test('点击文件行调用 openFilePathPreview(该行路径原文)', async () => {
    openFilePathPreview.mockResolvedValue({ ok: 'exact', abs: '/abs/a.ts' })
    render(<TurnArtifactsBlock files={[file('src/a.ts')]} />)
    fireEvent.click(screen.getByTestId('turn-artifact-row'))
    await waitFor(() => expect(openFilePathPreview).toHaveBeenCalledWith('src/a.ts'))
  })

  test('命中多个候选时弹出 picker', async () => {
    openFilePathPreview.mockResolvedValue({
      ok: 'multiple',
      candidates: [
        { abs: '/p1/a.ts', rel: 'p1/a.ts' },
        { abs: '/p2/a.ts', rel: 'p2/a.ts' },
      ],
    })
    render(<TurnArtifactsBlock files={[file('a.ts')]} />)
    fireEvent.click(screen.getByTestId('turn-artifact-row'))
    expect(await screen.findByTestId('file-path-picker')).toBeInTheDocument()
    expect(screen.getAllByTestId('file-path-picker-item')).toHaveLength(2)
  })

  test('解析失败时 message.error', async () => {
    const errSpy = vi.spyOn(message, 'error').mockImplementation(() => undefined as never)
    openFilePathPreview.mockResolvedValue({ ok: false, code: 'ENOENT', error: '文件不存在' })
    render(<TurnArtifactsBlock files={[file('nope.ts')]} />)
    fireEvent.click(screen.getByTestId('turn-artifact-row'))
    await waitFor(() => expect(errSpy).toHaveBeenCalledWith('文件不存在'))
    errSpy.mockRestore()
  })

  test('右键文件行弹出与 chip 一致的菜单', async () => {
    render(<TurnArtifactsBlock files={[file('src/a.ts')]} />)
    fireEvent.contextMenu(screen.getByTestId('turn-artifact-row'))
    expect(await screen.findByText('预览')).toBeInTheDocument()
    expect(screen.getByText('在文件管理器中显示')).toBeInTheDocument()
    expect(screen.getByText('在终端中打开')).toBeInTheDocument()
    expect(screen.getByText('复制路径')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm --filter @zn-ai/zai test test/web/transcript/TurnArtifactsBlock.test.tsx
```
Expected: FAIL — `Failed to resolve import ".../TurnArtifactsBlock.js"`。

- [ ] **Step 3: 写最小实现**

创建 `packages/zai/src/web/src/components/transcript/TurnArtifactsBlock.tsx`：

```tsx
/**
 * TurnArtifactsBlock —— 「本轮产物」块。
 *
 * 由 MessageListView 在每一轮消息段的末尾按锚点下标插入,内容是该轮
 * 生成 / 修改过的文件(见 deriveTurnArtifacts)。点击行复用
 * useFilePathActions 的预览链路,与 Markdown 路径 chip 完全一致。
 */
import { useState } from 'react'
import { Dropdown, Popover } from 'antd'
import { ChevronRightIcon, FileIcon, SparklesIcon } from 'lucide-react'
import type { ArtifactFile } from './deriveTurnArtifacts.js'
import { useFilePathActions } from '../../hooks/useFilePathActions.js'

/** 文件数超过此值时默认折叠(块头仍显示总数)。 */
const AUTO_COLLAPSE_THRESHOLD = 8

const BADGE_BASE = 'shrink-0 rounded border text-[10px] px-1.5 py-0.5'
const BADGE_WRITTEN = `${BADGE_BASE} border-[#22c55e]/40 text-[#22c55e]`
const BADGE_EDITED = `${BADGE_BASE} border-[#a78bfa]/40 text-[#a78bfa]`

/** 取路径末段做展示名。纯字符串处理,不做平台判断 —— 两种分隔符都吃。 */
function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

function ArtifactRow({ file }: { file: ArtifactFile }) {
  const { preview, pickerOpen, setPickerOpen, pickerCandidates, pickCandidate, menuItems } =
    useFilePathActions(file.path)

  const pickerContent = (
    <div
      data-testid="file-path-picker"
      className="flex flex-col gap-[2px] max-h-[280px] overflow-auto"
    >
      <div className="text-xs text-[var(--text-dim-70,#888)] px-1 py-1">
        找到 {pickerCandidates.length} 个匹配,选择要预览的文件:
      </div>
      {pickerCandidates.map((c) => (
        <button
          key={c.abs}
          type="button"
          data-testid="file-path-picker-item"
          data-file-path={c.abs}
          className="text-left text-xs px-2 py-1 rounded hover:bg-[var(--bg-faint-05)] font-[ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace] text-[var(--text-primary,#ddd)]"
          onClick={(e) => {
            e.stopPropagation()
            pickCandidate(c)
          }}
        >
          {c.rel}
        </button>
      ))}
    </div>
  )

  return (
    <Popover
      open={pickerOpen}
      onOpenChange={(o) => {
        if (!o) setPickerOpen(false)
      }}
      trigger={['click']}
      content={pickerContent}
      placement="bottom"
      destroyTooltipOnHide
    >
      <Dropdown trigger={['contextMenu']} menu={{ items: menuItems }} destroyPopupOnHide>
        <button
          type="button"
          data-testid="turn-artifact-row"
          data-file-path={file.path}
          title={file.path}
          onClick={preview}
          className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-[var(--bg-faint-08)]"
        >
          <FileIcon className="shrink-0 text-[var(--text-dim-45)]" />
          <span className="text-xs text-[var(--text-primary)] truncate flex-1">
            {baseName(file.path)}
          </span>
          <span className="text-[11px] text-[var(--text-dim-45)] truncate max-w-[40%]">
            {file.path}
          </span>
          {file.count > 1 && (
            <span className="shrink-0 text-[10px] text-[var(--text-dim-45)]">×{file.count}</span>
          )}
          <span className={file.written ? BADGE_WRITTEN : BADGE_EDITED}>{file.label}</span>
        </button>
      </Dropdown>
    </Popover>
  )
}

export function TurnArtifactsBlock({ files }: { files: ArtifactFile[] }) {
  // 折叠态是组件本地状态。父级用该轮的 turnKey(eventId)作 React key,
  // 因此新消息 append 不会重挂载 → 用户展开/收起的意图被保留。
  const [open, setOpen] = useState(files.length <= AUTO_COLLAPSE_THRESHOLD)

  return (
    <div
      data-testid="turn-artifacts-block"
      className="mt-2 mb-1 rounded-md border border-[var(--border-light)] px-3 py-2"
    >
      <button
        type="button"
        data-testid="turn-artifacts-header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer select-none items-center gap-1.5 border-0 bg-transparent p-0 text-left text-xs text-[var(--text-dim-70)]"
      >
        <SparklesIcon className="shrink-0 text-[var(--accent-start)]" />
        <span>本轮产物 · {files.length} 个文件</span>
        <ChevronRightIcon
          className={`ml-auto shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div className="mt-1 flex flex-col">
          {files.map((f) => (
            <ArtifactRow key={f.path} file={f} />
          ))}
        </div>
      )}
    </div>
  )
}
```

> 容器**不设底色**(只留 `border-[var(--border-light)]`)，行的 hover 用 `--bg-faint-08` —— 若容器本身铺 `--bg-faint-05`，行的 hover 在视觉上会被吃掉。这是对 spec §4.3 的一处修正。

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm --filter @zn-ai/zai test test/web/transcript/TurnArtifactsBlock.test.tsx
```
Expected: PASS — 10 个用例全绿。

- [ ] **Step 5: Commit**

```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy
git add packages/zai/src/web/src/components/transcript/TurnArtifactsBlock.tsx \
        packages/zai/test/web/transcript/TurnArtifactsBlock.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 新增「本轮产物」块组件"
```

---

### Task 4: 接入 `MessageListView`（两个渲染分支）

**Files:**
- Modify: `packages/zai/src/web/src/components/transcript/MessageListView.tsx`
- Modify: `packages/zai/src/web/src/components/transcript/MessageListView.test.tsx`

**Interfaces:**
- Consumes: `deriveTurnArtifacts` / `TurnArtifacts`（Task 1）、`TurnArtifactsBlock`（Task 3）、`useAgentStoreOrCtx`（`s.status`）
- Produces: 无对外新接口；`MessageListView` 渲染输出中新增 `data-testid="turn-artifacts-block"` 节点

- [ ] **Step 1: 更新既有测试的 store mock，写失败的用例**

编辑 `packages/zai/src/web/src/components/transcript/MessageListView.test.tsx`。

先把文件顶部的 mock 换成带 `status` 的版本（原 mock 只有 `transcriptCollapsed`，MessageListView 现在还要读 `status`）：

```tsx
// MessageListView 从 useAgentStore 读 transcriptCollapsed 与 status —— mock 掉,
// 让测试分别驱动 expanded (false) / collapsed (true) 两条渲染路径与产物块结算。
const collapsed = vi.hoisted(() => ({ value: false }))
const status = vi.hoisted(() => ({ value: 'idle' as string }))
vi.mock("../../store/useAgentStore.js", () => ({
  useAgentStore: <T,>(selector: (s: { transcriptCollapsed: boolean; status: string }) => T): T =>
    selector({ transcriptCollapsed: collapsed.value, status: status.value }),
  useAgentStoreOrCtx: <T,>(selector: (s: { transcriptCollapsed: boolean; status: string }) => T): T =>
    selector({ transcriptCollapsed: collapsed.value, status: status.value }),
}))
```

在文件末尾追加新的 describe 块：

```tsx
// ── 本轮产物块 ────────────────────────────────────────────────────────────
// 语料:两轮对话,各自改过文件。产物块锚定在每轮最后一条消息之后。
function artifactMessages(): AgentMessage[] {
  return [
    { eventId: "u1", sessionId: "sess-1", ts: 1, turnIndex: 0, type: "user.text", text: "first" },
    toolMsg("tool_use:start", "tu-w1", "Write", { file_path: "/abs/one.ts" }),
    toolMsg("tool_use:done", "tu-w1", "Write", undefined, "File created successfully"),
    { eventId: "a1", sessionId: "sess-1", ts: 2, turnIndex: 0, type: "assistant.text", text: "done1" },
    { eventId: "u2", sessionId: "sess-1", ts: 3, turnIndex: 1, type: "user.text", text: "second" },
    toolMsg("tool_use:start", "tu-e1", "Edit", { file_path: "/abs/two.ts" }),
    toolMsg("tool_use:done", "tu-e1", "Edit", undefined, "ok"),
    { eventId: "a2", sessionId: "sess-1", ts: 4, turnIndex: 1, type: "assistant.text", text: "done2" },
  ]
}

describe("MessageListView — 本轮产物块", () => {
  test("expanded 视图:每轮末尾各渲染一个产物块", () => {
    collapsed.value = false
    status.value = "idle"
    render(<MessageListView messages={artifactMessages()} />)
    const blocks = screen.getAllByTestId("turn-artifacts-block")
    expect(blocks).toHaveLength(2)
    expect(screen.getByText("one.ts")).toBeInTheDocument()
    expect(screen.getByText("two.ts")).toBeInTheDocument()
  })

  test("collapsed 视图:同样插入两个产物块", () => {
    collapsed.value = true
    status.value = "idle"
    render(<MessageListView messages={artifactMessages()} />)
    expect(screen.getAllByTestId("turn-artifacts-block")).toHaveLength(2)
  })

  test("流式中的最后一轮不出产物块,已结束的上一轮仍有", () => {
    collapsed.value = false
    status.value = "streaming"
    render(
      <MessageListView
        messages={[
          { eventId: "u1", sessionId: "sess-1", ts: 1, turnIndex: 0, type: "user.text", text: "first" },
          toolMsg("tool_use:start", "tu-w1", "Write", { file_path: "/abs/one.ts" }),
          { eventId: "u2", sessionId: "sess-1", ts: 2, turnIndex: 1, type: "user.text", text: "second" },
          toolMsg("tool_use:start", "tu-e1", "Edit", { file_path: "/abs/two.ts" }),
        ]}
      />,
    )
    const blocks = screen.getAllByTestId("turn-artifacts-block")
    expect(blocks).toHaveLength(1)
    expect(screen.getByText("one.ts")).toBeInTheDocument()
    expect(screen.queryByText("two.ts")).not.toBeInTheDocument()
  })

  test("无文件改动的轮次不渲染产物块", () => {
    collapsed.value = false
    status.value = "idle"
    render(
      <MessageListView
        messages={[
          { eventId: "u1", sessionId: "sess-1", ts: 1, turnIndex: 0, type: "user.text", text: "hi" },
          { eventId: "a1", sessionId: "sess-1", ts: 2, turnIndex: 0, type: "assistant.text", text: "hello back" },
        ]}
      />,
    )
    expect(screen.queryByTestId("turn-artifacts-block")).not.toBeInTheDocument()
  })
})
```

> 注意：`beforeEach` 里把 `status.value` 复位为 `"idle"`，避免用例间串味。若该文件已有 `beforeEach`，在其中补一行 `status.value = "idle"`；没有就新增一个。

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm --filter @zn-ai/zai test src/web/src/components/transcript/MessageListView.test.tsx
```
Expected: FAIL — 新用例找不到 `turn-artifacts-block`（MessageListView 还没接入）。

- [ ] **Step 3: 接入 `MessageListView`**

编辑 `packages/zai/src/web/src/components/transcript/MessageListView.tsx`。

**(a)** 文件顶部补 import：

```tsx
import { useMemo, type ReactElement } from 'react'
import { deriveTurnArtifacts, type TurnArtifacts } from './deriveTurnArtifacts.js'
import { TurnArtifactsBlock } from './TurnArtifactsBlock.js'
```

（`ReactElement` 在 Step 3(e) 的 collapsed 分支里用到，先一起加好。）

**(b)** 在组件内、`const collapsed = ...` 之后插入（`visibleMessages` 用 `useMemo` 包住，否则每次渲染新数组引用会让产物的 `useMemo` 失效）：

```tsx
  const status = useAgentStoreOrCtx((s) => s.status)
  // filter 每次渲染都产生新数组 → 不 memo 的话下面两个 useMemo 会全量重算
  const visibleMessages = useMemo(
    () => messages.filter((m) => !isAgentToolMessage(m)),
    [messages],
  )
  // 每轮 → 该轮产物文件列表(纯派生,见 deriveTurnArtifacts)
  const turns = useMemo(
    () => deriveTurnArtifacts(visibleMessages, { status }),
    [visibleMessages, status],
  )
  // 锚点下标 → 该轮产物,供两个渲染分支 O(1) 查表
  // (`as const` 让 map 回调产出 readonly tuple,匹配 Map 的 iterable 签名)
  const artifactsByAnchor = useMemo(
    () => new Map<number, TurnArtifacts>(turns.map((t) => [t.endIndex, t] as const)),
    [turns],
  )
```

同时**删掉**原来那一行 `const visibleMessages = messages.filter((m) => !isAgentToolMessage(m))`。

**(c)** expanded 分支：把 `visibleMessages.map(...)` 换成 `visibleMessages.flatMap(...)`，每个消息渲染完后按锚点下标追加产物块。整个分支替换为：

```tsx
  if (!collapsed) {
    // expanded: 逐条渲染,并在每一轮的最后一条消息之后插入「本轮产物」块。
    return (
      <>
        {visibleMessages.flatMap((msg, idx) => {
          const t = msg.type as string
          const toolUseId = t.startsWith('tool_use:')
            ? (msg as any).toolUseId
            : undefined
          const reactKey =
            (toolUseId ? `tool-${toolUseId}` : (msg as any).eventId) || String(idx)
          // 判定: "最后一条消息是 thinking" 即视为流式 thinking 累积中,
          // 给 ThinkingBlock 传 streaming={true} 启动动画. 旧实现这里
          // 用 idx === lastIdx 也能覆盖大多数场景; text 一切到, lastIdx
          // 立刻变成 text → thinking 自动失活 → 动画停. 简单可靠.
          const lastIdx = visibleMessages.length - 1
          const isLive =
            t === 'assistant.thinking'
              ? idx === lastIdx
              : t === 'assistant.text' && Boolean(streaming) && idx === lastIdx
          const bubble = <MessageBubble key={reactKey} msg={msg} streaming={isLive} />
          const turn = artifactsByAnchor.get(idx)
          if (!turn) return [bubble]
          return [
            bubble,
            <TurnArtifactsBlock key={`art-${turn.turnKey}`} files={turn.files} />,
          ]
        })}
      </>
    )
  }
```

**(d)** collapsed 分支：把 `nodes.map((node, i) => { ... })` 换成 `nodes.flatMap(...)`，把原有 4 个 `return` 改成给 `el` 赋值，最后按锚点追加产物块。整个 `return (...)` 块替换为：

```tsx
  return (
    <>
      {nodes.flatMap((node, i) => {
        // 该 node 覆盖的最后一条消息下标 —— 产物块锚点用的就是这个值
        const nodeLastIndex = 'endIndex' in node ? node.endIndex : node.index
        let el: ReactElement
        if (node.kind === 'toolGroup') {
          // 自包含展示类工具(标记了 skipOuterGroup)且所有 entry 都
          // 已 done, 跳过 ToolGroupCard 外壳直接渲染 MessageBubble 列表,
          // 与 expanded 视图视觉对齐. 与其他工具混合或 pending/error
          // 状态会回退到 ToolGroupCard 保留状态提示.
          if (shouldSkipOuterGroup(node.toolCalls)) {
            el = (
              <span key={`grp-skip-${node.toolCalls[0]?.message.eventId ?? node.startIndex}`}>
                {node.toolCalls.map((e) => {
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
          } else {
            // 用首条 tool entry 的 eventId 作稳定 key, 而非下标区间. 否则新消息
            // (或同一 turn 追加的新工具) 会改变 group 的 endIndex → key 变化 →
            // 整棵子树卸载重挂载, ToolGroupCard 内部折叠态被重置.
            el = (
              <ToolGroupCard
                key={`grp-${node.toolCalls[0]?.message.eventId ?? node.startIndex}`}
                entries={node.toolCalls}
              />
            )
          }
        } else if (node.kind === 'thinking') {
          // 注意: collapsed 视图下, 流式 'assistant.thinking' 不会进这种
          // 节点 (deriveTranscriptNodes 只把 legacy 'assistant' + thinking
          // 字段提为 kind: 'thinking'). 流式 'assistant.thinking' 走
          // text bucket, 见下面的 isThinkingMsg 分支.
          // 这里是历史回放里的 legacy thinking 节点, 始终静态 (不闪烁).
          el = (
            <MessageBubble
              key={`think-${node.index}-${i}`}
              msg={node.message}
              streaming={false}
            />
          )
        } else if (node.kind === 'ask') {
          // AskUserQuestion must stay full-width; route through MessageBubble for parity.
          el = (
            <MessageBubble
              key={`ask-${node.index}-${i}`}
              msg={node.message}
              streaming={false}
            />
          )
        } else {
          // text node: render each contained message through CollapsedMessageBubble (single-msg view)
          // key 用首条消息的 eventId (而非此时的下标区间) 作为稳定标识: 新消息
          // append 到同一 text bucket 末尾时, 首条 eventId 不变, key 不变 →
          // 子树不重挂载, CollapsedMessageBubble / AssistantTextBody 内部展开态保留.
          el = (
            <div key={`txt-${node.messages[0]?.eventId ?? node.startIndex}`}>
              {node.messages.map((m, mi) => {
                const evtId = ((m as any).eventId as string) ?? `txt-${node.startIndex}-${mi}`
                const msgIdx = node.startIndex + mi
                // "最后一条 assistant.text" 完整展开 (绕开 clamp);
                // 历史 assistant.text 仍走默认 6 行 clamp + "显示更多" 按钮.
                const isLastAssistant = msgIdx === lastAssistantIdx
                // 判定: 最后一条消息是 thinking → 走 streaming=true; 否则
                // 走 status-based streaming (text 累积光标等).
                // assistant.thinking 在 collapsed 视图走 text bucket;
                // 简单规则: "thinking 是最后一条 messages" 即可.
                const mt = (m as { type?: string }).type
                const isThinkingMsg = mt === 'assistant.thinking'
                const lastOverallIdx = visibleMessages.length - 1
                const itemStreaming = isThinkingMsg
                  ? msgIdx === lastOverallIdx
                  : streaming && node.endIndex === lastOverallIdx
                return (
                  <CollapsedMessageBubble
                    key={evtId}
                    message={m}
                    streaming={itemStreaming}
                    forceExpanded={isLastAssistant}
                  />
                )
              })}
            </div>
          )
        }
        const turn = artifactsByAnchor.get(nodeLastIndex)
        if (!turn) return [el]
        return [el, <TurnArtifactsBlock key={`art-${turn.turnKey}`} files={turn.files} />]
      })}
    </>
  )
```

**(e)** （`ReactElement` 已在 Step 3(a) 一并加入 import，此处无需再改。）

**关键约束**：上面四个分支**原有的 `key` 表达式必须逐字保留**（`grp-skip-...` / `grp-...` / `think-...` / `ask-...` / `txt-...`）。`MessageListView.test.tsx` 里「新消息 append 到同一 text bucket 不重挂载」这条回归用例依赖它们不变。

`collapsed` 分支里原有的 `let nodes` / `try-catch` 兜底 / `const lastAssistantIdx = ...` 三处**保持不动**。

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm --filter @zn-ai/zai test src/web/src/components/transcript/MessageListView.test.tsx
```
Expected: PASS — 既有用例（含「不重挂载」回归）与新用例全绿。

- [ ] **Step 5: 跑相关测试套确认无连锁回归**

Run:
```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm --filter @zn-ai/zai test test/web/transcript src/web/src/components/transcript
```
Expected: PASS（`deriveTranscriptNodes` / `ToolGroupCard` / `MessageListView` 全绿）。

- [ ] **Step 6: 类型检查**

Run:
```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy/packages/zai && pnpm exec tsc --noEmit -p tsconfig.json
```
Expected: 无新增错误。

- [ ] **Step 7: Commit**

```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy
git add packages/zai/src/web/src/components/transcript/MessageListView.tsx \
        packages/zai/src/web/src/components/transcript/MessageListView.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 对话每轮末尾渲染本轮产物块"
```

---

### Task 5: 真实浏览器验收

**Files:** 无代码改动（本任务只验收；发现问题回到对应 Task 修）

**Interfaces:**
- Consumes: Task 1-4 的全部产出
- Produces: 验收结论（截图 + 度量数据）

- [ ] **Step 1: 确认端口空闲并启动 dev**

Run:
```bash
lsof -i :8102 -i :7715 || echo "ports free"
```
Expected: 无输出 + `ports free`。若被占用，换一对空闲端口（禁止 kill 920x 上的正式服务进程）。

Run（后台）:
```bash
cd /Users/liangxuechao572/code/zn-ai-zbuddy && pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715
```

- [ ] **Step 2: 询问用户是否执行浏览器验收**

按 `AGENTS.md`「真实浏览器验收(非必须,先询问)」——询问用户是否走 `/ego-browser`。用户确认后再继续；用户拒绝则本任务标记为「用户豁免」并结束。

- [ ] **Step 3: 打开 `/agent` 跑一轮真实对话**

用 `/ego-browser` 打开 `http://localhost:8102/agent`，发一条会产生文件改动的 prompt（例如「在当前目录新建一个 `zz-artifact-probe.md`，写一行 hello」），等这一轮结束。

- [ ] **Step 4: 度量产物块的像素级证据**

在页面里取：

```js
const block = document.querySelector('[data-testid="turn-artifacts-block"]')
const rows = document.querySelectorAll('[data-testid="turn-artifact-row"]')
const cs = getComputedStyle(block)
return {
  blockRect: block.getBoundingClientRect().toJSON(),
  borderLeft: cs.borderLeftWidth,
  rowCount: rows.length,
  firstRowText: rows[0]?.textContent,
  rowRect: rows[0]?.getBoundingClientRect().toJSON(),
}
```

Expected:
- `rowCount >= 1`
- `firstRowText` 含探测文件名与「写入」徽标
- `blockRect` 落在消息列表可视区内、宽度与消息气泡同栏

- [ ] **Step 5: 点击产物行验证预览**

点击该行 → 断言抽屉出现且标题含文件名：

```js
await new Promise(r => setTimeout(r, 600))
return {
  drawer: !!document.querySelector('[data-testid="desktop-file-preview-drawer"]'),
  title: document.querySelector('[data-testid="desktop-file-preview-drawer"]')?.textContent,
}
```

Expected: `drawer: true`，`title` 含探测文件名。

- [ ] **Step 6: 截图并留存**

对 `/agent` 整页截图，与产物块的局部截图各一张。把结论（通过 / 发现的问题）写进 PR 描述或直接回报用户。

- [ ] **Step 7: 关闭 dev 服务**

停掉 Step 1 起的后台进程（只停自己起的 8102/7715 实例，不要动 920x）。

---

## 已知偏差（相对 spec）

| spec 位置 | 偏差 | 原因 |
|---|---|---|
| §4.3 容器视觉 | 容器不设 `bg-[var(--bg-faint-05)]`，行 hover 用 `--bg-faint-08` | 容器铺 5% 底色会吃掉行的 hover 反馈 |
| —— | `useFilePathActions` 落在 `.tsx` 而非 `.ts` | `menuItems` 携带 JSX 图标；`src/web/src/hooks/` 首个 `.tsx` hook |

## 实现期修正（相对本计划）

### 修正 1：collapsed 分支不能用 `endIndex` 精确匹配锚点

计划 Task 4 Step 3(d) 写的实现是 `const nodeLastIndex = 'endIndex' in node ? node.endIndex : node.index`，然后 `artifactsByAnchor.get(nodeLastIndex)` 精确匹配。**实测这条路径在 collapsed 视图下永远匹配不到**，两个独立原因叠加：

1. **`deriveTranscriptNodes` 的 text bucket 会跨轮合并。** 它只在工具边界 flush，于是「上一轮收尾的 `assistant.text`」与「下一轮开头的 `user.text`」落进同一个 text node。本轮 prompt 的语料里 turn1 的 `endIndex = 3`，而覆盖它的 node 是 `text[3..4]`（末尾 4）—— 没有任何 node 的末尾恰好等于 3。
2. **尾部 text node 的 `endIndex` 有既存 off-by-one。** 尾刷 `pushText(textBuf, out, textStart, messages.length - 1)` 传的是 `messages.length - 1`，而 `pushText` 内部又做 `endIndex = idx - 1`，于是最后一个 text node 得到 `endIndex = startIndex - 1`（实测 `{startIndex: 7, endIndex: 6}`）。这是 `deriveTranscriptNodes.ts:88-89` 的既存行为，本次**不改**（修它会改变 `itemStreaming` 的判定语义，属另一件事）。

**实际实现**：collapsed 分支改为「把每轮产物挂到**包含该轮最后一条消息**的那个 node 上」，两者都按 index 有序，一次线性扫描（`artifactsByNode`）。node 的覆盖区间由**自身载荷**推导（`startIndex + 元素数 - 1`），不读 `node.endIndex`，从而同时绕开上述两点。expanded 分支不受影响，仍用精确匹配的 `artifactsByAnchor`。

回归护栏：`MessageListView.test.tsx` 的「collapsed 视图:同样插入两个产物块」用例的语料**恰好**包含跨轮合并场景，是这条修正的直接守门测试。

### 修正 2：collapsed 分支的 `key` 表达式逐字保留

计划要求的「四个分支原有 key 逐字保留」在执行时严格遵守，`MessageListView.test.tsx` 的「新消息 append 到同一 text bucket 不重挂载」用例全程保持绿色。

## 风险与回滚

- **`FilePathChip` 抽取**：该类原无测试，Task 2 补齐了 5 条回归护栏。若抽取后行为异常，`git revert` Task 2 的 commit 即可回到抽取前的实现（Task 3/4 依赖新 hook，需一并回滚）。
- **`MessageListView` collapsed 分支 refactor**：Task 4 Step 3(d) 保留了全部既有 key 表达式，`MessageListView.test.tsx` 的「不重挂载」用例是这件事的护栏。若该用例变红，说明 key 被改动，回到 Step 3(d) 逐字核对。
- **整体回滚**：本特性是 4 个独立 commit（Task 1-4），可按 commit 粒度 `git revert`，不涉及后端与数据迁移。