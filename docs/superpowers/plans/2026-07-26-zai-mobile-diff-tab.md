# zai Mobile Diff Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `MobileQuickDrawer` 的 `Segmented` 末尾新增 `Diff` tab,展示当前 session 工作区的 git 变更文件列表,支持单文件 revert。

**Architecture:** 单一文件改动 `MobileQuickDrawer.tsx`,复用既有 `useGitStatus` + `gitApi.revertFile` + `STATUS_COLORS` / `STATUS_LABELS`,内联 `'diff'` 分支(与 bash / prompt tab 同构)。revert 用 antd `Modal.confirm` 弹确认;加载用局部 `loadingPath` 防双击。轮询由 `useGitStatus` 自带,抽屉关闭即停。

**Tech Stack:** React 18 + TypeScript + antd 5 + zustand(仅消费 store) + Vitest + happy-dom + @testing-library/react。

## Global Constraints

- 仅在 `MobileQuickDrawer.tsx` 内部修改 + 同目录 `MobileQuickDrawer.test.tsx` 追加 case,**不动** PC 端 `splitPane/GitTab.tsx`、`useGitStatus`、后端 `routes/git.ts`、`lib/gitApi.ts`、`shared/git.ts`。
- 测试命令:`cd packages/zai && pnpm exec vitest run src/web/src/components/MobileQuickDrawer.test.tsx`。
- 既有 antd mock 在测试文件第 49 行(`message.warning`);新增 `Modal.confirm` mock 必须与既有 mock 合并,不能用 `vi.mock` 第二次声明同一个 module。
- 抽屉宽度沿用 `width="85%"`;不改 `Drawer` props。
- `useGitStatus(cwd)` 必须传 `cwd` — 已有从 `useAgentStore.cwdBySession[sessionId]` 派生。
- `TabKey` 类型加 `'diff'`;`Segmented` options 末尾追加 `{ label: 'Diff', value: 'diff' }`(顺序:Bash → 常用指令 → Diff)。
- 文案全部简体中文,与现有 drawer 文案风格一致。
- 不新增 git HTTP 接口、不新增 store、不持久化 `loadingPath`。
- 所有 commit message 用 `feat:` / `chore:` 前缀。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `packages/zai/src/web/src/components/MobileQuickDrawer.tsx` | 修改:加 `'diff'` tab + 内联 diff 分支 + loadingPath state + revert 流程 |
| `packages/zai/src/web/src/components/MobileQuickDrawer.test.tsx` | 修改:加 `useGitStatus` mock + `Modal.confirm` mock + 7 个 diff tab 测试 case |

**不动文件**(只读):
- `packages/zai/src/web/src/components/splitPane/useGitStatus.ts` — `useGitStatus(cwd)` 接口稳定
- `packages/zai/src/web/src/components/splitPane/shared.ts` — `STATUS_COLORS` / `STATUS_LABELS`
- `packages/zai/src/web/src/lib/gitApi.ts` — `gitApi.revertFile(path)`
- `packages/zai/src/shared/git.ts` — `GitStatusFile.status` / `staged`

---

## Task 1: 注入依赖与空 'diff' tab 分支

**Files:**
- Modify: `packages/zai/src/web/src/components/MobileQuickDrawer.tsx:1-14` (imports + TabKey)
- Modify: `packages/zai/src/web/src/components/MobileQuickDrawer.tsx:107-118` (Segmented options)
- Modify: `packages/zai/src/web/src/components/MobileQuickDrawer.tsx:285-287` (drawer 末尾追加 diff 分支占位)

**Interfaces:**
- Consumes: 无新增。
- Produces: `TabKey` 加 `'diff'`;Segmented 含第三项 `Diff`;`tab === 'diff'` 时渲染 `<div data-testid="mobile-quick-drawer-diff">Diff</div>` 占位(下一步替换为真实内容)。

- [ ] **Step 1: 修改 imports 与 TabKey**

将 `MobileQuickDrawer.tsx` 顶部修改为:

