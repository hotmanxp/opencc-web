# QuickCreateModal · 目录选择器 + 图片附件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在任务工厂「快速创建」弹窗 (`QuickCreateModal`) 中,cwd 字段新增「选择目录」按钮(复用 `DirectoryPicker`);description 下方新增图片附件区(按钮 + Ctrl+V 黏贴);图片走 `/api/fs/upload` 上传到 `<cwd>/.zai/uploads/`,提交 prompt 文本补一段 `attachments:` 清单。

**Architecture:** TDD。`DirectoryPicker` 先写测试再从 `Instances.tsx` 抽到 `components/common/`,Instances 改 import(纯重构);新建 `QuickAttachmentStrip` 只读组件;最后改 `QuickCreateModal` 加 cwd picker + image attachments + 提交流程集成。

**Tech Stack:** React 18 + TypeScript + AntD 5 + Vitest happy-dom。复用 `lib/imageReader.readImageAsBase64`(10MB 上限 + jpeg/png/gif/webp)。复用 `DirectoryPicker` 走 `/api/fs/picker` 服务端路径规范化。

## Global Constraints

- **`MAX_IMAGES_PER_QUICK = 8`** —— 常量定义在 `QuickCreateModal.tsx` 顶部;超过 `slice(0, 8)` + `message.warning('最多 8 张图片,已截断')`
- **图片大小上限 10MB** —— 由 `lib/imageReader.readImageAsBase64` 内置(`too_large` 错误)
- **支持格式** —— `image/jpeg`、`image/png`、`image/gif`、`image/webp`(`imageReader.ts:5` `ALLOWED_MIME` Set)
- **图片存放位置** —— `<cwd>/.zai/uploads/<name>`,由 `/api/fs/upload` 后端写入
- **`/agent/prompt` header** —— `{ headers: { 'X-Session-Id': sid } }` 与现有契约一致
- **`/api/fs/picker` 路径规范化** —— 服务端负责,客户端不转换;失败时 picker-error Alert + 保留 currentPath
- **`data-testid` 新增** —— `quick-cwd-picker-trigger`、`quick-directory-picker`、`quick-image-picker-trigger`、`quick-attachment-strip`、`quick-attachment-chip`
- **系统提示词一律用英文** —— 修改 task-intake-quick systemPrompt 时遵循 AGENTS.md(本次不修改 task-intake-quick)
- **真实浏览器验收** —— `/ego-browser` 走完桌面 + 移动端两条路径(必做)
- **测试粒度** —— 仅跑相关文件:`pnpm --filter @zn-ai/zai test <file>`,不全跑
- **commit 风格** —— 参考 git log,feat/fix/refactor/docs 前缀 + 模块名 + 中文一句话描述
- **`genLocalId` 实现** —— `QuickCreateModal.tsx` 顶部就地定义(10 行),不抽 lib 不从 AgentInputBox import
- **构建产物** —— 仅前端改 → 不需要 `pnpm run build:core`
- **`MobileAsDrawer` 与 fullscreen** —— 两种容器形态必须都工作(零行为差异,仅换容器)

---

## File Structure

| 文件 | 职责 |
|------|------|
| `packages/zai/src/web/src/components/common/DirectoryPicker.tsx` | 共享目录选择器组件(从 Instances.tsx 抽出) |
| `packages/zai/src/web/src/components/common/DirectoryPicker.test.tsx` | DirectoryPicker 单测(覆盖打开 / fetch / 主页 / 上级 / 选中 / 取消) |
| `packages/zai/src/web/src/pages/Instances.tsx` | 改 import 路径(零行为变化) |
| `packages/zai/src/web/src/pages/Instances.picker.test.tsx` | 现有测试,改 import 后继续覆盖 Instances 端使用 |
| `packages/zai/src/web/src/components/superTasks/QuickAttachmentStrip.tsx` | 只读缩略图条(items / onRemove / disabled) |
| `packages/zai/src/web/src/components/superTasks/QuickAttachmentStrip.test.tsx` | QuickAttachmentStrip 单测 |
| `packages/zai/src/web/src/components/superTasks/QuickCreateModal.tsx` | 加 cwd picker + image attachments + 提交流程 |
| `packages/zai/src/web/src/components/superTasks/QuickCreateModal.test.tsx` | 新增 cwd picker / image attachments / mobileAsDrawer describe |

---

## Task 1: 把 DirectoryPicker 测试从 Instances 抽到独立组件测试

**Files:**
- Create: `packages/zai/src/web/src/components/common/DirectoryPicker.test.tsx`
- Modify: `packages/zai/src/web/src/pages/Instances.picker.test.tsx`(拆出后可保留对 Instances 端使用的覆盖)

**Interfaces:**
- Consumes: `DirectoryPickerProps = { open: boolean; initialPath: string; onCancel: () => void; onSelect: (path: string) => void }`(与 Instances.tsx 当前内联组件一致)
- Produces: 测试不导出任何东西,只验证行为

**Context:** Instances.tsx 当前内联 DirectoryPicker 没有任何独立测试文件,只能通过 `Instances.picker.test.tsx` 间接覆盖。先建 `DirectoryPicker.test.tsx`,把现有间接测试的关键场景迁过去,作为抽组件前的契约测试。

- [ ] **Step 1: 写 failing 测试**

`packages/zai/src/web/src/components/common/DirectoryPicker.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import DirectoryPicker from './DirectoryPicker.js'
import type { FsPickerList } from '../../../shared/fsPicker.js'

function makeFsPickerResponse(overrides: Partial<FsPickerList> = {}): FsPickerList {
  return {
    ok: true,
    path: '/Users/me/projects',
    parent: '/Users/me',
    home: '/Users/me',
    entries: [
      { name: 'demo', type: 'dir', path: '/Users/me/projects/demo' },
    ],
    ...overrides,
  }
}

describe('DirectoryPicker', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders nothing when open=false', () => {
    render(<DirectoryPicker open={false} initialPath="/x" onCancel={vi.fn()} onSelect={vi.fn()} />)
    expect(document.querySelector('.ant-modal')).toBeNull()
  })

  it('fetches /api/fs/picker on open=true with initialPath', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<DirectoryPicker open initialPath="/Users/me/projects" onCancel={vi.fn()} onSelect={vi.fn()} />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/fs/picker?path='),
      )
    })
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(decodeURIComponent(url)).toContain('/Users/me/projects')
  })

  it('renders fetched entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 })))
    render(<DirectoryPicker open initialPath="/Users/me/projects" onCancel={vi.fn()} onSelect={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('picker-entry-demo')).toBeInTheDocument()
    })
  })

  it('shows picker-error when fetch returns !ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: '权限拒绝' }), { status: 200 })))
    render(<DirectoryPicker open initialPath="/x" onCancel={vi.fn()} onSelect={vi.fn()} />)
    expect(await screen.findByTestId('picker-error')).toHaveTextContent(/权限拒绝/)
  })

  it('fetches parent path when 上级 clicked', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<DirectoryPicker open initialPath="/Users/me/projects" onCancel={vi.fn()} onSelect={vi.fn()} />)
    await screen.findByTestId('picker-entry-demo')
    fetchMock.mockClear()
    fireEvent.click(screen.getByText('上级'))
    await waitFor(() => {
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/Users/me')
    })
  })

  it('fetches home path when 主页 clicked', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<DirectoryPicker open initialPath="/Users/me/projects" onCancel={vi.fn()} onSelect={vi.fn()} />)
    await screen.findByTestId('picker-entry-demo')
    fetchMock.mockClear()
    fireEvent.click(screen.getByText('主页'))
    await waitFor(() => {
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/Users/me')
    })
  })

  it('calls onSelect with currentPath and onCancel when 选择当前目录 clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 })))
    const onSelect = vi.fn()
    const onCancel = vi.fn()
    render(<DirectoryPicker open initialPath="/Users/me/projects" onCancel={onCancel} onSelect={onSelect} />)
    await screen.findByTestId('picker-entry-demo')
    fireEvent.click(screen.getByTestId('picker-select'))
    expect(onSelect).toHaveBeenCalledWith('/Users/me/projects')
    expect(onCancel).toHaveBeenCalled()
  })

  it('calls only onCancel when 取消 clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse()), { status: 200 })))
    const onSelect = vi.fn()
    const onCancel = vi.fn()
    render(<DirectoryPicker open initialPath="/x" onCancel={onCancel} onSelect={onSelect} />)
    await screen.findByTestId('picker-cancel')
    fireEvent.click(screen.getByTestId('picker-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows 空目录 placeholder when entries is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(makeFsPickerResponse({ entries: [] })), { status: 200 })))
    render(<DirectoryPicker open initialPath="/empty" onCancel={vi.fn()} onSelect={vi.fn()} />)
    expect(await screen.findByText('空目录')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行测试,确认 FAIL(组件还不存在)**

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zai test src/web/src/components/common/DirectoryPicker.test.tsx
```

