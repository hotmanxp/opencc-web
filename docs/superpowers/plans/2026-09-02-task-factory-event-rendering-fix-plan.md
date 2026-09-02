# Task Factory 执行过程 Tab 事件渲染修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 替换 `SuperTaskDetailDrawer` "执行过程" Tab 中 `JSON.stringify(e.data).slice(0,120)` 的 raw 输出,改为按 RuntimeEvent 角色(system / user / assistant-text / thinking / tool-use / tool-result / task-ended)分层的可读事件流。

**Architecture:** 新增纯函数模块 `processEventRenderer.ts`,把每帧 `SseFrame` 翻译成 `RenderedEvent` 结构化对象;Drawer 组件只负责按 `kind` 分支渲染与 tool 展开/折叠状态管理,不感知 RuntimeEvent 字段。SSE 协议、TaskEvent shape、Drawer useEffect 数据流均不变,零回归。

**Tech Stack:** TypeScript 5.6；React 18；AntD 5 (`Drawer`/`Tabs`/`Timeline`/`Collapse`)；react-markdown + remark-gfm；vitest 4。

## Global Constraints

- 提交格式:本仓库最近用的 `feat(scope): ...` / `fix(scope): ...` / `docs(scope): ...`(无需 issue id,见 `git log --oneline -10`)。
- 只跑相关单测,禁止 `pnpm -r test` 当完成门禁。本任务:`pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/processEventRenderer.test.ts`。
- 页面 UI 改动**必须** `/ego-browser` 真实浏览器验收(项目强制规则);happy-dom/jsdom 不渲染真实 CSS cascade 与 paint,跑过也不代表对齐。
- 端口:起 dev 前 `lsof -i :<port>` 确认空闲;显式 `--port` 被占用应报错。
- 系统提示词/Agent 描述一律英文;UI 文案中文(i18n)。
- 改动文件:`processEventRenderer.ts`(新)、`processEventRenderer.test.ts`(新)、`SuperTaskDetailDrawer.tsx`(改)。**不动** `zn-agent-core`、`taskApi.ts`、`routes/tasks.ts`、`subscribeTaskEvents`、其他 superTasks 子组件。
- spec 已落盘 `docs/superpowers/specs/2026-09-02-task-factory-event-rendering-fix-design.md`(commit `ab8092a5`);本 plan 是 spec 的实施拆分。

---

### Task 1: 新增 `processEventRenderer.ts` 纯函数模块(TDD)

**Files:**
- Create: `packages/zai/src/web/src/components/superTasks/processEventRenderer.ts`
- Create: `packages/zai/src/web/src/components/superTasks/processEventRenderer.test.ts`

**Interfaces:**

- Consumes: `SseFrame` from `packages/zai/src/web/src/lib/taskApi.ts`(已存在)
  ```ts
  export interface SseFrame { id: string | number; event: string; data: unknown }
  ```
- Produces(Drawer 任务消费):
  ```ts
  export type RenderedEvent =
    | { kind: 'system';  ts: number; seq: number; sub: string }
    | { kind: 'user';    ts: number; seq: number; text: string; cwd?: string; agent?: string }
    | { kind: 'assistant-text'; ts: number; seq: number; text: string }
    | { kind: 'thinking'; ts: number; seq: number; text: string }
    | { kind: 'tool-use'; ts: number; seq: number; name: string;
        toolUseId: string; summary: string; fullInput: Record<string, unknown> }
    | { kind: 'tool-result'; ts: number; seq: number; toolUseId: string;
        isError: boolean; summary: string; fullContent: string }
    | { kind: 'task-ended'; status: 'completed'|'failed'|'cancelled';
        error?: string; resultText?: string }
  export function toRendered(frame: SseFrame): RenderedEvent | null
  ```

**全局 SSE 数据形状约定**(从 spec + 已读源码固定):
- `frame.event === 'task.ended'` → 终态哨兵;`frame.data = { taskId, status, error?, resultText? }`
- `frame.event === 'attach'` → `frame.data` 是 RuntimeEvent 经 `stripMeta` 后,字段为 `{seq, ts, eventId, type, data, raw}`;`raw.type` 是语义类型(`system`/`user`/`assistant`);`raw.message.content[]` 是 content blocks(`text`/`thinking`/`tool_use`/`tool_result`)
- tool_result block 出现在 `raw.type === 'user'` 的消息里(SDK 约定)
- `data.text` 永远是空字符串(SSE wrapper 占位),实际内容在 `raw.message.content[]`

**全局守卫**(写在 `toRendered` 入口,所有测试共享):
- `frame.event === 'task.ended'` → 走 task-ended 分支
- `frame.event !== 'attach'` → 返回 `null`(未知 SSE 事件名,静默 skip)
- `frame.data` 不是对象(null / 字符串 / 数字) → 返回 `null`
- `frame.data.raw` 不是对象 → 返回 `null`
- `raw.type` 未知 → 返回 `null`

- [ ] **Step 1.1: 脚手架 — 类型导出 + 空 `toRendered`**

创建 `processEventRenderer.ts`,只导出 `RenderedEvent` 类型 + `toRendered` stub(返回 `null`)。