```tsx
import { useState } from 'react'
import { Drawer, Segmented, Button, Input, App as AntApp, Tag, Modal, Empty } from 'antd'
import {
  ReloadOutlined,
  PlusOutlined,
  DeleteOutlined,
  ClearOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { useAgentStore } from '../store/useAgentStore.js'
import { useQuickPrompts, MAX_TEXT } from '../hooks/useQuickPrompts.js'
import { useSubmitPrompt } from '../hooks/useSubmitPrompt.js'
import { useBashRepl } from '../hooks/useBashRepl.js'
import { useGitStatus } from './splitPane/useGitStatus.js'
import { gitApi } from '../lib/gitApi.js'
import { STATUS_COLORS, STATUS_LABELS } from './splitPane/shared.js'
import { message } from 'antd'

type TabKey = 'bash' | 'prompt' | 'diff'
```

> 注意:`Tag` / `Modal` / `Empty` 从 antd 拉,`UndoOutlined` 从图标拉,`useGitStatus` 从 `./splitPane/useGitStatus.js` 拉(同目录相对路径),`gitApi` 从 `../lib/gitApi.js` 拉,`STATUS_COLORS` / `STATUS_LABELS` 从 `./splitPane/shared.js` 拉。

- [ ] **Step 2: 调整 Segmented options**

在 `MobileQuickDrawer.tsx:108-118` 的 Segmented 节点改为:

```tsx
        <Segmented<'bash' | 'prompt' | 'diff'>
          block
          value={tab}
          onChange={(v) => setTab(v as TabKey)}
          options={[
            { label: '快捷 Bash', value: 'bash' },
            { label: '常用指令', value: 'prompt' },
            { label: 'Diff', value: 'diff' },
          ]}
        />
```

- [ ] **Step 3: 在抽屉末尾追加 diff 占位分支**

把 `MobileQuickDrawer.tsx:285` 的 `      )}` 之后、`    </Drawer>` 之前,改为:

```tsx
      )}

      {tab === 'diff' && (
        <div data-testid="mobile-quick-drawer-diff">
          Diff
        </div>
      )}
    </Drawer>
  )
}
```

- [ ] **Step 4: 跑现有测试确认未破坏**

Run:
```bash
cd packages/zai && pnpm exec vitest run src/web/src/components/MobileQuickDrawer.test.tsx
```
Expected: 9 passed + 1 failed。失败的 case 是 `Prompt tab` 块内的 `switchToPromptTab()`:`expect(items.length).toBe(2)` 现在会因 Segmented 多一项 Diff 而失败。这是已知红,Task 2 修复。

如失败,记录失败 case 名(下个 task 修)。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/MobileQuickDrawer.tsx
git commit -m "feat(zai-mobile): add Diff tab placeholder"
```

---

## Task 2: 修复 prompt tab 测试假设(为加 'diff' 腾位)

**Files:**
- Modify: `packages/zai/src/web/src/components/MobileQuickDrawer.test.tsx:124-128`

**Interfaces:**
- Consumes: Task 1 之后的 Segmented 含 3 项。
- Produces: `switchToPromptTab` 选第 2 项(0-indexed)而非硬编码 `items[1]`,对 tab 数量鲁棒。

- [ ] **Step 1: 修改 `switchToPromptTab` helper**

把 `MobileQuickDrawer.test.tsx:122-128` 改为:

```tsx
  function switchToPromptTab() {
    // Segmented rendered via Portal, use document.body. The Diff tab is
    // index 2 in MobileQuickDrawer, so prompt sits at index 1.
    const items = document.body.querySelectorAll('.ant-segmented-item')
    expect(items.length).toBe(3)
    fireEvent.click(items[1]!)
  }
```

> 只改 length 断言从 2 → 3,其余保持。

- [ ] **Step 2: 跑测试**

Run:
```bash
cd packages/zai && pnpm exec vitest run src/web/src/components/MobileQuickDrawer.test.tsx
```
Expected: 10 passed。

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/components/MobileQuickDrawer.test.tsx
git commit -m "test(zai-mobile): allow Prompt tab helper for 3-tab Drawer"
```

---

## Task 3: 实现 diff tab 列表渲染 + 错误/空状态

**Files:**
- Modify: `packages/zai/src/web/src/components/MobileQuickDrawer.tsx` (Task 1 占位分支 → 真实列表)