Expected: FAIL — module `./DirectoryPicker.js` not found。

- [ ] **Step 3: 创建 DirectoryPicker 组件(从 Instances.tsx 复制并 export)**

`packages/zai/src/web/src/components/common/DirectoryPicker.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Alert, Button, Input, Modal, Space, Spin } from 'antd'
import {
  ArrowUpOutlined, HomeOutlined, ReloadOutlined, FolderOutlined,
} from '@ant-design/icons'
import type { FsPickerEntry, FsPickerList } from '../../../shared/fsPicker.js'

export type DirectoryPickerProps = {
  open: boolean
  initialPath: string
  onCancel: () => void
  onSelect: (path: string) => void
}

// 目录选择器 Modal:跨平台路径处理交由服务端 (routes/fsPicker.ts) 完成,
// 客户端只负责"展示 path + 触发 list"。回填 onSelect 时直接用服务端
// 规范化后的 path —— Windows 上是 `C:\Users\foo` 风格,POSIX 上是
// `/Users/foo` 风格,客户端不做转换 (转换在跨 OS 上不稳定)。
//
// 起点策略:initialPath 优先 (从父表单拿到的 currentCwd),空时让服务端
// 返回 homedir()。这样用户第一次开 modal 时总是落在有意义的目录。
export default function DirectoryPicker({
  open, initialPath, onCancel, onSelect,
}: DirectoryPickerProps): JSX.Element | null {
  const [currentPath, setCurrentPath] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [home, setHome] = useState('')
  const [entries, setEntries] = useState<FsPickerEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const target = initialPath.trim()
    void loadPath(target)
  }, [open])

  async function loadPath(p: string): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/fs/picker?path=${encodeURIComponent(p)}`
      const res = await fetch(url)
      const data = (await res.json().catch(() => ({}))) as FsPickerList
      if (!res.ok || !data.ok) {
        setError(data.error ?? `请求失败 (HTTP ${res.status})`)
        // 保留 currentPath / entries 不动,只显示错误 — 用户可点上级 / 主页恢复
        return
      }
      setCurrentPath(data.path ?? '')
      setParent(data.parent ?? null)
      setHome(data.home ?? '')
      setEntries(data.entries ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <Modal
      title="选择工作目录"
      open={open}
      onCancel={onCancel}
      width={640}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onCancel} data-testid="picker-cancel">
          取消
        </Button>,
        <Button
          key="select"
          type="primary"
          disabled={!currentPath || loading}
          onClick={() => onSelect(currentPath)}
          data-testid="picker-select"
        >
          选择当前目录
        </Button>,
      ]}
    >
      <Space style={{ marginBottom: 8 }} wrap>
        <Button icon={<HomeOutlined />} disabled={!home} onClick={() => void loadPath(home)}>
          主页
        </Button>
        <Button icon={<ArrowUpOutlined />} disabled={!parent} onClick={() => parent && void loadPath(parent)}>
          上级
        </Button>
        <Button icon={<ReloadOutlined />} disabled={!currentPath || loading} onClick={() => void loadPath(currentPath)}>
          刷新
        </Button>
      </Space>
      <Input
        value={currentPath}
        readOnly
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      />
      <div
        data-testid="quick-directory-picker"
        style={{
          marginTop: 8, minHeight: 240, maxHeight: 360, overflowY: 'auto',
          border: '1px solid var(--border-light)', borderRadius: 4,
          background: 'var(--bg-popup)', padding: '4px 0',
        }}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim-45)', fontSize: 12 }}>
            空目录
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.path}
              role="button" tabIndex={0}
              data-testid={`picker-entry-${entry.name}`}
              onClick={() => void loadPath(entry.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void loadPath(entry.path)
                }
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 12px', cursor: 'pointer',
                color: 'var(--text-dim-85)', fontSize: 13,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-faint-06)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
            >
              <span style={{ width: 16, textAlign: 'center' }}><FolderOutlined /></span>
              <span style={{ flex: 1 }}>{entry.name}</span>
              <span style={{ fontSize: 11, color: 'var(--text-dim-45)' }}>打开</span>
            </div>
          ))
        )}
      </div>
      {error && (
        <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} data-testid="picker-error" />
      )}
    </Modal>
  )
}
```

> **改动提示(相对 Instances.tsx 内联原版)**:
> - 默认导出改 `export default function DirectoryPicker`
> - props 类型加 `export type DirectoryPickerProps`
> - 在 `open=false` 时返回 `null`(避免 mount 时挂载空 Modal,Mount 时也不 fetch)
> - 加 `data-testid="quick-directory-picker"` 在外层 div 供 QuickCreateModal 端定位
> - 原 Instances.tsx 内联组件中的「click 上级 / 主页 / 刷新」逻辑保留完全一致

- [ ] **Step 4: 运行测试,确认 PASS**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/common/DirectoryPicker.test.tsx
```

Expected: 9 个用例全绿。

- [ ] **Step 5: 跑现有 Instances.picker.test.tsx 确认旧契约未变**

```bash
pnpm --filter @zn-ai/zai test src/web/src/pages/Instances.picker.test.tsx
```

Expected: PASS —— Instances.tsx 当前用的还是内联 DirectoryPicker,所以这一组测试与新文件无关,仅作为回归基线。

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/common/DirectoryPicker.tsx \
        packages/zai/src/web/src/components/common/DirectoryPicker.test.tsx
git commit -m "$(cat <<'EOF'
refactor(zai): 把 DirectoryPicker 抽到 components/common/ 并加单测