```ts
// packages/zai/src/web/src/components/superTasks/processEventRenderer.ts
import type { SseFrame } from '../../lib/taskApi'

export type RenderedEvent =
  | { kind: 'system';  ts: number; seq: number; sub: string }
  | { kind: 'user';    ts: number; seq: number; text: string; cwd?: string; agent?: string }
  | { kind: 'assistant-text'; ts: number; seq: number; text: string }
  | { kind: 'thinking'; ts: number; seq: number; text: string }
  | { kind: 'tool-use'; ts: number; seq: number; name: string;
      toolUseId: string; summary: string; fullInput: Record<string, unknown> }
  | { kind: 'tool-result'; ts: number; seq: number; toolUseId: string;
      isError: boolean; summary: string; fullContent: string }
  | { kind: 'task-ended'; status: 'completed'|'failed'|'cancelled';
      error?: string; resultText?: string }

const isObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object'

export function toRendered(frame: SseFrame): RenderedEvent | null {
  // 守卫见后续步骤,此处仅占位
  void frame
  return null
}
```

创建空测试文件 `processEventRenderer.test.ts`:

```ts
// packages/zai/src/web/src/components/superTasks/processEventRenderer.test.ts
import { describe, it, expect } from 'vitest'
import type { SseFrame } from '../../lib/taskApi'

describe('processEventRenderer.toRendered', () => {
  // 测试用例由后续步骤添加
  it('placeholder', () => {
    const frame: SseFrame = { id: 0, event: 'unknown', data: null }
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 1.2: 跑测试确认基线绿**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/processEventRenderer.test.ts`
Expected: PASS(1 placeholder 测试通过,占位实现返回 null)

- [ ] **Step 1.3: 提交脚手架**

```bash
git add packages/zai/src/web/src/components/superTasks/processEventRenderer.ts \
        packages/zai/src/web/src/components/superTasks/processEventRenderer.test.ts
git commit -m "feat(super-tasks): scaffold processEventRenderer module + types"
```

- [ ] **Step 1.4: TDD — task-ended 分支(三态)**

在 test 文件添加:

```ts
import { toRendered } from './processEventRenderer'

function frame(data: unknown, event = 'attach', id: number | string = 1): SseFrame {
  return { id, event, data }
}

describe('task-ended', () => {
  it('completed', () => {
    expect(toRendered(frame({ taskId: 't', status: 'completed', resultText: 'ok' }, 'task.ended')))
      .toEqual({ kind: 'task-ended', status: 'completed', error: undefined, resultText: 'ok' })
  })
  it('failed with error.message', () => {
    expect(toRendered(frame({ taskId: 't', status: 'failed', error: { message: 'oops' } }, 'task.ended')))
      .toEqual({ kind: 'task-ended', status: 'failed', error: 'oops', resultText: undefined })
  })
  it('cancelled', () => {
    expect(toRendered(frame({ taskId: 't', status: 'cancelled' }, 'task.ended')))
      .toEqual({ kind: 'task-ended', status: 'cancelled', error: undefined, resultText: undefined })
  })
})
```

- [ ] **Step 1.5: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/processEventRenderer.test.ts`
Expected: FAIL — `expected null to deeply equal { ... }`(`toRendered` 当前返回 null)

- [ ] **Step 1.6: 实现 task-ended 分支**

在 `toRendered` 顶部加:

```ts
if (frame.event === 'task.ended') {
  const data = isObject(frame.data) ? frame.data : {}
  const statusRaw = data.status
  const status: 'completed' | 'failed' | 'cancelled' =
    statusRaw === 'failed' ? 'failed' : statusRaw === 'cancelled' ? 'cancelled' : 'completed'
  const errObj = isObject(data.error) ? data.error : null
  const error = errObj && typeof errObj.message === 'string' ? errObj.message : undefined
  const resultText = typeof data.resultText === 'string' ? data.resultText : undefined
  return { kind: 'task-ended', status, error, resultText }
}
```

- [ ] **Step 1.7: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/processEventRenderer.test.ts`
Expected: PASS

- [ ] **Step 1.8: 提交**

```bash
git add packages/zai/src/web/src/components/superTasks/processEventRenderer.ts \
        packages/zai/src/web/src/components/superTasks/processEventRenderer.test.ts
git commit -m "feat(super-tasks): renderer — task-ended branch"
```

- [ ] **Step 1.9: TDD — 帧级守卫(未知 SSE event / 非对象 data / 缺 raw)**

添加测试:

```ts
describe('frame guards', () => {
  it('returns null for unknown SSE event', () => {
    expect(toRendered(frame(null, 'progress'))).toBeNull()
  })
  it('returns null when data is null', () => {
    expect(toRendered(frame(null))).toBeNull()
  })
  it('returns null when data is a string', () => {
    expect(toRendered(frame('hello'))).toBeNull()
  })
  it('returns null when raw is missing', () => {
    expect(toRendered(frame({ seq: 1, type: 'system', ts: 1, eventId: 'x', data: {} }))).toBeNull()
  })
  it('returns null when raw.type is unknown', () => {
    expect(toRendered(frame({ seq: 1, ts: 1, type: 'attach', eventId: 'x', raw: { type: 'mystery' } }))).toBeNull()
  })
  it('returns null when raw.message.content is missing for assistant', () => {
    expect(toRendered(frame({ seq: 1, ts: 1, type: 'attach', eventId: 'x', raw: { type: 'assistant' } }))).toBeNull()
  })
})
```

