# Sub-agent 工具输入单行展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修改子代理输出面板，使工具调用只显示单行输入摘要和状态，不显示工具结果或错误正文。

**Architecture:** 保留现有 SSE 事件和 `buildTimeline` 聚合流程，仅将 `ToolCallEntry` 收敛为输入与状态，并由纯格式化函数生成一行展示文本。测试直接覆盖格式化函数和时间线聚合结果，避免依赖 Drawer、Ant Design 或真实 SSE。

**Tech Stack:** React 18、TypeScript、Vitest、现有 `packages/zai` Web UI。

## Global Constraints

- 只修改 `packages/zai/src/web/src/components/TaskDrawer.tsx` 及其测试文件。
- 不修改后台 Agent、SSE 服务端协议或工具实际返回值。
- 工具完成、失败、非法、拒绝事件不把 `output` 或 `error` 写入前端工具条目。
- 工具调用显示为单行，`Read` 示例格式必须为 `Read: @/path/package.json (Done)`。
- Done 状态文字靠右显示为绿色，进行中状态文字靠右显示为黄色，失败/非法/拒绝状态文字靠右显示为红色。
- 长输入不换行，以省略号截断，并通过 `title` 保留完整单行文本。
- 不自动创建 Git commit；仅在用户明确要求时提交。

---

### Task 1: 为工具输入单行格式和结果脱敏行为编写失败测试

**Files:**
- Create: `packages/zai/src/web/src/components/TaskDrawer.test.tsx`
- Reference: `packages/zai/src/web/src/components/TaskDrawer.tsx:16-243`

**Interfaces:**
- Consumes: 计划中 Task 2 将提供的 `formatToolInput`, `formatToolCallLine`, `buildTimeline` named exports。
- Produces: 可独立验证工具输入格式、状态标签和时间线不保存结果正文的测试。

- [ ] **Step 1: 创建测试文件并写入失败测试**

```tsx
// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest'
import { buildTimeline, formatToolCallLine, formatToolInput } from './TaskDrawer.js'

describe('formatToolInput', () => {
  test('Read 使用 @ 前缀显示文件路径', () => {
    expect(formatToolInput('Read', { file_path: '/Users/demo/package.json' })).toBe(
      '@/Users/demo/package.json',
    )
  })

  test('路径、命令和查询输入都压缩为单行', () => {
    expect(formatToolInput('Bash', { command: 'pwd\nls' })).toBe('command=pwd ls')
    expect(formatToolInput('Grep', { query: 'tool\noutput' })).toBe('query=tool output')
    expect(formatToolInput('Custom', { value: 'a\nb' })).toBe('{"value":"a b"}')
  })
})

describe('formatToolCallLine', () => {
  test('完成的 Read 工具显示输入和 Done，不显示结果', () => {
    expect(
      formatToolCallLine({
        name: 'Read',
        input: { file_path: '/Users/demo/package.json' },
        status: 'done',
      }),
    ).toBe('Read: @/Users/demo/package.json (Done)')
  })
})

describe('buildTimeline', () => {
  test('工具完成事件只更新状态，不保存 output', () => {
    const timeline = buildTimeline([
      {
        seq: 1,
        type: 'tool_use:start',
        ts: 100,
        data: {
          toolUseId: 'tool-1',
          name: 'Read',
          input: { file_path: '/Users/demo/package.json' },
        },
      },
      {
        seq: 2,
        type: 'tool_use:done',
        ts: 200,
        data: { toolUseId: 'tool-1', output: 'secret file contents' },
      },
    ])

    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({
      kind: 'tool',
      entry: {
        toolUseId: 'tool-1',
        name: 'Read',
        input: { file_path: '/Users/demo/package.json' },
        status: 'done',
      },
    })
    expect(JSON.stringify(timeline)).not.toContain('secret file contents')
  })

  test('工具失败事件只更新状态，不保存 error', () => {
    const timeline = buildTimeline([
      {
        seq: 1,
        type: 'tool_use:start',
        ts: 100,
        data: { toolUseId: 'tool-2', name: 'Read', input: { file_path: '/tmp/a' } },
      },
      {
        seq: 2,
        type: 'tool_use:error',
        ts: 200,
        data: { toolUseId: 'tool-2', error: { message: 'secret error' } },
      },
    ])

    expect(timeline[0]).toMatchObject({ kind: 'tool', entry: { status: 'error' } })
    expect(JSON.stringify(timeline)).not.toContain('secret error')
  })
})
```