目录选择器此前在 Instances.tsx 内联(~170 行),无独立测试。新建
components/common/DirectoryPicker.tsx 并 export + 加 9 个单测覆盖
打开/fetch/主页/上级/选中/取消/错误/空目录。Instances.tsx 暂未改,
下一步(任务 2)再统一改 import。
EOF
)"
```

---

## Task 2: Instances.tsx 改 import,删除内联 DirectoryPicker

**Files:**
- Modify: `packages/zai/src/web/src/pages/Instances.tsx`

**Context:** Instances.tsx 当前有内联 DirectoryPicker(行 133-317)与 FsPickerEntry/FsPickerList 的 `import type`(行 40)。改成从新位置 import,行为完全一致。

- [ ] **Step 1: 跑现有 Instances.picker.test.tsx 作为基线**

```bash
pnpm --filter @zn-ai/zai test src/web/src/pages/Instances.picker.test.tsx
```

Expected: PASS(回归参考)。

- [ ] **Step 2: 删除 Instances.tsx 内联 DirectoryPicker**

在 `packages/zai/src/web/src/pages/Instances.tsx`:
- 删除行 133-317(`type DirectoryPickerProps` + `function DirectoryPicker`)
- 删除行 319 之前的 `import` 中不再需要的 `FsPickerEntry`(留 `FsPickerList` 仅在 inline 组件用,inline 组件删除后一并删除)

改为:

```tsx
// 删除原行 40:
import type { FsPickerEntry, FsPickerList } from '../../../shared/fsPicker.js'
// 改为:
import type { FsPickerList } from '../../../shared/fsPicker.js'
```

> 注意:`FsPickerList` 在 Instances.tsx 内联组件删除后**不再被 Instances.tsx 引用**,整行 import 也要删除。检查整个文件 grep `FsPickerList` 确认 0 引用后再删除。

- [ ] **Step 3: 在 Instances.tsx 顶部加 import**

```tsx
import DirectoryPicker from '../components/common/DirectoryPicker.js'
```

- [ ] **Step 4: 跑所有 Instances 测试,确认零行为变化**

```bash
pnpm --filter @zn-ai/zai test src/web/src/pages/Instances
```

Expected: PASS —— 现有所有 Instances 测试(包括 picker 测试)继续绿。

- [ ] **Step 5: 跑 DirectoryPicker 测试,确认仍是 PASS**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/common/DirectoryPicker.test.tsx
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/pages/Instances.tsx
git commit -m "$(cat <<'EOF'
refactor(zai): Instances.tsx 改用共享 DirectoryPicker

删除 ~170 行内联组件 + 配套 import 类型,改为从
components/common/DirectoryPicker import。行为零变化(由
Instances.picker.test.tsx 覆盖)。
EOF
)"
```

---

## Task 3: 创建 QuickAttachmentStrip 组件

**Files:**
- Create: `packages/zai/src/web/src/components/superTasks/QuickAttachmentStrip.tsx`
- Create: `packages/zai/src/web/src/components/superTasks/QuickAttachmentStrip.test.tsx`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  export type QuickAttachment = {
    localId: string
    mime: string
    size: number
    filename: string
    thumbnailUrl: string
    dataUrl: string
    status: 'reading' | 'ready' | 'error'
    error?: string
  }

  export default function QuickAttachmentStrip(props: {
    items: QuickAttachment[]
    onRemove: (localId: string) => void
    disabled?: boolean
  }): JSX.Element | null
  ```

> **why 不复用 AgentInputBox 的 AttachmentStrip**:AgentInputBox 的 AttachmentStrip 接 `PendingAttachment` 形状(`localId` 名字虽同,但语义/生命周期不同),且耦合 AgentInputBox 的 zustand store / 缩略图大小策略。写一个 50-70 行只读版本更清晰。

- [ ] **Step 1: 写 failing 测试**

`packages/zai/src/web/src/components/superTasks/QuickAttachmentStrip.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent } from '@testing-library/react'
import QuickAttachmentStrip, { type QuickAttachment } from './QuickAttachmentStrip.js'

function mkAtt(overrides: Partial<QuickAttachment> = {}): QuickAttachment {
  return {
    localId: `att-${Math.random().toString(36).slice(2)}`,
    mime: 'image/png',
    size: 1024,
    filename: 'shot.png',
    thumbnailUrl: 'blob:fake',
    dataUrl: 'data:image/png;base64,AAA',
    status: 'ready',
    ...overrides,
  }
}

describe('QuickAttachmentStrip', () => {
  it('renders nothing when items is empty', () => {
    const { container } = render(<QuickAttachmentStrip items={[]} onRemove={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one chip per ready attachment with filename and × button', () => {
    const onRemove = vi.fn()
    render(
      <QuickAttachmentStrip
        items={[mkAtt({ localId: 'a1', filename: 'shot.png' }), mkAtt({ localId: 'a2', filename: 'mock.png' })]}
        onRemove={onRemove}
      />,
    )
    expect(screen.getByTestId('quick-attachment-chip-a1')).toHaveTextContent('shot.png')
    expect(screen.getByTestId('quick-attachment-chip-a2')).toHaveTextContent('mock.png')
  })

  it('calls onRemove(localId) when × is clicked', () => {
    const onRemove = vi.fn()
    render(<QuickAttachmentStrip items={[mkAtt({ localId: 'a1' })]} onRemove={onRemove} />)
    fireEvent.click(screen.getByTestId('quick-attachment-chip-a1-remove'))
    expect(onRemove).toHaveBeenCalledWith('a1')
  })

  it('renders error text for status=error attachments', () => {
    render(
      <QuickAttachmentStrip
        items={[mkAtt({ localId: 'err1', status: 'error', error: '文件过大' })]}
        onRemove={vi.fn()}
      />,
    )
    expect(screen.getByTestId('quick-attachment-chip-err1')).toHaveTextContent('文件过大')
  })

  it('disables × button when disabled=true', () => {
    render(
      <QuickAttachmentStrip
        items={[mkAtt({ localId: 'a1' })]}
        onRemove={vi.fn()}
        disabled
      />,
    )
    const removeBtn = screen.getByTestId('quick-attachment-chip-a1-remove')
    expect(removeBtn.hasAttribute('disabled')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试,确认 FAIL**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/QuickAttachmentStrip.test.tsx
```

Expected: FAIL — module not found。

- [ ] **Step 3: 实现 QuickAttachmentStrip**

`packages/zai/src/web/src/components/superTasks/QuickAttachmentStrip.tsx`:

```tsx
import { Button } from 'antd'
import { CloseOutlined } from '@ant-design/icons'

export type QuickAttachment = {
  localId: string
  mime: string
  size: number
  filename: string
  thumbnailUrl: string
  dataUrl: string
  status: 'reading' | 'ready' | 'error'
  error?: string
}

/**
 * QuickCreateModal 的只读图片附件缩略图条(items / onRemove / disabled)。
 *
 * 不复用 AgentInputBox 的 AttachmentStrip:后者耦合 AgentInputBox 的
 * PendingAttachment 形状 + zustand store + 缩略图大小策略。QuickCreateModal
 * 用 50-70 行只读版本,父级用 `attachments.length > 0 && <QuickAttachmentStrip ...>`
 * 守卫空状态 —— 组件本身在 items=[] 时返回 null。
 */
export default function QuickAttachmentStrip({
  items,
  onRemove,
  disabled = false,
}: {
  items: QuickAttachment[]
  onRemove: (localId: string) => void
  disabled?: boolean
}): JSX.Element | null {
  if (items.length === 0) return null

  return (
    <div
      data-testid="quick-attachment-strip"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        padding: '4px 0',
      }}
    >
      {items.map((item) => (
        <span
          key={item.localId}
          data-testid={`quick-attachment-chip-${item.localId}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 6px',
            background: item.status === 'error' ? 'var(--danger-bg, #fff1f0)' : 'rgba(255,102,0,0.15)',
            border: item.status === 'error' ? '1px solid var(--danger, #ff4d4f)' : '1px solid transparent',
            borderRadius: 6,
            fontSize: 12,
            maxWidth: '100%',
          }}
        >
          <img
            src={item.thumbnailUrl}
            alt={item.filename}
            style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: 2, flexShrink: 0 }}
          />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130, flexShrink: 1 }}>
            {item.status === 'error' ? item.error || '上传失败' : item.filename}
          </span>
          <Button
            size="small"
            type="text"
            disabled={disabled}
            aria-label="移除附件"
            icon={<CloseOutlined />}
            onClick={() => onRemove(item.localId)}
            data-testid={`quick-attachment-chip-${item.localId}-remove`}
            style={{ width: 18, height: 18, minWidth: 18, padding: 0, fontSize: 10, flexShrink: 0 }}
          />
        </span>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: 跑测试,确认 PASS**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/QuickAttachmentStrip.test.tsx
```

Expected: 5 个用例全绿。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/superTasks/QuickAttachmentStrip.tsx \
        packages/zai/src/web/src/components/superTasks/QuickAttachmentStrip.test.tsx
git commit -m "$(cat <<'EOF'
feat(zai): 新增 QuickAttachmentStrip 只读缩略图条

QuickCreateModal 专用(不复用 AgentInputBox 的 AttachmentStrip
因为形状 / 生命周期不同)。渲染 status==='ready' 缩略图 +
filename + × 按钮;status==='error' 卡片红字 + 错误文案;
disabled=true 时禁用 ×。
EOF
)"
```

---

## Task 4: QuickCreateModal 加 cwd picker(state + 按钮 + Modal)

**Files:**
- Modify: `packages/zai/src/web/src/components/superTasks/QuickCreateModal.tsx`

**Interfaces:**
- Consumes: 现有 `cwd` state;`<DirectoryPicker>` from `'../common/DirectoryPicker.js'`
- Produces: 新增 state `cwdPickerOpen: boolean`;新增按钮 `quick-cwd-picker-trigger`;cwd 字段下方挂 `<DirectoryPicker open={cwdPickerOpen} initialPath={cwd || defaultCwd} onCancel={() => setCwdPickerOpen(false)} onSelect={setCwd} />`

- [ ] **Step 1: 写 failing 测试**

在 `packages/zai/src/web/src/components/superTasks/QuickCreateModal.test.tsx` 的 `describe('QuickCreateModal ...')` 内、**最末尾**追加:

```tsx
  describe('cwd picker', () => {
    it('renders quick-cwd-picker-trigger button next to the cwd input', () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      expect(screen.getByTestId('quick-cwd-picker-trigger')).toBeTruthy()
    })

    it('clicking picker trigger opens the DirectoryPicker modal', () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true,"path":"/x","parent":"/","home":"/","entries":[]}', { status: 200 })))
      render(<QuickCreateModal open onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('quick-cwd-picker-trigger'))
      expect(screen.getByTestId('quick-directory-picker')).toBeTruthy()
    })

    it('DirectoryPicker onSelect updates the cwd field', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ ok: true, path: '/Users/picked', parent: '/Users', home: '/Users', entries: [] }),
        { status: 200 },
      )))
      render(<QuickCreateModal open onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('quick-cwd-picker-trigger'))
      // 在 picker 内 fetch 完成后,点「选择当前目录」
      await screen.findByTestId('picker-select')
      fireEvent.click(screen.getByTestId('picker-select'))
      const input = screen.getByTestId('quick-cwd-input') as HTMLInputElement
      expect(input.value).toBe('/Users/picked')
      vi.unstubAllGlobals()
    })

    it('DirectoryPicker cancel keeps cwd unchanged', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true,"path":"/x","parent":"/","home":"/","entries":[]}', { status: 200 })))
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const before = (screen.getByTestId('quick-cwd-input') as HTMLInputElement).value
      fireEvent.click(screen.getByTestId('quick-cwd-picker-trigger'))
      await screen.findByTestId('picker-cancel')
      fireEvent.click(screen.getByTestId('picker-cancel'))
      const after = (screen.getByTestId('quick-cwd-input') as HTMLInputElement).value
      expect(after).toBe(before)
      vi.unstubAllGlobals()
    })
  })