- [ ] **Step 1.10: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/processEventRenderer.test.ts`
Expected: FAIL — 6 个新 case 全部 expect null,实际 `toRendered` 还返回 null 但 4 个会"意外通过" 因 stub 也是 null,需加 helper 区分"实现 null"和"测试不区分":把 task-ended 的实现也扩展进 guards 逻辑。具体见 Step 1.11。

- [ ] **Step 1.11: 实现 attach 守卫 + 主分发 switch**

替换 `toRendered` 为:

```ts
export function toRendered(frame: SseFrame): RenderedEvent | null {
  if (frame.event === 'task.ended') {
    const data = isObject(frame.data) ? frame.data : {}
    const statusRaw = data.status
    const status: 'completed' | 'failed' | 'cancelled' =
      statusRaw === 'failed' ? 'failed' : statusRaw === 'cancelled' ? 'cancelled' : 'completed'
    const errObj = isObject(data.error) ? data.error : null
    const error = errObj && typeof errObj.message === 'string' ? errObj.message : undefined
    const resultText = typeof data.resultText === 'string' ? data.resultText : undefined
    return { kind: 'task-ended', status, error, resultText }
  }

  if (frame.event !== 'attach') return null
  if (!isObject(frame.data)) return null

  const ev = frame.data
  if (!isObject(ev.raw)) return null
  const raw = ev.raw
  const seq = Number(ev.seq ?? frame.id) || 0
  const ts = Number(ev.ts ?? Date.now())
  const reType = typeof raw.type === 'string' ? raw.type : ''

  if (reType === 'system') {
    const sub = typeof raw.subtype === 'string' ? raw.subtype : 'init'
    return { kind: 'system', ts, seq, sub }
  }

  // user / assistant 都从 raw.message.content[] 取 blocks
  const msg = isObject(raw.message) ? raw.message : null
  const content = msg && Array.isArray(msg.content) ? msg.content : []
  if (content.length === 0) return null

  const first = content[0]
  if (!isObject(first)) return null

  if (reType === 'user') {
    if (first.type === 'tool_result') return renderToolResult(first, ts, seq)
    const text = typeof first.text === 'string' ? first.text : ''
    const meta = isObject(raw.metadata) ? raw.metadata : {}
    return {
      kind: 'user', ts, seq, text,
      cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined,
      agent: typeof meta.agent === 'string' ? meta.agent : undefined,
    }
  }

  if (reType === 'assistant') {
    if (first.type === 'tool_use') return renderToolUse(first, ts, seq)
    if (first.type === 'thinking') {
      const text = typeof first.thinking === 'string' ? first.thinking : ''
      return { kind: 'thinking', ts, seq, text }
    }
    if (first.type === 'text') {
      const text = typeof first.text === 'string' ? first.text : ''
      return { kind: 'assistant-text', ts, seq, text }
    }
    return null
  }

  return null
}

function renderToolUse(block: Record<string, unknown>, ts: number, seq: number): RenderedEvent {
  const name = typeof block.name === 'string' ? block.name : 'unknown'
  const toolUseId = typeof block.id === 'string' ? block.id : `tu-${seq}`
  const input = isObject(block.input) ? block.input : {}
  return { kind: 'tool-use', ts, seq, name, toolUseId, summary: toolSummary(name, input), fullInput: input }
}

function renderToolResult(block: Record<string, unknown>, ts: number, seq: number): RenderedEvent {
  const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
  const isError = block.is_error === true
  const content = block.content
  let fullContent = ''
  if (typeof content === 'string') {
    fullContent = content
  } else if (Array.isArray(content)) {
    fullContent = content
      .filter((b): b is Record<string, unknown> => isObject(b) && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
  }
  const lines = fullContent.length === 0 ? 0 : fullContent.split('\n').length
  const firstLine = fullContent.split('\n')[0] ?? ''
  const preview = firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine
  const summary = `${preview} · ${lines} lines`
  return { kind: 'tool-result', ts, seq, toolUseId, isError, summary, fullContent }
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return typeof input.file_path === 'string' ? input.file_path : ''
    case 'Bash':
      return typeof input.command === 'string' ? input.command.slice(0, 80) : ''
    case 'Grep':
      return typeof input.pattern === 'string' ? input.pattern : ''
    case 'Glob': {
      const p = typeof input.pattern === 'string' ? input.pattern : ''
      const path = typeof input.path === 'string' ? input.path : ''
      return path ? `${p} · ${path}` : p
    }
    case 'Agent':
    case 'Task': {
      if (typeof input.description === 'string' && input.description) return input.description.slice(0, 60)
      if (typeof input.prompt === 'string') return input.prompt.slice(0, 60)
      return ''
    }
    default: {
      const s = JSON.stringify(input)
      return s.length > 80 ? s.slice(0, 80) + '…' : s
    }
  }
}
```

- [ ] **Step 1.12: 跑测试确认 guards 通过**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/processEventRenderer.test.ts`
Expected: PASS(task-ended 3 个 + guards 6 个)

- [ ] **Step 1.13: 提交**

```bash
git add packages/zai/src/web/src/components/superTasks/processEventRenderer.ts \
        packages/zai/src/web/src/components/superTasks/processEventRenderer.test.ts
git commit -m "feat(super-tasks): renderer — frame guards + main dispatch switch"
```

- [ ] **Step 1.14: TDD — system / user / assistant-text / thinking 四个 kind**