- [ ] **Step 2: 运行定向测试，确认当前实现失败**

Run: `npm --prefix packages/zai run test -- src/web/src/components/TaskDrawer.test.tsx`

Expected: FAIL，因为当前 `TaskDrawer.tsx` 没有导出格式化函数，且当前 `buildTimeline` 会把 `output`/`error` 写入工具条目。

---

### Task 2: 实现工具输入格式化和时间线脱敏

**Files:**
- Modify: `packages/zai/src/web/src/components/TaskDrawer.tsx:16-170`
- Modify: `packages/zai/src/web/src/components/TaskDrawer.tsx:202-243`

**Interfaces:**
- Consumes: Task 1 中定义的输入格式和状态断言。
- Produces:
  - `export function formatToolInput(name: string, input: unknown): string`
  - `export function formatToolCallLine(entry: Pick<ToolCallEntry, 'name' | 'input' | 'status'>): string`
  - `export function buildTimeline(...)`，保持现有返回结构，仅移除工具结果字段。

- [ ] **Step 1: 删除工具条目的 `output` 和 `error` 字段**

将 `ToolCallEntry` 改为：

```ts
interface ToolCallEntry {
  toolUseId: string
  name: string
  input?: unknown
  status: 'running' | 'done' | 'error' | 'invalid' | 'denied'
  ts: number
}
```

- [ ] **Step 2: 添加单行输入和状态格式化函数**

在 `formatDuration` 后加入以下函数；同时删除不再需要的多行 `formatJson` 实现：

```tsx
const TOOL_STATUS_LABEL: Record<ToolCallEntry['status'], string> = {
  running: 'Running',
  done: 'Done',
  error: 'Error',
  invalid: 'Invalid',
  denied: 'Denied',
}

function compactInput(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    return (serialized ?? String(value)).replace(/\\[ntr]|\s+/g, ' ')
  } catch {
    return String(value).replace(/\s+/g, ' ')
  }
}

export function formatToolInput(name: string, input: unknown): string {
  if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim()
  if (!input || typeof input !== 'object' || Array.isArray(input)) return compactInput(input)

  const record = input as Record<string, unknown>
  const filePath =
    typeof record.file_path === 'string'
      ? record.file_path
      : typeof record.path === 'string'
        ? record.path
        : undefined
  if (filePath) return name.toLowerCase() === 'read' ? `@${filePath}` : `path=@${filePath}`

  if (typeof record.command === 'string') return `command=${record.command.replace(/\s+/g, ' ').trim()}`
  if (typeof record.query === 'string') return `query=${record.query.replace(/\s+/g, ' ').trim()}`

  return compactInput(record)
}

export function formatToolCallLine(
  entry: Pick<ToolCallEntry, 'name' | 'input' | 'status'>,
): string {
  return `${entry.name}: ${formatToolInput(entry.name, entry.input)} (${TOOL_STATUS_LABEL[entry.status]})`
}
```

`name` 参数保留在 `formatToolInput` 签名中，确保 `Read` 及后续同类工具可以按工具名扩展格式，而当前路径字段规则已经覆盖 `Read` 示例。

- [ ] **Step 3: 将 `ToolCallCard` 替换为单行渲染**

保留现有状态边框颜色，删除 input/output/error 的 `<details>`、`<pre>` 区块，使用以下 JSX：