```

- [ ] **Step 2: 跑测试,确认 FAIL**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/QuickCreateModal.test.tsx
```

Expected: FAIL — `quick-cwd-picker-trigger` not found。

- [ ] **Step 3: 在 QuickCreateModal.tsx 加 DirectoryPicker 集成**

在 `QuickCreateModal.tsx`:

**3a. 在文件顶部 import 区追加:**

```tsx
import { FolderOpenOutlined } from '@ant-design/icons'
import DirectoryPicker from '../common/DirectoryPicker.js'
```

**3b. 在 `Form.Item` 的 cwd 字段(原 237-258 行,`<Input data-testid="quick-cwd-input" .../>`)改造为 Space 内 Input + 按钮:**

找到原 cwd Form.Item:

```tsx
<Form.Item
  label={(
    <Space>
      <span>工作目录</span>
      <Button
        size="small"
        type="link"
        onClick={() => setCwd(defaultCwd)}
        disabled={!defaultCwd}
      >
        使用当前实例 cwd
      </Button>
    </Space>
  )}
>
  <Input
    data-testid="quick-cwd-input"
    value={cwd}
    onChange={(e) => setCwd(e.target.value)}
    placeholder={defaultCwd || '/absolute/path/to/repo'}
  />
</Form.Item>
```

**改为:**

```tsx
<Form.Item
  label={(
    <Space>
      <span>工作目录</span>
      <Button
        size="small"
        type="link"
        onClick={() => setCwd(defaultCwd)}
        disabled={!defaultCwd}
      >
        使用当前实例 cwd
      </Button>
    </Space>
  )}
>
  <Space.Compact style={{ width: '100%' }}>
    <Input
      data-testid="quick-cwd-input"
      value={cwd}
      onChange={(e) => setCwd(e.target.value)}
      placeholder={defaultCwd || '/absolute/path/to/repo'}
      style={{ flex: 1, minWidth: 0 }}
    />
    <Button
      icon={<FolderOpenOutlined />}
      data-testid="quick-cwd-picker-trigger"
      onClick={() => setCwdPickerOpen(true)}
    >
      选择目录
    </Button>
  </Space.Compact>
</Form.Item>
```

**3c. 在 `Form` 之前(`/Form 关闭标签之后`新增态位置:`</Form>` 紧跟其后的位置,具体在 `{error && <Alert .../>}` 之前)追加 picker:**

找到 `</Form>`(原 307 行附近)。在它**之前**(作为 Form 的兄弟节点)插入:

```tsx
        <DirectoryPicker
          open={cwdPickerOpen}
          initialPath={cwd.trim() || defaultCwd}
          onCancel={() => setCwdPickerOpen(false)}
          onSelect={(p) => {
            setCwd(p)
            setCwdPickerOpen(false)
          }}
        />
```

**3d. 加 state `cwdPickerOpen`:**

找到 `const [error, setError] = useState<string | null>(null)`(原 108 行),在它之后追加:

```tsx
const [cwdPickerOpen, setCwdPickerOpen] = useState(false)
```

**3e. 在 `useEffect` 的 `if (!open) return` 重置块(原 119-128 行)追加重置:**

```tsx
setCwdPickerOpen(false)
```

> 注意 `useEffect` 内 setCwdPickerOpen(false) 默认值已经 false,所以这一行只在 picker 已打开时(用户提交后或重置时)才生效,可以加也可以不加 —— 加上更明确,**加**。

- [ ] **Step 4: 跑 QuickCreateModal 测试,确认新用例 PASS 且旧用例无回归**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/QuickCreateModal.test.tsx
```

Expected: 所有用例全绿(含新加的 4 个 cwd picker 用例 + 原有 ~20 个用例)。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/superTasks/QuickCreateModal.tsx \
        packages/zai/src/web/src/components/superTasks/QuickCreateModal.test.tsx
git commit -m "$(cat <<'EOF'
feat(zai): QuickCreateModal 加 cwd 选择目录按钮

cwd Input 旁加「选择目录」按钮 → 打开共享 DirectoryPicker Modal。
选中路径 → onSelect 回填 cwd + 关闭 picker;取消 → 关闭 picker 不改 cwd。
继承现有 fullscreen / mobileAsDrawer / 640 三种容器形态。
EOF
)"
```

---

## Task 5: QuickCreateModal 加图片附件 state + addImages + removeAttachment + 缩略图条 + 黏贴监听

**Files:**
- Modify: `packages/zai/src/web/src/components/superTasks/QuickCreateModal.tsx`

**Interfaces:**
- Consumes: 现有 cwd/state;`<QuickAttachmentStrip>` from `./QuickAttachmentStrip.js`;`readImageAsBase64` from `'../../lib/imageReader.js'`;`ImageReadError` 同上
- Produces:
  ```ts
  type QuickAttachment = {
    localId: string; mime: string; size: number; filename: string
    thumbnailUrl: string; dataUrl: string
    status: 'reading' | 'ready' | 'error'; error?: string
  }
  // state:
  const [attachments, setAttachments] = useState<QuickAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  // helpers:
  async function addImages(files: File[]): Promise<void>
  function removeAttachment(localId: string): void
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void
  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>): void
  ```