追加测试:

```ts
describe('system kind', () => {
  it('renders with subtype', () => {
    expect(toRendered(frame({
      seq: 1, ts: 1000, type: 'attach', eventId: 'x',
      raw: { type: 'system', subtype: 'init' },
    }))).toEqual({ kind: 'system', ts: 1000, seq: 1, sub: 'init' })
  })
  it('defaults subtype to init when missing', () => {
    expect(toRendered(frame({
      seq: 1, ts: 1000, type: 'attach', eventId: 'x',
      raw: { type: 'system' },
    }))).toEqual({ kind: 'system', ts: 1000, seq: 1, sub: 'init' })
  })
})

describe('user kind', () => {
  it('renders text + metadata', () => {
    expect(toRendered(frame({
      seq: 2, ts: 2000, type: 'attach', eventId: 'x',
      raw: {
        type: 'user',
        message: { content: [{ type: 'text', text: 'fix bug' }] },
        metadata: { cwd: '/tmp', agent: 'default' },
      },
    }))).toEqual({ kind: 'user', ts: 2000, seq: 2, text: 'fix bug', cwd: '/tmp', agent: 'default' })
  })
  it('renders without metadata', () => {
    expect(toRendered(frame({
      seq: 2, ts: 2000, type: 'attach', eventId: 'x',
      raw: { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } },
    }))).toEqual({ kind: 'user', ts: 2000, seq: 2, text: 'hi', cwd: undefined, agent: undefined })
  })
})

describe('assistant-text kind', () => {
  it('renders text block', () => {
    expect(toRendered(frame({
      seq: 3, ts: 3000, type: 'attach', eventId: 'x',
      raw: { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
    }))).toEqual({ kind: 'assistant-text', ts: 3000, seq: 3, text: 'hello' })
  })
})

describe('thinking kind', () => {
  it('renders thinking block', () => {
    expect(toRendered(frame({
      seq: 4, ts: 4000, type: 'attach', eventId: 'x',
      raw: { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'let me think' }] } },
    }))).toEqual({ kind: 'thinking', ts: 4000, seq: 4, text: 'let me think' })
  })
})
```

- [ ] **Step 1.15: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/processEventRenderer.test.ts`
Expected: PASS(所有 4 个 kind 已实现)

- [ ] **Step 1.16: 提交**

```bash
git add packages/zai/src/web/src/components/superTasks/processEventRenderer.ts \
        packages/zai/src/web/src/components/superTasks/processEventRenderer.test.ts
git commit -m "feat(super-tasks): renderer — system / user / assistant-text / thinking kinds"
```

- [ ] **Step 1.17: TDD — tool-use kind + 8 个工具名 summary**

追加测试:

```ts
describe('tool-use kind', () => {
  function tu(name: string, input: Record<string, unknown>, id = 'tu-1') {
    return frame({
      seq: 5, ts: 5000, type: 'attach', eventId: 'x',
      raw: { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } },
    })
  }
  it('Read uses file_path', () => {
    expect(toRendered(tu('Read', { file_path: '/a/b.ts' })))
      .toMatchObject({ kind: 'tool-use', name: 'Read', toolUseId: 'tu-1', summary: '/a/b.ts' })
  })
  it('Write uses file_path', () => {
    expect(toRendered(tu('Write', { file_path: '/a/c.ts' })))
      .toMatchObject({ summary: '/a/c.ts' })
  })
  it('Edit uses file_path', () => {
    expect(toRendered(tu('Edit', { file_path: '/a/d.ts' })))
      .toMatchObject({ summary: '/a/d.ts' })
  })
  it('Bash truncates command to 80 chars', () => {
    const long = 'x'.repeat(200)
    expect(toRendered(tu('Bash', { command: long })))
      .toMatchObject({ name: 'Bash', summary: 'x'.repeat(80) })
  })
  it('Grep uses pattern', () => {
    expect(toRendered(tu('Grep', { pattern: 'TODO' })))
      .toMatchObject({ summary: 'TODO' })
  })
  it('Glob combines pattern and path', () => {
    expect(toRendered(tu('Glob', { pattern: '*.ts', path: '/src' })))
      .toMatchObject({ summary: '*.ts · /src' })
  })
  it('Agent uses description when present', () => {
    expect(toRendered(tu('Agent', { description: 'search the code', prompt: 'long prompt...' })))
      .toMatchObject({ summary: 'search the code' })
  })
  it('Agent falls back to prompt when description missing', () => {
    expect(toRendered(tu('Agent', { prompt: 'do the thing' })))
      .toMatchObject({ summary: 'do the thing' })
  })
  it('Agent truncates long description to 60 chars', () => {
    expect(toRendered(tu('Agent', { description: 'x'.repeat(100) })))
      .toMatchObject({ summary: 'x'.repeat(60) })
  })
  it('unknown tool falls back to JSON.stringify(input).slice(0,80)', () => {
    expect(toRendered(tu('WeirdTool', { a: 1, b: 'hi' })))
      .toMatchObject({ summary: '{"a":1,"b":"hi"}' })
  })
  it('unknown tool truncates and adds ellipsis when JSON > 80 chars', () => {
    const big = { data: 'x'.repeat(200) }
    expect(toRendered(tu('WeirdTool', big)))
      .toMatchObject({ summary: expect.stringMatching(/…$/) })
    // 验证长度 <= 81(含省略号)
    const r = toRendered(tu('WeirdTool', big))
    if (r?.kind !== 'tool-use') throw new Error('precondition')
    expect(r.summary.length).toBeLessThanOrEqual(81)
  })
  it('preserves fullInput', () => {
    expect(toRendered(tu('Read', { file_path: '/a.ts', offset: 10 })))
      .toMatchObject({ fullInput: { file_path: '/a.ts', offset: 10 } })
  })
})
```

- [ ] **Step 1.18: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/processEventRenderer.test.ts`
Expected: PASS(`renderToolUse` + `toolSummary` 已在 Step 1.11 实现)