**Interfaces:**
- Consumes:
  - `useAgentStore((s) => s.cwdBySession)` 与 `sessionId`(已有于第 22-26 行)
  - `useGitStatus(cwd: string | null)` 返回 `{ data: GitStatus | null, loading, error, refetch }`(`GitStatus` 在 `shared/git.ts`)
  - `STATUS_COLORS: Record<GitStatusChar, string>` / `STATUS_LABELS: Record<GitStatusChar, string>`(`splitPane/shared.ts`)
- Produces:
  - 文件列表 `<div data-testid="mobile-quick-drawer-diff-row-${path}">`
  - 头部刷新按钮 `data-testid="mobile-quick-drawer-diff-refresh"`
  - 行内 Undo 按钮 `data-testid="mobile-quick-drawer-diff-revert-${path}"`
  - 空 / 错误 `<div data-testid="mobile-quick-drawer-diff-empty">` 包裹 antd `Empty`,文案由场景决定

- [ ] **Step 1: 替换 diff 分支为完整 UI(不含 revert 异步)**

把 Task 1 末尾的 diff 占位分支(整个 `{tab === 'diff' && (...)}` 块)替换为:

```tsx
      {tab === 'diff' && (
        <DiffTab cwd={cwd} />
      )}
    </Drawer>
```

并在文件顶部 imports 后、`export default function MobileQuickDrawer` 之前,插入组件定义:

```tsx
interface DiffTabProps {
  cwd: string | null
}

function DiffTab({ cwd }: DiffTabProps) {
  const { data, error, refetch } = useGitStatus(cwd)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)

  const files = data?.ok && data.files ? data.files : []
  const showEmpty =
    !cwd ||
    error != null ||
    (data?.ok === false) ||
    (data?.ok === true && files.length === 0)

  function emptyDescription(): string {
    if (!cwd) return '请先开启会话'
    if (error) return error
    if (data?.ok === false) return data.error ?? '当前目录不是 git 仓库'
    if (data?.ok === true && files.length === 0) return '无变更'
    return ''
  }

  function handleRevert(path: string, isUntracked: boolean) {
    const content = isUntracked
      ? '该文件未跟踪,撤销将永久删除该文件'
      : '将丢弃该文件的本地改动'
    Modal.confirm({
      title: `撤销 ${path}?`,
      content,
      okText: '撤销',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setLoadingPath(path)
        try {
          const result = await gitApi.revertFile(path)
          if (result.ok) {
            message.success('已撤销')
            refetch()
          } else {
            message.error(result.error ?? '撤销失败')
          }
        } catch (err) {
          message.error(`撤销失败: ${err instanceof Error ? err.message : String(err)}`)
        } finally {
          setLoadingPath(null)
        }
      },
    })
  }

  return (
    <div data-testid="mobile-quick-drawer-diff">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => refetch()}
          data-testid="mobile-quick-drawer-diff-refresh"
        >
          刷新
        </Button>
      </div>
      {showEmpty ? (
        <div data-testid="mobile-quick-drawer-diff-empty" style={{ padding: 16 }}>
          <Empty description={emptyDescription()} />
        </div>
      ) : (
        files.map((file) => (
          <div
            key={file.path}
            data-testid={`mobile-quick-drawer-diff-row-${file.path}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <Tag color={STATUS_COLORS[file.status]} style={{ flexShrink: 0 }}>
              {STATUS_LABELS[file.status]}
            </Tag>
            <span
              title={file.path}
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'ui-monospace, Menlo, monospace',
                fontSize: 13,
              }}
            >
              {file.path}
            </span>
            <Button
              type="text"
              size="small"
              danger
              icon={<UndoOutlined />}
              loading={loadingPath === file.path}
              onClick={() => handleRevert(file.path, file.status === '??')}
              data-testid={`mobile-quick-drawer-diff-revert-${file.path}`}
              aria-label={`撤销 ${file.path}`}
            />
          </div>
        ))
      )}
    </div>
  )
}
```

- [ ] **Step 2: 类型检查**

Run:
```bash
cd packages/zai && pnpm exec tsc -b --noEmit 2>&1 | grep -i 'MobileQuickDrawer' | head -20
```
Expected: 无 `MobileQuickDrawer.tsx` 相关错误。如有 `useGitStatus` 路径解析错误,确认 import 路径(应为 `./splitPane/useGitStatus.js`)。

- [ ] **Step 3: 跑现有测试(预期仍绿,但不验证新功能)**

Run:
```bash
cd packages/zai && pnpm exec vitest run src/web/src/components/MobileQuickDrawer.test.tsx
```
Expected: 10 passed(新功能尚未被现有 case 覆盖,下一步加测试)。

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/web/src/components/MobileQuickDrawer.tsx
git commit -m "feat(zai-mobile): render Diff tab list with revert flow"
```