```tsx
export function ToolCallCard({ entry }: { entry: ToolCallEntry }) {
  const statusColor =
    entry.status === 'done'
      ? '#52c41a'
      : entry.status === 'running'
        ? '#fadb14'
        : '#f5222d'
  const inputLine = `${entry.name}: ${formatToolInput(entry.name, entry.input)}`
  const fullLine = formatToolCallLine(entry)

  return (
    <div
      title={fullLine}
      style={{
        borderLeft: `3px solid ${statusColor}`,
        background: 'rgba(255,255,255,0.04)',
        padding: '8px 12px',
        borderRadius: 4,
        margin: '6px 0',
        fontSize: 12,
        fontFamily: 'ui-monospace, monospace',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
      }}
    >
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {inputLine}
      </span>
      <span style={{ marginLeft: 'auto', flexShrink: 0, color: statusColor }}>
        {TOOL_STATUS_LABEL[entry.status]}
      </span>
    </div>
  )
}
```

- [ ] **Step 4: 只更新工具状态，不保存完成结果或错误正文**

在 `buildTimeline` 的工具事件分支中，将状态更新部分改为：

```ts
if (ev.type === 'tool_use:done') {
  existing.status = 'done'
} else if (ev.type === 'tool_use:error') {
  existing.status = 'error'
} else if (ev.type === 'tool_use:invalid') {
  existing.status = 'invalid'
} else if (ev.type === 'tool_use:denied') {
  existing.status = 'denied'
}
```

不要从 `data` 读取或写入 `output`、`error`，并保留现有 `toolById` 查找、时间线替换和非工具事件逻辑。

- [ ] **Step 5: 运行定向测试，确认实现通过**

Run: `npm --prefix packages/zai run test -- src/web/src/components/TaskDrawer.test.tsx`

Expected: PASS，所有输入格式、Done 状态和结果脱敏断言通过。

---

### Task 3: 运行完整验证

**Files:**
- Verify: `packages/zai/src/web/src/components/TaskDrawer.tsx`
- Verify: `packages/zai/src/web/src/components/TaskDrawer.test.tsx`

**Interfaces:**
- Consumes: Task 2 的单行渲染和无结果时间线。
- Produces: 通过测试、类型检查和构建的可交付改动。

- [ ] **Step 1: 运行 `packages/zai` 全量测试**

Run: `npm --prefix packages/zai run test`

Expected: PASS，现有测试及新增 `TaskDrawer.test.tsx` 均通过。

- [ ] **Step 2: 运行类型检查**

Run: `npm --prefix packages/zai run typecheck`

Expected: PASS，无 TypeScript 错误。

- [ ] **Step 3: 运行生产构建**

Run: `npm --prefix packages/zai run build`

Expected: PASS，TypeScript 和 Vite Web 构建均完成。

- [ ] **Step 4: 复核最终行为**

确认 `TaskDrawer.tsx` 中不存在工具卡片对 `entry.output`、`entry.error` 的渲染或赋值；确认单行样式包含 `whiteSpace: 'nowrap'`、`overflow: 'hidden'` 和 `textOverflow: 'ellipsis'`；确认 `Read` 的完成展示文本为 `Read: @<file_path> (Done)`。

不要提交 Git commit，除非用户明确要求提交。

---

## 文件变更总览

- Create: `packages/zai/src/web/src/components/TaskDrawer.test.tsx` — 工具输入格式化与时间线脱敏测试。
- Modify: `packages/zai/src/web/src/components/TaskDrawer.tsx` — 删除结果字段、添加单行格式化、更新工具卡片渲染。
- Existing design: `docs/superpowers/specs/2026-07-16-subagent-tool-input-display-design.md` — 已确认的设计文档，不再修改。

## 计划自检

- 需求覆盖：仅保留输入、保留完成状态、单行展示、隐藏 output/error、保留非工具事件行为均由 Task 1-3 覆盖。
- 无占位符：所有步骤包含具体文件、命令、函数签名或代码片段，没有 TBD/TODO。
- 类型一致：Task 1 使用的三个 named exports 由 Task 2 明确定义；`ToolCallEntry` 状态联合类型在格式化函数和时间线中一致。
- 范围一致：只涉及前端 TaskDrawer 及其纯逻辑测试，不修改后端或 SSE 协议。