- [ ] **Step 1.19: 提交**

```bash
git add packages/zai/src/web/src/components/superTasks/processEventRenderer.ts \
        packages/zai/src/web/src/components/superTasks/processEventRenderer.test.ts
git commit -m "feat(super-tasks): renderer — tool-use kind + 8 summary rules"
```

- [ ] **Step 1.20: TDD — tool-result kind(string / array / is_error)**

追加测试:

```ts
describe('tool-result kind', () => {
  function tr(content: unknown, isError = false, toolUseId = 'tu-1') {
    return frame({
      seq: 6, ts: 6000, type: 'attach', eventId: 'x',
      raw: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] } },
    })
  }
  it('string content', () => {
    const r = toRendered(tr('hello world'))
    expect(r).toMatchObject({ kind: 'tool-result', toolUseId: 'tu-1', isError: false, fullContent: 'hello world' })
    if (r?.kind !== 'tool-result') throw new Error('precondition')
    expect(r.summary).toContain('hello world')
    expect(r.summary).toContain('1 lines')
  })
  it('multi-line string counts lines and previews first line', () => {
    const r = toRendered(tr('line1\nline2\nline3'))
    if (r?.kind !== 'tool-result') throw new Error('precondition')
    expect(r.summary).toMatch(/^line1 · 3 lines/)
  })
  it('array content joins text blocks', () => {
    const r = toRendered(tr([
      { type: 'text', text: 'foo' },
      { type: 'text', text: 'bar' },
    ]))
    if (r?.kind !== 'tool-result') throw new Error('precondition')
    expect(r.fullContent).toBe('foo\nbar')
    expect(r.summary).toContain('foo')
    expect(r.summary).toContain('2 lines')
  })
  it('array content skips non-text blocks (image / document)', () => {
    const r = toRendered(tr([
      { type: 'text', text: 'visible' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
    ]))
    if (r?.kind !== 'tool-result') throw new Error('precondition')
    expect(r.fullContent).toBe('visible')
  })
  it('is_error=true is preserved', () => {
    expect(toRendered(tr('boom', true))).toMatchObject({ kind: 'tool-result', isError: true })
  })
  it('truncates long first line in summary to 80 chars + ellipsis', () => {
    const long = 'x'.repeat(200)
    const r = toRendered(tr(long))
    if (r?.kind !== 'tool-result') throw new Error('precondition')
    // summary = "<preview> · N lines",preview 含省略号
    expect(r.summary).toContain('…')
  })
  it('preserves toolUseId', () => {
    expect(toRendered(tr('x', false, 'tu-99'))).toMatchObject({ toolUseId: 'tu-99' })
  })
})
```

- [ ] **Step 1.21: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/processEventRenderer.test.ts`
Expected: PASS

- [ ] **Step 1.22: 提交**

```bash
git add packages/zai/src/web/src/components/superTasks/processEventRenderer.ts \
        packages/zai/src/web/src/components/superTasks/processEventRenderer.test.ts
git commit -m "feat(super-tasks): renderer — tool-result kind"
```

- [ ] **Step 1.23: 类型检查 + 全量相关单测**

Run:
```
pnpm --filter @zn-ai/zai exec tsc --noEmit
pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/processEventRenderer.test.ts
```
Expected: tsc 0 error;vitest 全绿(约 35 个 case)

- [ ] **Step 1.24: 提交(若 tsc 有 format fix)**

如果 `pnpm exec tsc --noEmit` 提示格式化问题,跑 `pnpm exec prettier --write packages/zai/src/web/src/components/superTasks/processEventRenderer.ts packages/zai/src/web/src/components/superTasks/processEventRenderer.test.ts` 然后:

```bash
git add packages/zai/src/web/src/components/superTasks/processEventRenderer.ts \
        packages/zai/src/web/src/components/superTasks/processEventRenderer.test.ts