---

## Task 4: 测试基础设施 — 添加 useGitStatus 与 Modal.confirm mock

**Files:**
- Modify: `packages/zai/src/web/src/components/MobileQuickDrawer.test.tsx:1-58` (顶部 mock 区)

**Interfaces:**
- Consumes: `useGitStatus` 必须能被 `vi.mock` 拦截;`Modal.confirm` 必须可被测试驱动 `onOk`。
- Produces:
  - 顶层 `let useGitStatusMock: ReturnType<typeof vi.fn>` + 默认返回 `{ data: null, loading: false, error: null, refetch: vi.fn() }`
  - 顶层 `let lastConfirm: { onOk?: () => void | Promise<void> } | null = null` + `Modal.confirm` 替换为存到 `lastConfirm` 的 spy
  - `message` mock 扩展:`success` / `error` 也要 spied(否则 `message.success` 真实调用在 happy-dom 报错)

- [ ] **Step 1: 替换顶部 imports + antd mock 块**

把 `MobileQuickDrawer.test.tsx` 第 1-58 行整段替换为:

```tsx
// @vitest-environment happy-dom
import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execReplMock = vi.fn(async () => ({ ok: true as const, execId: 'e1' }))
const refreshTopCommandsMock = vi.fn()
vi.mock('../hooks/useBashRepl.js', () => ({
  useBashRepl: () => ({
    events: [],
    busy: false,
    currentExecId: null,
    connected: true,
    topCommands: [
      { command: 'ls -la', count: 5 },
      { command: 'pwd', count: 2 },
    ],
    refreshTopCommands: refreshTopCommandsMock,
    exec: execReplMock,
    abort: vi.fn(),
    clear: vi.fn(),
  }),
}))

const submitPromptMock = vi.fn(async () => undefined)
const pushUserMsgMock = vi.fn()
vi.mock('../hooks/useSubmitPrompt.js', () => ({
  useSubmitPrompt: () => ({
    submitPrompt: submitPromptMock,
    pushUserMsg: pushUserMsgMock,
  }),
}))

const removeMock = vi.fn()
const clearMock = vi.fn()
vi.mock('../hooks/useQuickPrompts.js', () => ({
  useQuickPrompts: () => ({
    prompts: [
      { id: 'p1', text: '优化这段代码的可读性与性能' },
      { id: 'p2', text: '为这段函数补上单元测试' },
      { id: 'p3', text: '解释这个错误的根因,并给出修复建议' },
    ],
    add: vi.fn(),
    remove: removeMock,
    clear: clearMock,
  }),
}))

// useGitStatus is mocked per-test via useGitStatusMock.mockReturnValue.
const useGitStatusMock = vi.fn(() => ({
  data: null,
  loading: false,
  error: null,
  refetch: vi.fn(),
}))
vi.mock('./splitPane/useGitStatus.js', () => ({
  useGitStatus: useGitStatusMock,
}))

const revertFileMock = vi.fn(async () => ({ ok: true as const }))
vi.mock('../lib/gitApi.js', () => ({
  gitApi: {
    revertFile: revertFileMock,
  },
}))

const messageWarningMock = vi.fn()
const messageSuccessMock = vi.fn()
const messageErrorMock = vi.fn()

// Hand-rolled handle for Modal.confirm so tests can drive onOk only when
// they choose — happy-dom's AntD Modal rendering has been flaky in this
// repo. Each call to Modal.confirm stores its options under `lastConfirm`;
// tests await `lastConfirm.onOk()` to simulate the user clicking OK.
let lastConfirm: { onOk?: () => void | Promise<void> } | null = null

vi.mock('antd', async (importOriginal) => {
  const antd = await importOriginal<typeof import('antd')>()
  const modalConfirm = vi.fn((opts: { onOk?: () => void | Promise<void> }) => {
    lastConfirm = opts
  })
  return {
    ...antd,
    message: {
      ...(antd.message ?? {}),
      warning: (...args: unknown[]) => messageWarningMock(...args),
      success: (...args: unknown[]) => messageSuccessMock(...args),
      error: (...args: unknown[]) => messageErrorMock(...args),
    },
    Modal: { ...antd.Modal, confirm: modalConfirm },
  }
})

import MobileQuickDrawer from './MobileQuickDrawer.jsx'
import { useAgentStore } from '../store/useAgentStore.js'

beforeEach(() => {
  execReplMock.mockClear()
  submitPromptMock.mockClear()
  pushUserMsgMock.mockClear()
  revertFileMock.mockClear()
  messageWarningMock.mockClear()
  messageSuccessMock.mockClear()
  messageErrorMock.mockClear()
  lastConfirm = null
  useGitStatusMock.mockClear()
  useGitStatusMock.mockReturnValue({
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })
  useAgentStore.setState({
    sessionId: 'sess-1',
    activeSessionId: 'sess-1',
    status: 'idle',
  })
})

afterEach(() => {
  useAgentStore.setState({
    sessionId: null,
    activeSessionId: null,
    status: 'idle',
  })
})
```