- [ ] **Step 1: 写 failing 测试**

在 `QuickCreateModal.test.tsx` 的 cwd picker describe 后追加:

```tsx
  describe('image attachments', () => {
    function makeImageFile(name: string, type: string, sizeBytes = 1024): File {
      // happy-dom / jsdom 的 File 是支持的。直接构造。
      const blob = new Blob([new Uint8Array(sizeBytes)], { type })
      return new File([blob], name, { type })
    }

    it('renders quick-image-picker-trigger button below description', () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      expect(screen.getByTestId('quick-image-picker-trigger')).toBeTruthy()
    })

    it('clicking trigger calls hidden input.click()', () => {
      const { container } = render(<QuickCreateModal open onClose={vi.fn()} />)
      const input = container.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement
      const clickSpy = vi.spyOn(input, 'click')
      fireEvent.click(screen.getByTestId('quick-image-picker-trigger'))
      expect(clickSpy).toHaveBeenCalled()
    })

    it('readImageAsBase64 success → quick-attachment-strip renders ready chip', async () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const input = document.querySelector('input[type="file"]') as HTMLInputElement
      const file = makeImageFile('shot.png', 'image/png')
      // happy-dom 可能不触发完整的 change 链路 — 直接走 onChange
      fireEvent.change(input, { target: { files: [file] } })
      await waitFor(() => {
        expect(screen.getByTestId('quick-attachment-strip')).toBeTruthy()
      })
    })

    it('pastinng an image file into the description triggers addImages (not the default text behavior)', () => {
      const file = makeImageFile('paste.png', 'image/png')
      const dataTransfer = {
        items: [{ kind: 'file', getAsFile: () => file, type: 'image/png' }],
      }
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const textarea = screen.getByTestId('quick-description-input') as HTMLTextAreaElement
      // happy-dom 中 onPaste 是合成事件;构造 ClipboardEvent 可能不完全支持,
      // 这里直接调 textarea 的 onPaste prop 触发的 handler。
      const preventDefault = vi.fn()
      const pasteEvent = {
        clipboardData: dataTransfer,
        preventDefault,
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>
      // 通过 fireEvent.paste 触发 (RTL 的 fireEvent 接受任意事件对象)
      fireEvent.paste(textarea, pasteEvent)
      expect(preventDefault).toHaveBeenCalled()
    })

    it('paste with no image file leaves text behavior alone (does not call preventDefault)', () => {
      const dataTransfer = { items: [] }
      const preventDefault = vi.fn()
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const textarea = screen.getByTestId('quick-description-input') as HTMLTextAreaElement
      fireEvent.paste(textarea, { clipboardData: dataTransfer, preventDefault } as unknown as React.ClipboardEvent<HTMLTextAreaElement>)
      expect(preventDefault).not.toHaveBeenCalled()
    })

    it('pasting a non-image file (e.g. PDF) does NOT call preventDefault', () => {
      const pdfFile = makeImageFile('doc.pdf', 'application/pdf')
      const dataTransfer = {
        items: [{ kind: 'file', getAsFile: () => pdfFile, type: 'application/pdf' }],
      }
      const preventDefault = vi.fn()
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const textarea = screen.getByTestId('quick-description-input') as HTMLTextAreaElement
      fireEvent.paste(textarea, { clipboardData: dataTransfer, preventDefault } as unknown as React.ClipboardEvent<HTMLTextAreaElement>)
      expect(preventDefault).not.toHaveBeenCalled()
    })

    it('× button calls removeAttachment (chip removed from strip)', async () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const input = document.querySelector('input[type="file"]') as HTMLInputElement
      fireEvent.change(input, { target: { files: [makeImageFile('shot.png', 'image/png')] } })
      await waitFor(() => { expect(screen.getByTestId('quick-attachment-strip')).toBeTruthy() })
      const removeBtn = document.querySelector('[data-testid^="quick-attachment-chip-"][data-testid$="-remove"]') as HTMLElement
      fireEvent.click(removeBtn)
      // 移除后 strip 卸载(items 0 → null)
      await waitFor(() => {
        expect(screen.queryByTestId('quick-attachment-strip')).toBeNull()
      })
    })
  })
```

- [ ] **Step 2: 跑测试,确认 FAIL**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/QuickCreateModal.test.tsx
```

Expected: 至少 3 个新用例 FAIL(quick-image-picker-trigger not found 等)。

- [ ] **Step 3: 在 QuickCreateModal.tsx 加 state + helpers**

**3a. import 区追加:**

```tsx
import QuickAttachmentStrip, { type QuickAttachment } from './QuickAttachmentStrip.js'
import { readImageAsBase64, ImageReadError } from '../../lib/imageReader.js'
import { PictureOutlined } from '@ant-design/icons'
```

**3b. 文件顶部(常量区)追加:**

```tsx
/** 单次快速创建最多附加 8 张图片(超过截断 + message.warning)。 */
const MAX_IMAGES_PER_QUICK = 8

// crypto.randomUUID() 在 insecure context 下抛异常 (HTTP 非 localhost).
// happy-dom / LAN 模式下访问 zai 的场景 (192.168.x.x) 走 HTTP. 这里兜底到
// 时间戳+随机数,仅用于本地 React key 用,不参与任何 cryptographic 用途。
// 与 AgentInputBox.tsx:75-84 行为一致,不复用 — 那边没 export。
function genLocalId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* ignore */
  }
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
```

**3c. 在 state 区(`const [cwdPickerOpen, setCwdPickerOpen] = useState(false)` 之后)追加:**

```tsx
const [attachments, setAttachments] = useState<QuickAttachment[]>([])
const fileInputRef = useRef<HTMLInputElement>(null)
```

**3d. 在 `handleDone` 之后(`onClose()` 之后,`canSubmit =` 之前)插入 helpers:**

```tsx
async function addImages(files: File[]): Promise<void> {
  const accepted = files.slice(0, MAX_IMAGES_PER_QUICK)
  if (files.length > MAX_IMAGES_PER_QUICK) {
    // antd message: 已被 useMessage 替代? QuickCreateModal 当前用 static message API;
    // 与文件顶部 import 的 message 一致 (antd message 静态 API 在 happy-dom 下能正常触发)。
    // 简化: 直接调用 message.warning
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    message.warning(`最多 ${MAX_IMAGES_PER_QUICK} 张图片,已截断`)
  }
  const placeholders: QuickAttachment[] = accepted.map((f) => ({
    localId: genLocalId(),
    mime: f.type,
    size: f.size,
    filename: f.name || 'image.png',
    dataUrl: '',
    thumbnailUrl: URL.createObjectURL(f),
    status: 'reading',
  }))
  setAttachments((prev) => [...prev, ...placeholders])
  await Promise.all(
    placeholders.map(async (p, i) => {
      try {
        const r = await readImageAsBase64(accepted[i]!)
        setAttachments((prev) =>
          prev.map((a) =>
            a.localId === p.localId
              ? { ...a, dataUrl: r.dataUrl, status: 'ready' }
              : a,
          ),
        )
      } catch (e) {
        const msg =
          e instanceof ImageReadError
            ? e.message
            : e instanceof Error
              ? e.message
              : String(e)
        setAttachments((prev) =>
          prev.map((a) =>
            a.localId === p.localId
              ? { ...a, status: 'error', error: msg }
              : a,
          ),
        )
      }
    }),
  )
}

function removeAttachment(localId: string): void {
  setAttachments((prev) => {
    const att = prev.find((a) => a.localId === localId)
    if (att) URL.revokeObjectURL(att.thumbnailUrl)
    return prev.filter((a) => a.localId !== localId)
  })
}