git commit -m "style(super-tasks): prettier-format processEventRenderer"
```

(若无需 format,跳过此步。)

---

### Task 2: 把 renderer 接入 `SuperTaskDetailDrawer.tsx`

**Files:**
- Modify: `packages/zai/src/web/src/components/superTasks/SuperTaskDetailDrawer.tsx`(全文 156 行,主要改 lines 1-7 imports + lines 100-134 Timeline children)

**Interfaces:**
- Consumes: `RenderedEvent` + `toRendered` from `./processEventRenderer`(Task 1)
- 保留原 `EventFrame` interface(本地 `id` / `event` / `data` 字段),不动 SSE 订阅 useEffect(60-80 行)
- Drawer 顶部状态文本、tabs 结构(spec.md / plan.md / process.md)、轮询不变

- [ ] **Step 2.1: 读 `SuperTaskDetailDrawer.tsx` 当前实现**

Read: `packages/zai/src/web/src/components/superTasks/SuperTaskDetailDrawer.tsx`
确认 lines 100-134 是执行过程 tab 的 children;确认 events state 类型 `EventFrame`;确认 imports。

- [ ] **Step 2.2: 改 imports**

替换 lines 1-7 的 imports:

```tsx
import { useEffect, useMemo, useState } from 'react'
import { Drawer, Tabs, Typography, Spin, Timeline, Collapse } from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchSuperTaskDetail } from '../../lib/superTaskApi'
import { subscribeTaskEvents } from '../../lib/taskApi'
import type { TaskDetails } from '../../lib/superTaskApi'
import { toRendered, type RenderedEvent } from './processEventRenderer'
```

- [ ] **Step 2.3: 加 `useMemo` 把 events 转成 rendered**

在 `events` state 声明之后(原 line 32 附近)、第一个 useEffect 之前,加:

```tsx
const rendered = useMemo(
  () => events.map(toRendered).filter((r): r is RenderedEvent => r !== null),
  [events],
)
```

- [ ] **Step 2.4: 加展开状态 hook**

紧随 `rendered` 之后加:

```tsx
const [expanded, setExpanded] = useState<Map<string, { input?: boolean; result?: boolean }>>(new Map())
const toggleExpand = (toolUseId: string, key: 'input' | 'result'): void => {
  setExpanded((prev) => {
    const next = new Map(prev)
    const cur = next.get(toolUseId) ?? {}
    next.set(toolUseId, { ...cur, [key]: !cur[key] })
    return next
  })
}
```

- [ ] **Step 2.5: 加辅助函数 `dotColor` + `renderEvent`**

放在文件顶部(紧跟 imports 之后、export default 之前):

```tsx
function dotColor(r: RenderedEvent): string {
  if (r.kind === 'task-ended') {
    return r.status === 'completed' ? 'green' : r.status === 'failed' ? 'red' : 'gray'
  }
  if (r.kind === 'system' || r.kind === 'thinking') return 'gray'
  if (r.kind === 'user') return 'green'
  if (r.kind === 'assistant-text') return 'blue'
  if (r.kind === 'tool-use') return 'purple'
  return r.kind === 'tool-result' && r.isError ? 'red' : 'gray'
}
```

把原来的 `events.map((e) => { ... })` 整块(life 105-127)替换成下面这段。**关键**:`events.length > 0 ? <Timeline ...> : <等待文本>` 这层外壳保留。

```tsx
{events.length > 0 ? (
  <Timeline
    items={rendered.map((r, i) => ({
      key: String(i),
      color: dotColor(r),
      children: <RenderedEventRow event={r} expanded={expanded} onToggle={toggleExpand} />,
    }))}
  />
) : (
  <Typography.Text type="secondary">等待执行事件...</Typography.Text>
)}
```

(新增的 `RenderedEventRow` 子组件在 Step 2.6 写。)

- [ ] **Step 2.6: 新增 `RenderedEventRow` 子组件**

放在 `dotColor` 之后、`export default` 之前:

```tsx
function RenderedEventRow({
  event, expanded, onToggle,
}: {
  event: RenderedEvent
  expanded: Map<string, { input?: boolean; result?: boolean }>
  onToggle: (toolUseId: string, key: 'input' | 'result') => void
}): JSX.Element {
  switch (event.kind) {
    case 'system':
      return <Typography.Text type="secondary">[{event.sub}]</Typography.Text>
    case 'user':
      return (
        <>
          <blockquote style={{ margin: '4px 0', padding: '4px 8px', borderLeft: '3px solid #52c41a', background: 'rgba(82,196,26,0.05)' }}>
            {event.text}
          </blockquote>
          {(event.cwd || event.agent) && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {event.cwd && `cwd: ${event.cwd}`}{event.cwd && event.agent && ' · '}{event.agent && `agent: ${event.agent}`}
            </Typography.Text>
          )}
        </>
      )
    case 'assistant-text':
      return <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.text}</ReactMarkdown>
    case 'thinking':
      return (
        <Collapse size="small" ghost>
          <Collapse.Panel header="[思考]" key={`t-${event.seq}`}>
            <Typography.Text type="secondary" italic>{event.text}</Typography.Text>
          </Collapse.Panel>
        </Collapse>
      )
    case 'tool-use': {
      const isOpen = expanded.get(event.toolUseId)?.input === true
      const resultOpen = expanded.get(event.toolUseId)?.result === true
      return (
        <div>
          <a onClick={() => onToggle(event.toolUseId, 'input')} style={{ cursor: 'pointer' }}>
            <Typography.Text strong style={{ color: '#722ed1' }}>[Tool: {event.name}]</Typography.Text>{' '}
            <Typography.Text>{event.summary}</Typography.Text>{' '}
            <Typography.Text type="secondary">{isOpen ? '▴' : '▾'}</Typography.Text>
          </a>
          {isOpen && (
            <pre style={{
              maxHeight: 240, overflow: 'auto', background: '#fafafa',
              padding: 8, borderRadius: 4, fontSize: 12, margin: '4px 0',
            }}>
              {JSON.stringify(event.fullInput, null, 2)}
            </pre>
          )}
          {resultOpen && (
            <div style={{ marginLeft: 16, marginTop: 4 }}>
              <Typography.Text type="secondary">[result]</Typography.Text>
              <pre style={{
                maxHeight: 240, overflow: 'auto', background: '#fafafa',
                padding: 8, borderRadius: 4, fontSize: 12,
              }}>
                {/* result 实际内容由同 toolUseId 的 tool-result 帧渲染,这里先放 placeholder */}
                <em style={{ color: '#999' }}>等待结果...</em>
              </pre>
            </div>
          )}
        </div>
      )
    }
    case 'tool-result': {
      const isOpen = expanded.get(event.toolUseId)?.result === true
      const errColor = event.isError ? '#f5222d' : '#999'
      return (
        <div style={{ marginLeft: 16 }}>
          <a onClick={() => onToggle(event.toolUseId, 'result')} style={{ cursor: 'pointer' }}>
            <Typography.Text type="secondary">↳ result · {event.summary}</Typography.Text>{' '}
            <Typography.Text style={{ color: errColor }}>{isOpen ? '▴' : '▾'}</Typography.Text>
          </a>
          {isOpen && (
            <pre style={{
              maxHeight: 240, overflow: 'auto', background: event.isError ? '#fff1f0' : '#fafafa',
              padding: 8, borderRadius: 4, fontSize: 12, margin: '4px 0',
              border: event.isError ? '1px solid #ffccc7' : 'none',
            }}>
              {event.fullContent || '(empty)'}
            </pre>
          )}
        </div>
      )
    }
    case 'task-ended':
      if (event.status === 'completed') {
        return <Typography.Text strong style={{ color: '#52c41a' }}>✓ 任务完成{event.resultText ? `: ${event.resultText.slice(0, 80)}` : ''}</Typography.Text>
      }
      if (event.status === 'failed') {
        return <Typography.Text strong style={{ color: '#f5222d' }}>✗ 失败{event.error ? `: ${event.error}` : ''}</Typography.Text>
      }
      return <Typography.Text type="secondary">− 已取消</Typography.Text>
  }
}
```

(注:tool-result 已在自己的 Timeline item 中渲染,**不**嵌入到 tool-use 行的 result 槽里 — 后者只放 placeholder,等 tool-result 帧抵达时它独立 item 已渲染。两个独立 item 之间通过相同 toolUseId 共享展开 state。)

- [ ] **Step 2.7: 加 Timeline maxHeight**

把外层 Timeline 包一层 `<div style={{ maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' }}>`:

```tsx
{events.length > 0 ? (
  <div style={{ maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' }}>
    <Timeline ... />
  </div>
) : ...}
```

- [ ] **Step 2.8: 类型检查**

Run: `pnpm --filter @zn-ai/zai exec tsc --noEmit`
Expected: 0 error

若 prettier/format 警告,跑 `pnpm --filter @zn-ai/zai exec prettier --write packages/zai/src/web/src/components/superTasks/SuperTaskDetailDrawer.tsx`。

- [ ] **Step 2.9: 跑相关单测(应仍绿)**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/processEventRenderer.test.ts`
Expected: PASS(Drawer 改动不影响纯函数)

- [ ] **Step 2.10: 提交**

```bash
git add packages/zai/src/web/src/components/superTasks/SuperTaskDetailDrawer.tsx
git commit -m "feat(super-tasks): wire processEventRenderer into execution tab"
```

---

### Task 3: 真实浏览器验收(ego-browser)

**Files:**
- 不改代码;只起服务 + 跑流程 + 截图

**前置**:
- `lsof -i :8102` / `lsof -i :7715` 确认空闲(AGENTS.md 强制);若被占换 `--port 8103 --api-port 7716`
- ego-browser skill 已安装(若首次使用按 skill 文档初始化)

- [ ] **Step 3.1: 起 zai dev**

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715
```

`run_in_background: true`,保留 task_id 给后续步骤用。

- [ ] **Step 3.2: 等服务就绪**

Poll `curl -sf http://localhost:8102/api/super-tasks | head -c 200` 至返回 200(JSON 输出)。若 30s 内未就绪,检查 dev 日志。

- [ ] **Step 3.3: 准备一个 processing 状态的 task**

任务工厂当前主线(参见 `git log --oneline | head -5`)很可能已有 processing task。若没有,UI 上手动创建一个简单的 task 让它进入 processing,executor 会派生子 agent 触发事件流。

- [ ] **Step 3.4: 启动 ego-browser 跑流程**

按 `/ego-browser` skill 流程(参见 `~/.zai/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/` 或该 skill 的 SKILL.md):
- 打开 `http://localhost:8102/super-tasks`
- 等页面加载
- 截全屏,记为 `/tmp/super-tasks-list.png`
- 点开一个 processing 任务的「详情」按钮
- 等抽屉 + 执行过程 tab 加载
- 截抽屉全屏,记为 `/tmp/super-tasks-detail.png`
- **断言清单**(截图后人工/视觉检查):
  1. 列表 system / assistant-text / user / tool-use / tool-result 各种 kind 都至少出现一次
  2. assistant-text 渲染成 markdown(链接/列表/代码块格式正确)
  3. tool-use 一行形如 `[Tool: Read] /a/b.ts ▾`
  4. 点击 tool-use 行 → input JSON 展开(▴),再次点击收起(▾)
  5. tool-result 独立 item,点击展开 result 内容,error 帧背景红色
  6. thinking kind 折叠面板显示「[思考] ▾」,点击展开
  7. Timeline 高度受限(>100 事件时滚动条出现)
  8. 切到 spec.md tab → 渲染原 markdown,无白屏
  9. 切到 plan.md tab → 同上
  10. 切到 process.md tab → 同上
- 截抽屉执行过程 tab 终态,记为 `/tmp/super-tasks-execution.png`

- [ ] **Step 3.5: 关闭 dev 服务**

把 Step 3.1 的 background task 用 TaskStop 停掉。验证 8102/7715 释放。

- [ ] **Step 3.6: 记录验收到 process.md**

按 task 工厂惯例,在任务目录的 `process.md` 追加一段(若已存在则 Edit 追加;若不存在 Write 创建):

```markdown
## 执行过程 Tab 事件渲染修复 — 验收

- 改动:Task 1 (renderer TDD) + Task 2 (Drawer wiring)
- 验收时间:2026-09-02
- 验收方式:`/ego-browser` 真实浏览器
- 截图:
  - /tmp/super-tasks-list.png
  - /tmp/super-tasks-detail.png
  - /tmp/super-tasks-execution.png
- 断言结果:6 种 kind 渲染正确;tool-use 展开/折叠正常;tool-result error 颜色正确;4 个 tab 切换无回归
```

任务目录:`/Users/ethan/.zai/task-factory/queue-tasks/<taskId>/process.md` 或 `processing-tasks/<taskId>/process.md`(取决于当前任务在哪个桶;用 `ls ~/.zai/task-factory/*-tasks/` 看一眼当前任务的 `id` 字段,与 `index.md` 的 title 匹配上即可)。

- [ ] **Step 3.7: 提交验收记录**

```bash
git add ~/.zai/task-factory/*-tasks/<taskId>/process.md
# 注意 ~/.zai 不在 opencc-web repo,这里是直接修改 zai 全局 task 目录,
# 不需要 git commit。如果任务目录未来纳入版本管理,改这里。
```

若项目根 `.zai/` 影子目录也维护了 task 文件(`opencc-web/.zai/task-factory/...`),检查同步。

- [ ] **Step 3.8: 整体完工确认**

Run(只跑相关):
```
pnpm --filter @zn-ai/zai exec tsc --noEmit
pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/processEventRenderer.test.ts
git status
git log --oneline -5
```

Expected:
- tsc 0 error
- vitest 全绿
- git status 干净(若 `.zai/` 影子目录被改,确认是否需要 commit)
- 看到本任务 3 个 commit(`scaffold` + 6 个 kind + wiring)

---

## Self-Review(写完 plan 后我自己跑了一遍)

**Spec 覆盖检查**:spec 七大节全部对应到 task。
- Problem(渲染 raw JSON) → Task 1 提供正确渲染 + Task 2 接入
- Decision(纯函数模块) → Task 1 全部围绕 `processEventRenderer.ts` 纯函数
- 架构(`processEventRenderer.ts` + Drawer 改 30 行) → Task 1 + Task 2 文件清单对齐
- 数据模型(7 种 `RenderedEvent` union) → Task 1 Step 1.1 类型定义完整
- 翻译规则表 → Task 1 Step 1.4-1.22 每个 kind 一个 TDD cycle
- 跳过策略 → Task 1 Step 1.9-1.13 frame guards
- Timeline 渲染映射 → Task 2 Step 2.5-2.6 switch 全 case
- 展开交互 → Task 2 Step 2.4 + 2.6 `expanded` state + `toggleExpand`
- 错误处理 → Task 1 Step 1.9-1.13 + Step 1.20 array content 跳过非 text
- 测试 → Task 1 8 个 TDD cycle + Task 2 Step 2.9 相关单测
- 真实浏览器验收 → Task 3 全 step
- 回归风险(不动 SSE 协议 / Drawer useEffect 数据流) → Task 2 只动 imports + Timeline children + 加辅助函数,SSE 订阅(life 63-80)未触

**Placeholder 检查**:无 TBD / TODO / "implement later"。所有代码块完整。

**类型一致性**:
- `toRendered(frame: SseFrame): RenderedEvent | null` → Step 1.1 定义,Step 1.4+ 全部测试用此签名
- `RenderedEvent` 7 个 kind 的字段名 → Task 1 全文统一(seq/ts/text/sub/cwd/agent/name/toolUseId/summary/fullInput/isError/fullContent/status/error/resultText)
- `expanded: Map<string, { input?: boolean; result?: boolean }>` → Step 2.4 定义,Step 2.6 RenderedEventRow 引用相同 shape
- `toggleExpand(toolUseId: string, key: 'input' | 'result')` → Step 2.4 定义,Step 2.6 调用一致

**可能争议**:
- Task 2 Step 2.6 注释里说"tool-result 实际内容由同 toolUseId 的 tool-result 帧渲染" — 实际上两个 frame 都是独立 Timeline item,各自渲染自己;`expanded` Map 共享是为了一个点击两边同步(目前只实现"两边独立展开",用户感知一致)。这是 spec 行为,无需变更。
- Step 3.6 process.md 路径用 `~/.zai/task-factory/...`,与 `~/.zai` 全局目录约定一致;若项目根 `.zai/` 影子目录与全局不一致,以全局为准(AGENTS.md "运行时数据" 段)。

完整。一致。可执行。