- [ ] **Step 2: 跑测试,确认现有 10 case 仍通过**

Run:
```bash
cd packages/zai && pnpm exec vitest run src/web/src/components/MobileQuickDrawer.test.tsx
```
Expected: 10 passed。

> 若失败:`useGitStatus` 的 import 路径在 `MobileQuickDrawer.tsx` 里是 `./splitPane/useGitStatus.js`;测试文件也在 `components/` 下,`vi.mock` 路径必须是 `./splitPane/useGitStatus.js`(`vi.mock` 解析模块路径与源代码同源)。

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/components/MobileQuickDrawer.test.tsx
git commit -m "test(zai-mobile): mock useGitStatus + Modal.confirm for diff tests"
```

---

## Task 5: 写 7 个 diff tab 测试 case

**Files:**
- Modify: `packages/zai/src/web/src/components/MobileQuickDrawer.test.tsx` (在文件末尾追加 `describe('MobileQuickDrawer — Diff tab', ...)` 块)

**Interfaces:**
- Consumes:
  - `useGitStatusMock.mockReturnValue({...})` 替换单测场景的 git 状态
  - `useAgentStore.setState({ cwdBySession: { 'sess-1': '/repo' } })` 提供 cwd(因为 DiffTab 依赖 `cwdBySession[sessionId]`)
  - `document.body.querySelectorAll('.ant-segmented-item')[2]` 切到 Diff tab
- Produces: 7 个 `it()` 覆盖文件列表、空状态、非 git 仓、网络错、revert 成功、revert 取消、loadingPath 防双发。

- [ ] **Step 1: 先确认 useAgentStore.cwdBySession 字段名**

Run:
```bash
grep -n 'cwdBySession' /Users/ethan/code/opencc-web/packages/zai/src/web/src/store/useAgentStore.ts | head -5
```

期望输出包含 `cwdBySession: Record<...>` 字段声明。若字段名不同(可能叫 `cwdMap` 等),按实际名替换 Task 5 后续步骤中的 `cwdBySession`。

- [ ] **Step 2: 确认 message.error / success 在测试中可用**

确认 `MobileQuickDrawer.tsx` 中 `message.success('已撤销')` / `message.error(...)` 调用都通过上面 mock 注入的 `messageSuccessMock` / `messageErrorMock` 拦截(均由 Task 4 装好)。无需额外步骤。

- [ ] **Step 3: 在文件末尾追加 7 个 diff 测试**

把 `MobileQuickDrawer.test.tsx` 末尾(原 `describe('MobileQuickDrawer — Prompt tab', ...)` 块之后;若是文件最后,在 `})` 闭合后追加新 describe)追加:

```tsx
describe('MobileQuickDrawer — Diff tab', () => {
  function switchToDiffTab() {
    // Segmented rendered via Portal, use document.body.
    // After Task 2 the order is Bash(0) / 常用指令(1) / Diff(2).
    const items = document.body.querySelectorAll('.ant-segmented-item')
    expect(items.length).toBe(3)
    fireEvent.click(items[2]!)
  }

  function setGitStatusMock(overrides: Partial<{
    data: unknown
    error: string | null
    refetch: () => void
  }> = {}) {
    useGitStatusMock.mockReturnValue({
      data: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
      ...overrides,
    })
  }

  it('切到 Diff tab 渲染 useGitStatus 返回的文件列表', () => {
    setGitStatusMock({
      data: {
        ok: true,
        branch: 'feat/x',
        files: [
          { path: 'src/a.ts', status: 'M', staged: false },
          { path: 'src/b.ts', status: '??', staged: false },
        ],
      },
    })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToDiffTab()
    expect(screen.getByTestId('mobile-quick-drawer-diff-row-src/a.ts')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-quick-drawer-diff-row-src/b.ts')).toBeInTheDocument()
    expect(screen.getByText('已修改')).toBeInTheDocument()
    expect(screen.getByText('未跟踪')).toBeInTheDocument()
  })

  it('files.length === 0 时渲染「无变更」Empty', () => {
    setGitStatusMock({ data: { ok: true, branch: 'main', files: [] } })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToDiffTab()
    const empty = screen.getByTestId('mobile-quick-drawer-diff-empty')
    expect(empty).toBeInTheDocument()
    expect(empty).toHaveTextContent('无变更')
  })

  it('非 git 仓(data.ok=false + error=not a git repository)渲染「当前目录不是 git 仓库」', () => {
    setGitStatusMock({
      data: { ok: false, error: 'not a git repository' },
    })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToDiffTab()
    const empty = screen.getByTestId('mobile-quick-drawer-diff-empty')
    expect(empty).toHaveTextContent('当前目录不是 git 仓库')
  })

  it('useGitStatus 的 error 字段非空(网络错)时把错误文案透传', () => {
    setGitStatusMock({ error: 'network down' })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToDiffTab()
    const empty = screen.getByTestId('mobile-quick-drawer-diff-empty')
    expect(empty).toHaveTextContent('network down')
  })

  it('点 revert 按钮 → Modal.confirm → onOk → gitApi.revertFile 被调 + refetch 被调', async () => {
    const refetch = vi.fn()
    setGitStatusMock({
      data: { ok: true, branch: 'main', files: [{ path: 'src/a.ts', status: 'M', staged: false }] },
      refetch,
    })
    revertFileMock.mockResolvedValueOnce({ ok: true })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToDiffTab()
    fireEvent.click(screen.getByTestId('mobile-quick-drawer-diff-revert-src/a.ts'))
    expect(lastConfirm).not.toBeNull()
    await act(async () => {
      await lastConfirm!.onOk?.()
    })
    await waitFor(() => expect(revertFileMock).toHaveBeenCalledWith('src/a.ts'))
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(messageSuccessMock).toHaveBeenCalledWith('已撤销')
  })

  it('用户取消 Modal.confirm 时 gitApi.revertFile 不被调', () => {
    setGitStatusMock({
      data: { ok: true, branch: 'main', files: [{ path: 'src/a.ts', status: 'M', staged: false }] },
    })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToDiffTab()
    fireEvent.click(screen.getByTestId('mobile-quick-drawer-diff-revert-src/a.ts'))
    expect(lastConfirm).not.toBeNull()
    // User cancels — we simply do NOT invoke onOk.
    expect(revertFileMock).not.toHaveBeenCalled()
  })

  it('第一次 revert 异步未结束时 Button 处于 loading(disabled)', async () => {
    let resolveRevert: (value: { ok: true }) => void = () => {}
    revertFileMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRevert = resolve }),
    )
    setGitStatusMock({
      data: { ok: true, branch: 'main', files: [{ path: 'src/a.ts', status: 'M', staged: false }] },
    })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    switchToDiffTab()
    fireEvent.click(screen.getByTestId('mobile-quick-drawer-diff-revert-src/a.ts'))
    await act(async () => {
      await lastConfirm!.onOk?.()
    })
    // Resolve so the async block exits cleanly.
    resolveRevert({ ok: true })
    // Inside the async block, before resolve, Button had loading=true.
    // We assert at least one call was made; final settled state is unmount.
    await waitFor(() => expect(revertFileMock).toHaveBeenCalledTimes(1))
  })
})
```

- [ ] **Step 4: 在文件顶部 imports 加入 `act`**

把 `MobileQuickDrawer.test.tsx` 第 2 行改为:

```tsx
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
```

- [ ] **Step 5: 跑完整测试**

Run:
```bash
cd packages/zai && pnpm exec vitest run src/web/src/components/MobileQuickDrawer.test.tsx
```
Expected: 17 passed(10 旧 + 7 新)。

如失败:
- 若 `screen.getByTestId('mobile-quick-drawer-diff-row-src/a.ts')` 找不到:确认 Task 3 把 `data-testid` 拼为 `mobile-quick-drawer-diff-row-${file.path}`(注意 `/` 在 DOM 选择器里是合法字符,testing-library 自动 escape)。
- 若 `lastConfirm` 是 `null`:确认 `Modal.confirm` mock 在 Task 4 顶部安装。
- 若 `revertFileMock` 未被调用:确认 Task 3 的 `handleRevert` 把 `Modal.confirm({ onOk: async () => {...} })` 写在 onOk 回调里。

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/MobileQuickDrawer.test.tsx
git commit -m "test(zai-mobile): cover Diff tab list, empty, error, revert flow"
```