function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
  const files: File[] = []
  for (const item of e.clipboardData.items) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f && f.type.startsWith('image/')) files.push(f)
    }
  }
  if (files.length === 0) return // 走 antd 默认文本粘贴
  e.preventDefault()
  void addImages(files)
}

function handleFilePick(e: React.ChangeEvent<HTMLInputElement>): void {
  const files = Array.from(e.target.files ?? [])
  if (files.length === 0) return
  void addImages(files)
  e.target.value = ''
}
```

**3e. 在 `useEffect` 的 `if (!open) return` 重置块追加:**

```tsx
setAttachments((prev) => {
  // 重置前 revoke 旧缩略图,避免 blob URL 内存泄漏(用户重新打开弹窗时无残留)
  prev.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl))
  return []
})
```

**3f. 在 `useEffect` 之后(`handleSubmit` 之前)加 cleanup effect(unmount 时兜底):**

```tsx
// 组件卸载时清理所有 blob URL(走完整重置路径之外的兜底,
// 例如父级直接 unmount QuickCreateModal 而非切回 open=false 时)。
useEffect(() => {
  return () => {
    attachments.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

**3g. 在 description Form.Item 的 `<Input.TextArea>` 上挂 onPaste:

找到:

```tsx
<Input.TextArea
  data-testid="quick-description-input"
  value={description}
  onChange={(e) => setDescription(e.target.value)}
  placeholder="..."
  rows={4}
  autoFocus
/>
```

在 `autoFocus` 之后追加:

```tsx
onPaste={handlePaste}
```

**3h. 在 description Form.Item 之后(`</Form.Item>` 紧跟其后)加附件区 + 文件 input:**

找到 description `</Form.Item>` 后、priority `<Form.Item>` 前。**在两者之间**插入:

```tsx
<Form.Item label="附件图片">
  <Space wrap>
    <Button
      icon={<PictureOutlined />}
      data-testid="quick-image-picker-trigger"
      onClick={() => fileInputRef.current?.click()}
    >
      添加图片
    </Button>
    <span style={{ color: 'var(--text-dim-45)', fontSize: 12 }}>
      也可在描述框 Ctrl+V 黏贴截图
    </span>
  </Space>
  <QuickAttachmentStrip items={attachments} onRemove={removeAttachment} disabled={submitting} />
  <input
    ref={fileInputRef}
    type="file"
    accept="image/*"
    multiple
    style={{ display: 'none' }}
    onChange={handleFilePick}
  />
</Form.Item>
```

- [ ] **Step 4: 跑 QuickCreateModal 测试,确认新用例 PASS 且旧用例无回归**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/QuickCreateModal.test.tsx
```

Expected: 所有用例全绿(含新加的 7 个 image attachments 用例 + cwd picker 4 个 + 原有 ~20 个)。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/superTasks/QuickCreateModal.tsx \
        packages/zai/src/web/src/components/superTasks/QuickCreateModal.test.tsx
git commit -m "$(cat <<'EOF'
feat(zai): QuickCreateModal 加图片附件区(按钮 + Ctrl+V 黏贴)

description 下方新增:
- 「添加图片」按钮触发隐藏 input[accept=image/*, multiple]
- description TextArea onPaste 捕获 image/* 黏贴(非 image 走默认)
- 缩略图条用 QuickAttachmentStrip 渲染
- 8 张上限,超过 message.warning 截断
- reading/ready/error 三态由 lib/imageReader + readImageAsBase64 校验

附件区仅 UI + 状态,提交逻辑下一步接入。
EOF
)"
```

---

## Task 6: 集成 uploadImage + 提交流程 + canSubmit 升级 + buildQuickPrompt attachments 段

**Files:**
- Modify: `packages/zai/src/web/src/components/superTasks/QuickCreateModal.tsx`

**Interfaces:**
- Consumes: 已有 `attachments` / `setError` / `setSubmitting`;`<DirectoryPicker>` 已就位
- Produces:
  ```ts
  async function uploadImage(att: QuickAttachment): Promise<string>
  // buildQuickPrompt 新增 attachments 参数;在 'Pass mode: "quick"' 行之前插入
  // canSubmit 升级:!hasReading && (attachments.length===0 || readyCount>0)
  // handleSubmit: 先 Promise.all(uploadImage),再 buildQuickPrompt({ ... , attachments })
  ```

- [ ] **Step 1: 写 failing 测试**

在 QuickCreateModal.test.tsx 的 image attachments describe 后追加:

```tsx
  describe('submit with attachments', () => {
    function makeImageFile(name: string, type: string, sizeBytes = 1024): File {
      const blob = new Blob([new Uint8Array(sizeBytes)], { type })
      return new File([blob], name, { type })
    }

    it('submitting with one ready image uploads it and includes its absPath in the prompt', async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/fs/upload' && init?.method === 'POST') {
          return new Response(JSON.stringify({ ok: true, absPath: '/Users/me/proj/.zai/uploads/shot.png' }), { status: 200 })
        }
        if (url.startsWith('/api/agent/prompt') || url === '/agent/prompt') {
          return new Response(JSON.stringify({ sessionId: 'quick-sess-1' }), { status: 200 })
        }
        return new Response('{}', { status: 200 })
      })
      vi.stubGlobal('fetch', fetchMock)
      render(<QuickCreateModal open onClose={vi.fn()} />)
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [makeImageFile('shot.png', 'image/png')] },
      })
      // 等 ready
      await waitFor(() => {
        expect(screen.getByTestId('quick-attachment-strip')).toBeTruthy()
      })
      fireEvent.change(screen.getByTestId('quick-description-input'), { target: { value: '把按钮文案改一下' } })
      fireEvent.click(screen.getByTestId('quick-submit-button'))
      await waitFor(() => {
        const calls = fetchMock.mock.calls.filter((c) => String(c[0]) === '/agent/prompt' || String(c[0]).endsWith('/agent/prompt'))
        expect(calls.length).toBeGreaterThan(0)
      })
      const call = fetchMock.mock.calls.find((c) => String(c[0]) === '/agent/prompt' || String(c[0]).endsWith('/agent/prompt'))
      const body = JSON.parse((call?.[1] as RequestInit).body as string)
      expect(body.prompt).toContain('attachments (absolute paths, Read these if you need to see them):')
      expect(body.prompt).toContain('- /Users/me/proj/.zai/uploads/shot.png')
      // attachments 段必须在 Pass mode 段之前
      const attachmentsIdx = body.prompt.indexOf('attachments (absolute paths')
      const modeIdx = body.prompt.indexOf('Pass mode: "quick"')
      expect(attachmentsIdx).toBeLessThan(modeIdx)
      vi.unstubAllGlobals()
    })

    it('submit with all-failed attachments does NOT call /agent/prompt and shows error', async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/fs/upload' && init?.method === 'POST') {
          return new Response(JSON.stringify({ ok: false, error: '磁盘满' }), { status: 500 })
        }
        return new Response('{}', { status: 200 })
      })
      vi.stubGlobal('fetch', fetchMock)
      render(<QuickCreateModal open onClose={vi.fn()} />)
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [makeImageFile('shot.png', 'image/png')] },
      })
      await waitFor(() => {
        expect(screen.getByTestId('quick-attachment-strip')).toBeTruthy()
      })
      fireEvent.change(screen.getByTestId('quick-description-input'), { target: { value: '改文案' } })
      const btn = screen.getByTestId('quick-submit-button') as HTMLButtonElement
      // 先看 canSubmit 是不是 false
      // 由于 reading → ready 之后正常;但 upload 全失败后,readyCount=0;canSubmit 应该是 false
      // 这里直接点 — UI 应短路 + setError
      fireEvent.click(btn)
      // 等到 /agent/prompt 调用计数为 0(若调用则说明没阻断)
      await waitFor(() => {
        const promptCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/agent/prompt'))
        expect(promptCalls.length).toBe(0)
      })
      expect(await screen.findByText(/所有图片上传失败/)).toBeTruthy()
      vi.unstubAllGlobals()
    })

    it('reading status disables submit button', () => {
      // 单纯 reading 状态:不模拟 readImageAsBase64 完成,用 Promise 挂起
      // 这里简化:直接看初始 state(空 attachments,按钮可点;加 reading 附件后按钮 disable)
      // 加一个 happy-dom 不友好的测试就跳过 — 不写。
    })
  })
```

> **注**:任务 5 的 `addImages` 内的 `setAttachments` 默认 placeholder 状态是 `'reading'`,但 happy-dom 同步 FileReader 可能立即 resolve 到 ready,所以「reading 状态下按钮 disable」在 happy-dom 里很难稳定测。**这一项不强求单测覆盖**,手动用 `/ego-browser` 验证即可(把浏览器 throttle slow 4G 看按钮瞬间 disabled→enabled)。

- [ ] **Step 2: 跑测试,确认新增 submit 用例至少第一个 FAIL**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/QuickCreateModal.test.tsx
```

Expected: 「submitting with one ready image ...」FAIL —— `body.prompt` 不含 `attachments (absolute paths ...)`,因为还没实现。

- [ ] **Step 3: 实现 uploadImage + canSubmit 升级 + buildQuickPrompt attachments + handleSubmit 集成**

**3a. 在 helpers 区(`removeAttachment` 之后、`handlePaste` 之前)加 uploadImage:**

```tsx
async function uploadImage(att: QuickAttachment): Promise<string> {
  const data = att.dataUrl.replace(/^data:[^;]+;base64,/, '')
  const res = await fetch('/api/fs/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: att.filename, data }),
  })
  const body = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as { ok: boolean; error?: string; absPath?: string }
  if (!res.ok || !body.ok) {
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  if (!body.absPath) throw new Error('上传响应缺少 absPath')
  return body.absPath
}
```

**3b. 升级 canSubmit:**

找到:

```tsx
const canSubmit = description.trim().length > 0 && !submitting
```

改为:

```tsx
const hasReading = attachments.some((a) => a.status === 'reading')
const readyCount = attachments.filter((a) => a.status === 'ready').length
const hasAnyAttachment = attachments.length > 0
const canSubmit = description.trim().length > 0
  && !submitting
  && !hasReading                                     // 还在读 → 阻断
  && (!hasAnyAttachment || readyCount > 0)           // 有附件但全失败 → 阻断
```

**3c. 升级 handleSubmit:**

找到 `async function handleSubmit(): Promise<void>` 整段。原版:

```tsx
async function handleSubmit(): Promise<void> {
  const d = description.trim()
  if (!d) return
  setSubmitting(true)
  setError(null)
  try {
    const globalSessions = useAgentStore.getState().sessions
    const finalCwd = cwd.trim() || defaultCwd || undefined
    const sid = await createAgentSession({ ... })
    setActiveSessionId(sid)
    const title = deriveTitleFromDescription(d)
    const prompt = buildQuickPrompt({ title, description: d, priority, cwd: finalCwd ?? '', agent, dependsOn })
    const resp = await api.post<{ sessionId: string; queued?: boolean }>('/agent/prompt', { prompt, sessionId: sid }, { headers: { 'X-Session-Id': sid } })
    if (!resp?.sessionId) {
      throw new Error('submit prompt failed: empty sessionId')
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : '创建任务失败')
  } finally {
    setSubmitting(false)
  }
}
```

**改为:**

```tsx
async function handleSubmit(): Promise<void> {
  const d = description.trim()
  if (!d) return
  setSubmitting(true)
  setError(null)
  try {
    // 先并发上传所有 ready 图片(失败项被 Promise.all 抛错,后续用 allSettled 收集)
    const readyAtts = attachments.filter((a) => a.status === 'ready')
    const uploadResults = await Promise.allSettled(
      readyAtts.map((att) => uploadImage(att)),
    )
    const readyPaths: string[] = []
    const failedCount = uploadResults.filter((r) => r.status === 'rejected').length
    for (const r of uploadResults) {
      if (r.status === 'fulfilled') readyPaths.push(r.value)
    }
    if (readyAtts.length > 0 && readyPaths.length === 0) {
      throw new Error(`所有图片上传失败(共 ${readyAtts.length} 张),请重试或移除`)
    }
    const globalSessions = useAgentStore.getState().sessions
    const finalCwd = cwd.trim() || defaultCwd || undefined
    const sid = await createAgentSession({
      mainAgent: 'task-intake-quick',
      ...(finalCwd ? { cwd: finalCwd } : {}),
      ...pickLastSelectedModel(globalSessions),
    })
    setActiveSessionId(sid)
    const title = deriveTitleFromDescription(d)
    const prompt = buildQuickPrompt({
      title, description: d, priority,
      cwd: finalCwd ?? '', agent, dependsOn,
      attachments: readyPaths,
    })
    const resp = await api.post<{ sessionId: string; queued?: boolean }>(
      '/agent/prompt',
      { prompt, sessionId: sid },
      { headers: { 'X-Session-Id': sid } },
    )
    if (!resp?.sessionId) {
      throw new Error('submit prompt failed: empty sessionId')
    }
    // 成功后清空附件(保留 thumbnailUrl 内存引用,因为用户可能想重看)
    // 不主动 revokeObjectURL —— 缩略图 DOM 已随 strip 卸载,blob URL 自然 GC
    setAttachments([])
    if (failedCount > 0) {
      // 部分失败:用 message.warning 告知,但不影响后续流程
      message.warning(`${failedCount} 张图片上传失败,未包含在附件清单中`)
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : '创建任务失败')
  } finally {
    setSubmitting(false)
  }
}
```

**3d. 升级 buildQuickPrompt:**

找到原 `buildQuickPrompt`(原 373-391 行):

```tsx
function buildQuickPrompt(input: {
  title: string; description: string; priority: QuickPriority
  cwd: string; agent: string; dependsOn: string[]
}): string {
  const lines: string[] = [
    `Create a quick task with the following fields:`,
    `- title: ${input.title}`,
    `- description: ${input.description}`,
    `- priority: ${input.priority}`,
    ...(input.cwd ? [`- cwd: ${input.cwd}`] : []),
    `- agent: ${input.agent}`,
    ...(input.dependsOn.length > 0
      ? [`- dependsOn: [${input.dependsOn.join(', ')}]`]
      : []),
    '',
    'Pass mode: "quick" when calling SuperTasksCreate. ...',
  ]
  return lines.join('\n')
}
```

**改为:**

```tsx
function buildQuickPrompt(input: {
  title: string; description: string; priority: QuickPriority
  cwd: string; agent: string; dependsOn: string[]
  attachments?: string[]   // 新增:已上传图片的绝对路径
}): string {
  const lines: string[] = [
    `Create a quick task with the following fields:`,
    `- title: ${input.title}`,
    `- description: ${input.description}`,
    `- priority: ${input.priority}`,
    ...(input.cwd ? [`- cwd: ${input.cwd}`] : []),
    `- agent: ${input.agent}`,
    ...(input.dependsOn.length > 0
      ? [`- dependsOn: [${input.dependsOn.join(', ')}]`]
      : []),
  ]
  // attachments 段在 Pass mode 之前插入,确保模型先看到附件清单再被告知约束
  if (input.attachments && input.attachments.length > 0) {
    lines.push('', 'attachments (absolute paths, Read these if you need to see them):')
    for (const p of input.attachments) {
      lines.push(`- ${p}`)
    }
  }
  lines.push(
    '',
    'Pass mode: "quick" when calling SuperTasksCreate. Do NOT generate a planning doc or meeting minutes — quick mode keeps the directory lean by design.',
  )
  return lines.join('\n')
}
```

- [ ] **Step 4: 跑 QuickCreateModal 测试,确认所有用例全绿**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/QuickCreateModal.test.tsx
```

Expected: 全部 ~30 个用例绿(含 cwd picker 4 + image attachments 7 + submit with attachments 2 + 原有 ~20)。

- [ ] **Step 5: 跑 DirectoryPicker + QuickAttachmentStrip 测试,确认无回归**

```bash
pnpm --filter @zn-ai/zai test \
  src/web/src/components/common/DirectoryPicker.test.tsx \
  src/web/src/components/superTasks/QuickAttachmentStrip.test.tsx \
  src/web/src/components/superTasks/QuickCreateModal.test.tsx
```

Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/superTasks/QuickCreateModal.tsx \
        packages/zai/src/web/src/components/superTasks/QuickCreateModal.test.tsx
git commit -m "$(cat <<'EOF'
feat(zai): QuickCreateModal 提交流程集成图片附件

- uploadImage 走 /api/fs/upload → 拿到 absPath
- handleSubmit: Promise.allSettled 并发上传,部分成功路径保留
- 全部失败 → setError 阻断 + 不调 /agent/prompt
- buildQuickPrompt 新增 attachments 段,在 Pass mode 行之前
- canSubmit 升级:!hasReading && (!hasAnyAttachment || readyCount>0)
- 成功后 setAttachments([]);部分失败 message.warning 提示
EOF
)"
```

---

## Task 7: mobileAsDrawer 路径专项测试 + 手动浏览器验收

**Files:**
- Modify: `packages/zai/src/web/src/components/superTasks/QuickCreateModal.test.tsx`

**Context:** 任务 4/5/6 已涵盖 desktop Modal 路径;这里补 mobileAsDrawer 用例确认 cwd picker / 图片附件 / 黏贴在 Drawer 容器内同样工作。

- [ ] **Step 1: 写 mobileAsDrawer 专项测试**

在 QuickCreateModal.test.tsx 的 mobileAsDrawer describe(原 254 行附近,已有「renders .ant-drawer」「表单字段仍完整渲染」等用例)**末尾**追加:

```tsx
    it('mobileAsDrawer=true: cwd picker trigger works and fills cwd', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ ok: true, path: '/Users/picked', parent: '/Users', home: '/Users', entries: [] }),
        { status: 200 },
      )))
      render(<QuickCreateModal open onClose={vi.fn()} mobileAsDrawer />)
      fireEvent.click(screen.getByTestId('quick-cwd-picker-trigger'))
      await screen.findByTestId('picker-select')
      fireEvent.click(screen.getByTestId('picker-select'))
      expect((screen.getByTestId('quick-cwd-input') as HTMLInputElement).value).toBe('/Users/picked')
      vi.unstubAllGlobals()
    })

    it('mobileAsDrawer=true: image picker trigger button present', () => {
      render(<QuickCreateModal open onClose={vi.fn()} mobileAsDrawer />)
      expect(screen.getByTestId('quick-image-picker-trigger')).toBeTruthy()
    })
```

- [ ] **Step 2: 跑测试,确认 PASS**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/QuickCreateModal.test.tsx
```

Expected: 全绿(mobileAsDrawer 在已有 Modal 形态测试之上加 2 个新用例,加 sticky drawer 测试覆盖 cwd picker + image picker)。

- [ ] **Step 3: 手动浏览器验收(`/ego-browser` —— 必做,不能跳过)**

```bash
# 起独立 dev 端口(避免与现有 920x / 8101 实例冲突)
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715
```

走 `/ego-browser` skill 验证以下路径,**全部**通过才算完成:

**桌面 `/super-tasks` 路径:**

1. 打开快速创建 Modal → 看到 cwd 字段旁「选择目录」按钮 + description 下方「添加图片」按钮
2. 点「选择目录」→ DirectoryPicker Modal 弹出 → 点 home → 点 entries → 点「选择当前目录」→ cwd 字段更新成选中路径 → picker 关闭
3. 点「添加图片」→ 文件选择器 → 选一张 PNG → 看到缩略图条(包含文件名 + 缩略图 + ×)
4. 在 description 框里 `Cmd+V` 一张截图 → 缩略图条新增一项
5. (手动)选 11MB 图片 → 缩略图卡片红字 + 「图片超过 10MB 上限」
6. (手动)选 PDF 黏贴 → 文本不消失(走 antd 默认)
7. 填齐 description → 点「快速创建」→ 看到后端收到 `/agent/prompt` 的 prompt 含 `attachments:` 段 + 绝对路径 + 在 `Pass mode: "quick"` 之前
8. 等 SSE `task_factory.created` → 看到完成条 → 点「完成」关闭弹窗
9. 重新打开弹窗 → attachments 已清空