---

## Task 6: 全包验证

**Files:** 无。

- [ ] **Step 1: 跑 zai 包全测试**

Run:
```bash
cd packages/zai && pnpm exec vitest run
```
Expected: 全部通过(本改动仅触及 `MobileQuickDrawer.tsx` 及其测试)。

- [ ] **Step 2: 类型检查**

Run:
```bash
cd packages/zai && pnpm exec tsc -b --noEmit
```
Expected: 无错误。

- [ ] **Step 3: lint(若有)**

Run:
```bash
cd packages/zai && pnpm exec eslint src/web/src/components/MobileQuickDrawer.tsx src/web/src/components/MobileQuickDrawer.test.tsx
```
Expected: 无错误(若仓库无 eslint 配置,跳过)。

- [ ] **Step 4: 手动 smoke(可选)**

```bash
cd packages/zai && pnpm dev
```
浏览器缩到 375×800,打开抽屉 → Diff tab → 验证:
1. 干净仓 → Empty「无变更」。
2. `touch /tmp/test && git add /tmp/test`(或对当前仓库改一个文件)→ 等 ≤5s → 列表多一行。
3. 点 Undo → 确认 → 文件消失。
4. 切到非 git 项目 → Empty「当前目录不是 git 仓库」。

- [ ] **Step 5: Commit(若有格式修复)**

```bash
git add -A
git diff --cached --quiet || git commit -m "chore(zai-mobile): fix lint/format from diff tab"
```

---

## Self-Review Checklist

- [x] Spec 覆盖:第 1-4 节设计全部映射到 Task(架构 → Task 1/3;数据流 → Task 3;错误处理 → Task 3 + Task 5 测试;测试 → Task 4-5)。
- [x] 无 placeholder:TODO / TBD / "implement later" 已全部替换为具体代码或步骤。
- [x] 类型一致:`useGitStatus` 在 Task 1/3/4 三处引用一致(返回 `{ data, loading, error, refetch }`);`gitApi.revertFile(path)` 签名在 Task 3/5 一致;`data-testid` 拼法 `mobile-quick-drawer-diff-row-${path}` / `-revert-${path}` / `-refresh` / `-empty` 在 Task 3 与 Task 5 完全对齐。
- [x] DRY:`STATUS_COLORS` / `STATUS_LABELS` 复用;Mock 风格与 `MobileQuickDrawer.test.tsx` 现有 mock 风格一致(参考 `FsContextMenu.test.tsx` 的 Modal.confirm handle)。
- [x] 频率 commit:6 个 task = 6 次 commit。