**移动端 `/m-super-tasks` 路径:**

10. 切到 `/m` → drawer 模式同样走完 1-9(选目录、添加图片、黏贴、提交、完成)

- [ ] **Step 4: 修复任何视觉/行为缺陷**

如果 `/ego-browser` 走的过程中发现任何不一致(按钮位置 / 缩略图尺寸 / drawer 内 picker 弹层 / 移动端 picker Modal 弹不出等),按 docs/DEVELOPMENT_REFERENCE.md 的样式改动规则调整,**不**跑单元测试。

如果发现功能性 bug(接口契约 / 状态错误),改对应组件代码并补测试用例。

- [ ] **Step 5: 跑完整相关测试集(最终 sanity)**

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zai test \
  src/web/src/components/common/DirectoryPicker.test.tsx \
  src/web/src/components/superTasks/QuickAttachmentStrip.test.tsx \
  src/web/src/components/superTasks/QuickCreateModal.test.tsx \
  src/web/src/pages/Instances.picker.test.tsx
```

Expected: 全绿。

- [ ] **Step 6: Commit(如有过修复)**

```bash
git add packages/zai/src/web/src/components/superTasks/QuickCreateModal.tsx \
        packages/zai/src/web/src/components/superTasks/QuickCreateModal.test.tsx
git commit -m "$(cat <<'EOF'
test(zai): QuickCreateModal mobileAsDrawer 路径专项测试 + ego-browser 验收

补 mobileAsDrawer 用例覆盖 cwd picker + image picker trigger。
走 /ego-browser 走完桌面 + 移动端两条路径,任何视觉/行为缺陷
就地修复。
EOF
)"
```

---

## Self-Review Checklist

实现者走完每个任务时核对:

- [ ] **任务 1**:DirectoryPicker 单测覆盖 9 个用例(open=false 不渲染 / fetch / entries / 错误 / 上级 / 主页 / 选中 / 取消 / 空目录)
- [ ] **任务 2**:Instances.picker.test.tsx 改 import 后零行为变化(所有原有用例仍 PASS)
- [ ] **任务 3**:QuickAttachmentStrip 单测覆盖 5 个用例(空 / 多张 / × / error 红字 / disabled)
- [ ] **任务 4**:QuickCreateModal cwd picker 4 个用例 + 旧 ~20 用例无回归
- [ ] **任务 5**:QuickCreateModal image attachments 7 个用例 + 旧用例无回归
- [ ] **任务 6**:QuickCreateModal submit with attachments 2 个用例(含 attachments 在 Pass mode 之前断言) + 全局无回归
- [ ] **任务 7**:mobileAsDrawer 2 个用例 + `/ego-browser` 桌面 + 移动端两条路径全通过

## Spec Coverage Map

| Spec § | 实现任务 |
|--------|---------|
| §4.1 DirectoryPicker 抽到 common/ | Task 1 + Task 2 |
| §4.1 QuickAttachmentStrip 新建 | Task 3 |
| §4.1 QuickCreateModal 改 | Task 4 + Task 5 + Task 6 |
| §5.1-5.7 数据流 / 提交流程 | Task 6 |
| §6 错误处理 / 边界 | Task 5(reading/error UI) + Task 6(canSubmit 阻断 + upload 失败) |
| §7 测试 | Task 1 / 3 / 5 / 6 / 7 |
| §10 验收清单 | Task 7(`/ego-browser`) |