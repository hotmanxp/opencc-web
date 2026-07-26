# 移动端「常用指令」Drawer 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在移动端 AgentInputBox 工具栏新增 [⚡] 按钮,点击右侧弹出 Drawer,内含 快捷 Bash (top10) + 常用指令 (本地片段) 两个 tab。

**Architecture:** 新建两个 hook (`useQuickPrompts` / `useSubmitPrompt`) 与一个组件 (`MobileQuickDrawer`),把 `AgentInputBox` 内联的 `postPromptToLLM` + `pushUserMsg` 抽到 hook 复用;Drawer 通过 props 与父级 `MobileAgent` 受控;Bash tab 直接复用 `useBashRepl.topCommands` + `execRepl`,不新增 server endpoint。

**Tech Stack:** React 18 + TypeScript + AntD 5 + zustand 4 + vitest 3 + happy-dom + localStorage (自定义同步事件 `zai-localstorage-sync`)。

## Global Constraints

- 范围仅限 `packages/zai/src/web/src/`,不改动 `packages/zai-agent-core/`、`packages/zai/src/server/`、`packages/zai/src/shared/`。
- **不新增 server endpoint**;Bash 执行复用 `POST /api/bash/repl/:sid/exec`,Bash top10 复用 `GET /api/bash/history/top10`,提交走既有 `POST /api/agent/prompt`。
- 不破坏 BashTab、slash 命令补全、`/agent/prompt` 既有契约。
- localStorage key 必须命名为 `zai.quickPrompts.v1` (新命名空间,前缀 `zai.quickPrompts`)。
- 自定义 prompt 片段文本长度 `1..200` 字符,trim 后空字符串或超长拒绝;容量上限 `MAX_PROMPTS = 50`,超出按 `createdAt` 升序截断。
- 预填 3 条种子: `'优化这段代码的可读性与性能'` / `'为这段函数补上单元测试'` / `'解释这个错误的根因,并给出修复建议'` — 仅当 `localStorage` 完全无该 key 时写入,后续用户操作完全覆盖。
- 桌面端(`useAppStore.isMobile === false`)整个 Drawer 按钮不挂载、Drawer 组件不渲染。
- 跨 tab 同步: 写完 localStorage 后 dispatch `CustomEvent('zai-localstorage-sync', { detail: { key, value } })`。
- 所有新增测试文件必须以 `// @vitest-environment happy-dom` 开头(React 渲染需要 DOM 环境)。
- 类型检查命令: `pnpm --filter @zn-ai/zai typecheck`(等价 `tsc -b --noEmit`)。
- 测试命令: `pnpm --filter @zn-ai/zai test -- --run src/web/src/<path>` 单文件 / `pnpm --filter @zn-ai/zai test -- --run` 全量。

---

## File Structure

**新增文件** (3 个 hook/component + 3 个测试):

| 路径 | 职责 | LOC 估算 |
|---|---|---|
| `packages/zai/src/web/src/hooks/useQuickPrompts.ts` | localStorage 读写 + add/remove/clear + dedup + 容量上限 + 预填示例种子 | ~120 |
| `packages/zai/src/web/src/hooks/useSubmitPrompt.ts` | 把 `AgentInputBox.postPromptToLLM` + `pushUserMsg` 抽出,返回 `{ submitPrompt, pushUserMsg }` | ~80 |
| `packages/zai/src/web/src/components/MobileQuickDrawer.tsx` | 受控 Drawer,内部 Tab 切换、Bash/Prompt 列表、增删 UI | ~250 |
| `packages/zai/src/web/src/hooks/useQuickPrompts.test.ts` | hook 单测 | ~140 |
| `packages/zai/src/web/src/hooks/useSubmitPrompt.test.ts` | hook 单测 | ~120 |
| `packages/zai/src/web/src/components/MobileQuickDrawer.test.tsx` | 组件单测 | ~180 |

**修改文件** (3 个):

| 路径 | 修改 |
|---|---|
| `packages/zai/src/web/src/components/splitPane/shared.ts` | `STORAGE_KEYS` 新增 `quickPrompts: 'zai.quickPrompts.v1'` |
| `packages/zai/src/web/src/components/AgentInputBox.tsx` | 1) 状态栏最左端新增 [⚡] 按钮 (仅 `isMobile`);2) 把 `postPromptToLLM` / `pushUserMsg` 替换为 `useSubmitPrompt()` 调用;3) 新增 props `onQuickDrawerOpenChange?: (open: boolean) => void` |
| `packages/zai/src/web/src/pages/MobileAgent.tsx` | 挂载 `<MobileQuickDrawer open={quickDrawerOpen} onClose={...} />` + 新增受控 state |
| `packages/zai/src/web/src/components/AgentInputBox.test.tsx` | 新增 [⚡] 按钮断言 (`data-testid="mobile-quick-drawer-toggle"`) + 点击触发 `onQuickDrawerOpenChange(true)` |

---

## Task 1: `STORAGE_KEYS` 新增 quickPrompts

**Files:**
- Modify: `packages/zai/src/web/src/components/splitPane/shared.ts:3-10`

**Interfaces:**
- Consumes: (无)
- Produces: `STORAGE_KEYS.quickPrompts: 'zai.quickPrompts.v1'`

- [ ] **Step 1: 修改 shared.ts**

打开 `packages/zai/src/web/src/components/splitPane/shared.ts`,把:

```ts
export const STORAGE_KEYS = {
  open: 'zai.splitPane.open',
  tab: 'zai.splitPane.tab',
  width: 'zai.splitPane.widthVw',
} as const
```

替换为:

```ts
export const STORAGE_KEYS = {
  open: 'zai.splitPane.open',
  tab: 'zai.splitPane.tab',
  width: 'zai.splitPane.widthVw',
  // 2026-07-26+: 移动端常用指令 Drawer 的本地 prompt 片段持久化。
  // 独立命名空间避开既有 zai.splitPane.* / zai.app.* 前缀。
  quickPrompts: 'zai.quickPrompts.v1',
} as const
```

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/splitPane/shared.ts
git commit -m "feat(web): STORAGE_KEYS 新增 quickPrompts 命名空间"
```

---

## Task 2: `useQuickPrompts` hook + 测试

**Files:**
- Create: `packages/zai/src/web/src/hooks/useQuickPrompts.ts`
- Create: `packages/zai/src/web/src/hooks/useQuickPrompts.test.ts`

**Interfaces:**
- Consumes: `STORAGE_KEYS.quickPrompts` from `../components/splitPane/shared.js`
- Produces:
  ```ts
  export interface QuickPrompt {
    id: string
    text: string
    createdAt: number
  }
  export interface UseQuickPromptsResult {
    prompts: QuickPrompt[]
    add: (text: string) => QuickPrompt | null
    remove: (id: string) => void
    clear: () => void
  }
  export const MAX_PROMPTS = 50
  export const MIN_TEXT = 1
  export const MAX_TEXT = 200
  export const DEFAULT_QUICK_PROMPTS_SEED: ReadonlyArray<{ text: string }>
  ```

- [ ] **Step 1: 写失败测试**

新建 `packages/zai/src/web/src/hooks/useQuickPrompts.test.ts`:

```ts
// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_QUICK_PROMPTS_SEED,
  MAX_PROMPTS,
  MAX_TEXT,
  useQuickPrompts,
} from './useQuickPrompts.js'

const KEY = 'zai.quickPrompts.v1'

function reset() {
  localStorage.clear()
}

beforeEach(reset)
afterEach(reset)

describe('useQuickPrompts — 初次挂载', () => {
  it('localStorage 无 key 时写入 3 条预填示例', () => {
    const { result } = renderHook(() => useQuickPrompts())
    expect(result.current.prompts).toHaveLength(DEFAULT_QUICK_PROMPTS_SEED.length)
    expect(localStorage.getItem(KEY)).not.toBeNull()
    const stored = JSON.parse(localStorage.getItem(KEY)!)
    expect(stored.map((p: { text: string }) => p.text)).toEqual(
      DEFAULT_QUICK_PROMPTS_SEED.map((s) => s.text),
    )
  })

  it('已有 key 时不覆盖,沿用持久化内容', () => {
    const existing = [{ id: 'a', text: 'custom', createdAt: 1 }]
    localStorage.setItem(KEY, JSON.stringify(existing))
    const { result } = renderHook(() => useQuickPrompts())
    expect(result.current.prompts).toEqual(existing)
  })

  it('JSON.parse 失败 → fallback []', () => {
    localStorage.setItem(KEY, '{not json')
    const { result } = renderHook(() => useQuickPrompts())
    expect(result.current.prompts).toEqual([])
  })
})

describe('useQuickPrompts — add', () => {
  it('返回 QuickPrompt 对象,text 与 createdAt 正确', () => {
    const { result } = renderHook(() => useQuickPrompts())
    let added: ReturnType<typeof result.current.add> = null
    act(() => {
      added = result.current.add('  hello  ')
    })
    expect(added).not.toBeNull()
    expect(added!.text).toBe('hello')
    expect(typeof added!.id).toBe('string')
    expect(typeof added!.createdAt).toBe('number')
    expect(result.current.prompts).toHaveLength(DEFAULT_QUICK_PROMPTS_SEED.length + 1)
  })

  it('空字符串 / 仅空白 → 返回 null', () => {
    const { result } = renderHook(() => useQuickPrompts())
    const before = result.current.prompts.length
    expect(result.current.add('')).toBeNull()
    expect(result.current.add('   ')).toBeNull()
    expect(result.current.prompts.length).toBe(before)
  })

  it(`超过 ${MAX_TEXT} 字符 → 返回 null`, () => {
    const { result } = renderHook(() => useQuickPrompts())
    expect(result.current.add('a'.repeat(MAX_TEXT + 1))).toBeNull()
  })

  it('重复文本 → 返回 null', () => {
    const { result } = renderHook(() => useQuickPrompts())
    // 取预填示例第一条
    const existingText = DEFAULT_QUICK_PROMPTS_SEED[0]!.text
    expect(result.current.add(existingText)).toBeNull()
  })

  it(`达到 MAX_PROMPTS 时截断最旧(createdAt 升序)`, () => {
    localStorage.clear()
    const seed = Array.from({ length: MAX_PROMPTS }, (_, i) => ({
      id: `seed-${i}`,
      text: `seed ${i}`,
      createdAt: i,
    }))
    localStorage.setItem(KEY, JSON.stringify(seed))
    const { result } = renderHook(() => useQuickPrompts())
    expect(result.current.prompts).toHaveLength(MAX_PROMPTS)
    act(() => {
      result.current.add('newest')
    })
    expect(result.current.prompts).toHaveLength(MAX_PROMPTS)
    expect(result.current.prompts.at(-1)!.text).toBe('newest')
    // seed-0 是最旧的,被截断
    expect(result.current.prompts.find((p) => p.text === 'seed 0')).toBeUndefined()
  })
})

describe('useQuickPrompts — remove / clear', () => {
  it('remove 后数组与 localStorage 都清掉对应项', () => {
    const { result } = renderHook(() => useQuickPrompts())
    const first = result.current.prompts[0]!
    act(() => {
      result.current.remove(first.id)
    })
    expect(result.current.prompts.find((p) => p.id === first.id)).toBeUndefined()
    const stored = JSON.parse(localStorage.getItem(KEY)!)
    expect(stored.find((p: { id: string }) => p.id === first.id)).toBeUndefined()
  })

  it('clear 后数组为空,localStorage 写入 []', () => {
    const { result } = renderHook(() => useQuickPrompts())
    expect(result.current.prompts.length).toBeGreaterThan(0)
    act(() => {
      result.current.clear()
    })
    expect(result.current.prompts).toEqual([])
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test -- --run src/web/src/hooks/useQuickPrompts.test.ts`
Expected: FAIL — `Cannot find module './useQuickPrompts.js'`

- [ ] **Step 3: 实现 hook**

新建 `packages/zai/src/web/src/hooks/useQuickPrompts.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { STORAGE_KEYS } from '../components/splitPane/shared.js'

export interface QuickPrompt {
  id: string
  text: string
  createdAt: number
}

export interface UseQuickPromptsResult {
  prompts: QuickPrompt[]
  add: (text: string) => QuickPrompt | null
  remove: (id: string) => void
  clear: () => void
}

export const MAX_PROMPTS = 50
export const MIN_TEXT = 1
export const MAX_TEXT = 200

export const DEFAULT_QUICK_PROMPTS_SEED: ReadonlyArray<{ text: string }> = [
  { text: '优化这段代码的可读性与性能' },
  { text: '为这段函数补上单元测试' },
  { text: '解释这个错误的根因,并给出修复建议' },
]

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* fallback */
  }
  return `qp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function loadFromStorage(): QuickPrompt[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.quickPrompts)
    if (raw === null) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed as QuickPrompt[]
  } catch {
    return null
  }
}

function saveToStorage(prompts: QuickPrompt[]): void {
  try {
    const serialized = JSON.stringify(prompts)
    localStorage.setItem(STORAGE_KEYS.quickPrompts, serialized)
    window.dispatchEvent(
      new CustomEvent('zai-localstorage-sync', {
        detail: { key: STORAGE_KEYS.quickPrompts, value: serialized },
      }),
    )
  } catch {
    /* quota / privacy mode — silently ignore */
  }
}

function seedPrompts(): QuickPrompt[] {
  const now = Date.now()
  const seeded = DEFAULT_QUICK_PROMPTS_SEED.map((s, i) => ({
    id: genId(),
    text: s.text,
    createdAt: now + i,
  }))
  saveToStorage(seeded)
  // eslint-disable-next-line no-console
  console.info('[quick-prompts] seeded', seeded.length, 'default prompts')
  return seeded
}

export function useQuickPrompts(): UseQuickPromptsResult {
  const [prompts, setPrompts] = useState<QuickPrompt[]>(() => {
    const existing = loadFromStorage()
    if (existing !== null) return existing
    return seedPrompts()
  })
  const promptsRef = useRef<QuickPrompt[]>(prompts)

  useEffect(() => {
    promptsRef.current = prompts
  }, [prompts])

  // 跨 tab / 同 tab 同步 — 监听 storage 与 zai-localstorage-sync。
  useEffect(() => {
    const onSync = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string; value: string | null }>).detail
      if (!detail || detail.key !== STORAGE_KEYS.quickPrompts) return
      if (detail.value === null) return
      try {
        const parsed = JSON.parse(detail.value) as QuickPrompt[]
        if (Array.isArray(parsed)) {
          setPrompts(parsed)
          promptsRef.current = parsed
        }
      } catch {
        /* ignore corrupt */
      }
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEYS.quickPrompts) return
      if (e.newValue === null) return
      try {
        const parsed = JSON.parse(e.newValue) as QuickPrompt[]
        if (Array.isArray(parsed)) setPrompts(parsed)
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('zai-localstorage-sync', onSync)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('zai-localstorage-sync', onSync)
    }
  }, [])

  const add = useCallback((text: string): QuickPrompt | null => {
    const trimmed = text.trim()
    if (trimmed.length < MIN_TEXT || trimmed.length > MAX_TEXT) return null
    const current = promptsRef.current
    if (current.some((p) => p.text === trimmed)) return null
    const item: QuickPrompt = {
      id: genId(),
      text: trimmed,
      createdAt: Date.now(),
    }
    let next: QuickPrompt[]
    if (current.length >= MAX_PROMPTS) {
      // 截断最旧 (createdAt 升序)
      next = [...current.slice(current.length - MAX_PROMPTS + 1), item]
    } else {
      next = [...current, item]
    }
    setPrompts(next)
    promptsRef.current = next
    saveToStorage(next)
    return item
  }, [])

  const remove = useCallback((id: string) => {
    const next = promptsRef.current.filter((p) => p.id !== id)
    setPrompts(next)
    promptsRef.current = next
    saveToStorage(next)
  }, [])

  const clear = useCallback(() => {
    setPrompts([])
    promptsRef.current = []
    saveToStorage([])
  }, [])

  return { prompts, add, remove, clear }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test -- --run src/web/src/hooks/useQuickPrompts.test.ts`
Expected: PASS(全部用例)

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/hooks/useQuickPrompts.ts \
        packages/zai/src/web/src/hooks/useQuickPrompts.test.ts
git commit -m "feat(web): 新增 useQuickPrompts hook (localStorage + dedup + 容量上限 + 预填示例)"
```

---

## Task 3: `useSubmitPrompt` hook + 测试

**Files:**
- Create: `packages/zai/src/web/src/hooks/useSubmitPrompt.ts`
- Create: `packages/zai/src/web/src/hooks/useSubmitPrompt.test.ts`

**Interfaces:**
- Consumes: `api.post` from `../lib/api.js`, `useAgentStore` from `../store/useAgentStore.js`, `deriveLocalTitle` (从 AgentInputBox 提取)
- Produces:
  ```ts
  export interface UseSubmitPromptResult {
    submitPrompt: (text: string, opts?: { skipPushUserMsg?: boolean }) => Promise<void>
    pushUserMsg: (text: string, isRenderedPrompt?: boolean) => void
  }
  ```

- [ ] **Step 1: 写失败测试**

新建 `packages/zai/src/web/src/hooks/useSubmitPrompt.test.ts`:

```ts
// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiPost = vi.fn(async () => ({ sessionId: 'sess-x' }))
vi.mock('../lib/api.js', () => ({
  api: { post: apiPost },
}))

import { useSubmitPrompt } from './useSubmitPrompt.js'
import { useAgentStore } from '../store/useAgentStore.js'

beforeEach(() => {
  apiPost.mockClear()
  apiPost.mockResolvedValue({ sessionId: 'sess-x' } as any)
  useAgentStore.setState({
    sessionId: 'sess-1',
    activeSessionId: 'sess-1',
    status: 'idle',
    messages: [],
    sendSeq: 0,
  })
})

afterEach(() => {
  useAgentStore.setState({
    sessionId: null,
    activeSessionId: null,
    status: 'idle',
    messages: [],
    sendSeq: 0,
  })
})

describe('useSubmitPrompt — pushUserMsg', () => {
  it('写入 user.text 到 store,sendSeq +1,状态切 streaming', () => {
    const { result } = renderHook(() => useSubmitPrompt())
    act(() => {
      result.current.pushUserMsg('hi')
    })
    const s = useAgentStore.getState()
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ type: 'user.text', text: 'hi', isRenderedPrompt: false })
    expect(s.sendSeq).toBe(1)
    expect(s.status).toBe('streaming')
  })

  it('isRenderedPrompt=true 时透传', () => {
    const { result } = renderHook(() => useSubmitPrompt())
    act(() => {
      result.current.pushUserMsg('rendered', true)
    })
    expect(useAgentStore.getState().messages[0]).toMatchObject({ isRenderedPrompt: true })
  })
})

describe('useSubmitPrompt — submitPrompt', () => {
  it('先 pushUserMsg,再 POST /agent/prompt', async () => {
    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submitPrompt('hello')
    })
    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(apiPost).toHaveBeenCalledWith(
      '/agent/prompt',
      expect.objectContaining({ prompt: 'hello', sessionId: 'sess-1' }),
      expect.any(Object),
    )
    const s = useAgentStore.getState()
    expect(s.messages.some((m: any) => m.text === 'hello')).toBe(true)
  })

  it('skipPushUserMsg=true 时不写 user.text', async () => {
    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submitPrompt('silent', { skipPushUserMsg: true })
    })
    const s = useAgentStore.getState()
    expect(s.messages.some((m: any) => m.text === 'silent')).toBe(false)
    expect(apiPost).toHaveBeenCalledTimes(1)
  })

  it('sessionId 为空时回退 activeSessionId', async () => {
    useAgentStore.setState({ sessionId: null, activeSessionId: 'sess-2' })
    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submitPrompt('x')
    })
    expect(apiPost.mock.calls[0]![1]).toMatchObject({ sessionId: 'sess-2' })
  })

  it('返回的 sessionId 同步回 store', async () => {
    apiPost.mockResolvedValueOnce({ sessionId: 'sess-new' } as any)
    useAgentStore.setState({ sessionId: null, activeSessionId: null })
    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submitPrompt('first')
    })
    const s = useAgentStore.getState()
    expect(s.sessionId).toBe('sess-new')
    expect(s.activeSessionId).toBe('sess-new')
  })

  it('第一行作为 title,通过 applySessionEvent 触发 session.renamed', async () => {
    apiPost.mockResolvedValueOnce({ sessionId: 'sess-new' } as any)
    useAgentStore.setState({ sessionId: null, activeSessionId: null })
    const applySpy = vi.spyOn(useAgentStore.getState(), 'applySessionEvent')
    const { result } = renderHook(() => useSubmitPrompt())
    await act(async () => {
      await result.current.submitPrompt('My Title\nnext line')
    })
    expect(applySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.renamed',
        sessionId: 'sess-new',
        title: 'My Title',
      }),
    )
    applySpy.mockRestore()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test -- --run src/web/src/hooks/useSubmitPrompt.test.ts`
Expected: FAIL — `Cannot find module './useSubmitPrompt.js'`

- [ ] **Step 3: 实现 hook**

新建 `packages/zai/src/web/src/hooks/useSubmitPrompt.ts`:

```ts
import { useCallback } from 'react'
import { api } from '../lib/api.js'
import { useAgentStore, type AgentMessage } from '../store/useAgentStore.js'

const TITLE_MAX_LEN = 50

export function deriveLocalTitle(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]!.trim()
  if (!firstLine) return ''
  if (firstLine.length <= TITLE_MAX_LEN) return firstLine
  return firstLine.slice(0, TITLE_MAX_LEN - 1) + '…'
}

export interface UseSubmitPromptResult {
  submitPrompt: (
    text: string,
    opts?: { skipPushUserMsg?: boolean },
  ) => Promise<void>
  pushUserMsg: (text: string, isRenderedPrompt?: boolean) => void
}

interface PendingAttachmentLike {
  localId: string
  mime: string
  filename: string
  base64DataUrl: string
  status: 'reading' | 'ready' | 'error'
}

export function useSubmitPrompt(): UseSubmitPromptResult {
  const pushUserMsg = useCallback(
    (text: string, isRenderedPrompt = false) => {
      useAgentStore.setState((s) => ({
        status: 'streaming' as const,
        messages: [
          ...s.messages,
          {
            eventId: `user-${Date.now()}-${isRenderedPrompt ? 'r' : 'o'}`,
            sessionId: '',
            ts: Date.now(),
            turnIndex: 0,
            type: 'user.text',
            text,
            isRenderedPrompt,
            attachments: [],
          } as AgentMessage,
        ],
        sendSeq: s.sendSeq + 1,
      }))
    },
    [],
  )

  const submitPrompt = useCallback(
    async (text: string, opts?: { skipPushUserMsg?: boolean }) => {
      if (!opts?.skipPushUserMsg) {
        pushUserMsg(text)
      }
      const s = useAgentStore.getState()
      const sid = s.sessionId || s.activeSessionId || undefined
      const { sessionId: returnedSessionId } = await api.post<{ sessionId: string }>(
        '/agent/prompt',
        {
          prompt: text || undefined,
          sessionId: sid,
        },
        {
          headers: sid ? { 'X-Session-Id': sid } : undefined,
        },
      )
      useAgentStore.setState({
        sessionId: returnedSessionId,
        activeSessionId: returnedSessionId,
      })
      const localTitle = deriveLocalTitle(text)
      if (localTitle) {
        useAgentStore.getState().applySessionEvent({
          type: 'session.renamed',
          sessionId: returnedSessionId,
          title: localTitle,
          eventId: `session-renamed-${returnedSessionId}`,
          ts: Date.now(),
        })
      }
    },
    [pushUserMsg],
  )

  return { submitPrompt, pushUserMsg }
}

// 保留 export 给测试/调试使用 — 类型与 AgentInputBox.PendingAttachment 对齐。
export type { PendingAttachmentLike }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test -- --run src/web/src/hooks/useSubmitPrompt.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查 + lint**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/hooks/useSubmitPrompt.ts \
        packages/zai/src/web/src/hooks/useSubmitPrompt.test.ts
git commit -m "feat(web): 抽 useSubmitPrompt hook (复用 AgentInputBox 提交路径)"
```

---

## Task 4: `MobileQuickDrawer` 组件 + 测试

**Files:**
- Create: `packages/zai/src/web/src/components/MobileQuickDrawer.tsx`
- Create: `packages/zai/src/web/src/components/MobileQuickDrawer.test.tsx`

**Interfaces:**
- Consumes:
  - `useQuickPrompts()` from `../hooks/useQuickPrompts.js`
  - `useSubmitPrompt()` from `../hooks/useSubmitPrompt.js`
  - `useBashRepl(sessionId, defaultCwd)` from `../hooks/useBashRepl.js` (取 `topCommands`,不订阅 SSE)
  - `useAgentStore` for `sessionId` / `activeSessionId` / `status`
  - `useAppStore` for `cwdBySession[sessionId]` (实际 AgentInputBox 已通过 props 拿,但 Drawer 直接从 store 读)
- Produces: 受控 Drawer 组件,props `{ open: boolean; onClose: () => void }`

- [ ] **Step 1: 写失败测试**

新建 `packages/zai/src/web/src/components/MobileQuickDrawer.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execReplMock = vi.fn(async () => ({ ok: true as const, execId: 'e1' }))
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
    refreshTopCommands: vi.fn(),
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

import MobileQuickDrawer from './MobileQuickDrawer.jsx'
import { useAgentStore } from '../store/useAgentStore.js'

beforeEach(() => {
  execReplMock.mockClear()
  submitPromptMock.mockClear()
  pushUserMsgMock.mockClear()
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

describe('MobileQuickDrawer — 打开/关闭', () => {
  it('open=true 时渲染 Drawer,展示「快捷 Bash」与「常用指令」两个 Segmented 项', () => {
    render(<MobileQuickDrawer open onClose={() => {}} />)
    expect(screen.getByText('常用指令')).toBeInTheDocument()
    // 默认 Tab 是 bash,显示 topCommands
    expect(screen.getByText('ls -la')).toBeInTheDocument()
    expect(screen.getByText('pwd')).toBeInTheDocument()
  })

  it('open=false 时不渲染列表项', () => {
    render(<MobileQuickDrawer open={false} onClose={() => {}} />)
    expect(screen.queryByText('ls -la')).toBeNull()
  })
})

describe('MobileQuickDrawer — Bash tab', () => {
  it('点击 row 调 execRepl + 触发 onClose', async () => {
    const onClose = vi.fn()
    render(<MobileQuickDrawer open onClose={onClose} />)
    fireEvent.click(screen.getByText('ls -la'))
    await waitFor(() => expect(execReplMock).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ command: 'ls -la' }),
    ))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('sessionId 缺失时列表项渲染为禁用提示', () => {
    useAgentStore.setState({ sessionId: null, activeSessionId: null })
    render(<MobileQuickDrawer open onClose={() => {}} />)
    expect(screen.getByText(/请先开启会话/)).toBeInTheDocument()
    expect(screen.queryByText('ls -la')).toBeNull()
  })
})

describe('MobileQuickDrawer — Prompt tab', () => {
  it('切到 prompt tab 渲染预填示例', () => {
    render(<MobileQuickDrawer open onClose={() => {}} />)
    // 假设 Segmented 第二项 label 是「常用指令」, 这里直接点击该 label 触发切换
    const segments = screen.getAllByText('常用指令')
    fireEvent.click(segments[0]!)
    expect(screen.getByText('优化这段代码的可读性与性能')).toBeInTheDocument()
    expect(screen.getByText('为这段函数补上单元测试')).toBeInTheDocument()
    expect(screen.getByText('解释这个错误的根因,并给出修复建议')).toBeInTheDocument()
  })

  it('点击 prompt row 调 submitPrompt + onClose', async () => {
    const onClose = vi.fn()
    render(<MobileQuickDrawer open onClose={onClose} />)
    fireEvent.click(screen.getAllByText('常用指令')[0]!) // 切到 prompt tab
    fireEvent.click(screen.getByText('为这段函数补上单元测试'))
    await waitFor(() => expect(submitPromptMock).toHaveBeenCalledWith(
      '为这段函数补上单元测试',
      undefined,
    ))
    expect(pushUserMsgMock).not.toHaveBeenCalled() // submitPrompt 内部已处理
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test -- --run src/web/src/components/MobileQuickDrawer.test.tsx`
Expected: FAIL — `Cannot find module './MobileQuickDrawer.jsx'` 或 React 组件未挂载

- [ ] **Step 3: 实现组件**

新建 `packages/zai/src/web/src/components/MobileQuickDrawer.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { Drawer, Segmented, Button, Input, App as AntApp } from 'antd'
import {
  ReloadOutlined,
  PlusOutlined,
  DeleteOutlined,
  ClearOutlined,
} from '@ant-design/icons'
import { useAgentStore } from '../store/useAgentStore.js'
import { useAppStore } from '../store/useAppStore.js'
import { useQuickPrompts, MAX_TEXT } from '../hooks/useQuickPrompts.js'
import { useSubmitPrompt } from '../hooks/useSubmitPrompt.js'
import { useBashRepl } from '../hooks/useBashRepl.js'
import { execRepl } from '../lib/bashReplApi.js'
import { message } from 'antd'

type TabKey = 'bash' | 'prompt'

export interface MobileQuickDrawerProps {
  open: boolean
  onClose: () => void
}

export default function MobileQuickDrawer({ open, onClose }: MobileQuickDrawerProps) {
  const sessionId = useAgentStore((s) => s.sessionId)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const status = useAgentStore((s) => s.status)
  const cwd = useAppStore((s) =>
    sessionId ? s.cwdBySession[sessionId] ?? null : null,
  )
  const { topCommands, refreshTopCommands, exec } = useBashRepl(
    sessionId ?? activeSessionId ?? null,
    cwd,
  )
  const { prompts, add, remove, clear } = useQuickPrompts()
  const { submitPrompt } = useSubmitPrompt()
  const [tab, setTab] = useState<TabKey>('bash')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const effectiveSid = sessionId ?? activeSessionId

  async function handleBashClick(command: string) {
    if (!effectiveSid) return
    try {
      const result = await exec(command)
      if (result.ok) {
        message.success(`已执行: ${command}`)
      } else if ('busy' in result && result.busy) {
        message.warning('已有命令在执行')
      }
    } catch (err) {
      message.error(`执行失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      onClose()
    }
  }

  async function handlePromptClick(text: string) {
    if (status === 'streaming') {
      message.warning('请等待当前回复结束')
      return
    }
    try {
      await submitPrompt(text)
    } catch (err) {
      message.error(`提交失败: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    onClose()
  }

  function handleSaveDraft() {
    const trimmed = draft.trim()
    if (!trimmed) {
      message.warning('内容不能为空')
      return
    }
    const added = add(trimmed)
    if (!added) {
      if (trimmed.length > MAX_TEXT) message.warning(`最多 ${MAX_TEXT} 字`)
      else message.warning('已存在相同内容')
      return
    }
    setDraft('')
    setAdding(false)
    message.success('已保存为常用指令')
  }

  return (
    <Drawer
      title="常用指令"
      placement="right"
      width="85%"
      open={open}
      onClose={onClose}
      maskClosable
      styles={{ body: { padding: 12 } }}
      data-testid="mobile-quick-drawer"
      extra={
        <Button
          type="text"
          size="small"
          onClick={onClose}
          aria-label="关闭"
        >
          ✕
        </Button>
      }
    >
      <div style={{ marginBottom: 12 }}>
        <Segmented<'bash' | 'prompt'>
          block
          value={tab}
          onChange={(v) => setTab(v as TabKey)}
          options={[
            { label: '快捷 Bash', value: 'bash' },
            { label: '常用指令', value: 'prompt' },
          ]}
        />
      </div>

      {tab === 'bash' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => void refreshTopCommands()}
              data-testid="mobile-quick-drawer-bash-refresh"
            >
              刷新
            </Button>
          </div>
          {!effectiveSid && (
            <div style={{ color: 'rgba(255,255,255,0.45)', padding: 16 }}>
              请先开启会话
            </div>
          )}
          {effectiveSid && topCommands.length === 0 && (
            <div style={{ color: 'rgba(255,255,255,0.45)', padding: 16 }}>
              暂无历史命令
            </div>
          )}
          {effectiveSid && topCommands.map((entry) => (
            <div
              key={entry.command}
              role="button"
              tabIndex={0}
              onClick={() => void handleBashClick(entry.command)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void handleBashClick(entry.command)
                }
              }}
              data-testid={`mobile-quick-drawer-bash-row-${entry.command}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 12px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                cursor: 'pointer',
                fontFamily: 'ui-monospace, Menlo, monospace',
                fontSize: 13,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.command}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, flexShrink: 0 }}>
                ×{entry.count}
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === 'prompt' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setAdding((v) => !v)}
              data-testid="mobile-quick-drawer-prompt-add"
            >
              新增
            </Button>
          </div>
          {adding && (
            <div style={{ marginBottom: 12 }}>
              <AntApp>
                <Input.TextArea
                  rows={3}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={`输入常用指令 (${MAX_TEXT} 字以内)`}
                  maxLength={MAX_TEXT}
                  data-testid="mobile-quick-drawer-prompt-input"
                />
              </AntApp>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button
                  type="primary"
                  size="small"
                  onClick={handleSaveDraft}
                  data-testid="mobile-quick-drawer-prompt-save"
                >
                  保存
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    setAdding(false)
                    setDraft('')
                  }}
                >
                  取消
                </Button>
              </div>
            </div>
          )}
          {!effectiveSid && (
            <div style={{ color: 'rgba(255,255,255,0.45)', padding: 16 }}>
              无会话
            </div>
          )}
          {effectiveSid && prompts.length === 0 && (
            <div style={{ color: 'rgba(255,255,255,0.45)', padding: 16 }}>
              暂无常用指令,点「+ 新增」添加
            </div>
          )}
          {effectiveSid && prompts.map((p) => (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              onClick={() => void handlePromptClick(p.text)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void handlePromptClick(p.text)
                }
              }}
              data-testid={`mobile-quick-drawer-prompt-row-${p.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                cursor: 'pointer',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.text}
              </span>
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={(e) => {
                  e.stopPropagation()
                  remove(p.id)
                }}
                aria-label="删除"
              />
            </div>
          ))}
          {effectiveSid && prompts.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Button
                danger
                type="text"
                size="small"
                icon={<ClearOutlined />}
                onClick={clear}
                data-testid="mobile-quick-drawer-prompt-clear"
              >
                清空全部
              </Button>
            </div>
          )}
        </div>
      )}
    </Drawer>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test -- --run src/web/src/components/MobileQuickDrawer.test.tsx`
Expected: PASS(全部用例)

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/MobileQuickDrawer.tsx \
        packages/zai/src/web/src/components/MobileQuickDrawer.test.tsx
git commit -m "feat(web): 新增 MobileQuickDrawer (Bash top10 + 自定义片段两 Tab)"
```

---

## Task 5: AgentInputBox 接入 useSubmitPrompt + 移动端 [⚡] 按钮

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx`
- Modify: `packages/zai/src/web/src/components/AgentInputBox.test.tsx`

**Interfaces:**
- Consumes:
  - `useSubmitPrompt()` from `../hooks/useSubmitPrompt.js` — 替换内联 `postPromptToLLM` + `pushUserMsg`
  - `useAppStore.isMobile` — 条件渲染 [⚡] 按钮
- Produces:
  - 状态栏左端渲染 `data-testid="mobile-quick-drawer-toggle"` 按钮(仅 `isMobile`)
  - `useAppStore.getState().setQuickDrawerOpen(true)` 触发抽屉打开

- [ ] **Step 1: 写失败测试**

打开 `packages/zai/src/web/src/components/AgentInputBox.test.tsx`,在文件末尾追加:

```tsx
describe('AgentInputBox — 移动端 [⚡] 按钮', () => {
  it('isMobile=true 时渲染 mobile-quick-drawer-toggle,点击触发 setQuickDrawerOpen(true)', () => {
    useAppStore.setState({ isMobile: true, quickDrawerOpen: false })
    render(<AgentInputBox />)
    const btn = screen.getByTestId('mobile-quick-drawer-toggle')
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(useAppStore.getState().quickDrawerOpen).toBe(true)
  })

  it('isMobile=false 时不渲染该按钮', () => {
    useAppStore.setState({ isMobile: false })
    render(<AgentInputBox />)
    expect(screen.queryByTestId('mobile-quick-drawer-toggle')).toBeNull()
  })
})
```

> 注意: 这一步依赖 Task 6 Step 2 在 `useAppStore` 注入 `setQuickDrawerOpen`,所以测试编译会先报错 — 属预期失败。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test -- --run src/web/src/components/AgentInputBox.test.tsx`
Expected: FAIL — `data-testid="mobile-quick-drawer-toggle"` 找不到,或 `useAppStore` 没有 `setQuickDrawerOpen` 类型

- [ ] **Step 3: 改 AgentInputBox**

打开 `packages/zai/src/web/src/components/AgentInputBox.tsx`:

3a) **顶部 imports** — 新增:

```tsx
import { AppstoreAddOutlined } from '@ant-design/icons'
import { useSubmitPrompt } from '../hooks/useSubmitPrompt.js'
```

3b) **删除内联 `postPromptToLLM` + `pushUserMsg`**(`AgentInputBox.tsx:466-534`),替换为:

```tsx
  const { submitPrompt, pushUserMsg } = useSubmitPrompt()
```

3c) **`handleSend` 中替换 `await postPromptToLLM(...)`**(`AgentInputBox.tsx:626` 附近)。由于 `submitPrompt` 不接收 `contentBlocks`(图片附件),把含附件路径与不含附件路径分流:

```tsx
  const handleSend = async () => {
    const text = input.trim()
    const readyAttachments = attachments.filter((a) => a.status === 'ready')
    const blocks = readyAttachments.map((a) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: a.mime,
        data: a.base64DataUrl.replace(/^data:[^;]+;base64,/, ''),
      },
    }))
    if (text.startsWith('/')) {
      setInput('')
      const sp = text.indexOf(' ')
      const name = sp === -1 ? text.slice(1) : text.slice(1, sp)
      const args = sp === -1 ? '' : text.slice(sp + 1)
      const sid = sessionId || activeSessionId || undefined
      try {
        const result = await api.post<{ type: string; payload: any }>(
          '/agent/command',
          { name, args, ...(sid ? { sessionId: sid } : {}) },
        )
        switch (result.type) {
          case 'cleared':
            useAgentStore.getState().clearMessages()
            message.success('对话已清空')
            return
          case 'compacted':
            message.success(
              `压缩完成,移除 ${result.payload.removedMessages} 条`,
            )
            await useAgentStore.getState().loadSessions()
            return
          case 'status':
            message.info(
              `cwd: ${result.payload.cwd}\nmodel: ${result.payload.model}\nsession: ${result.payload.sessionId ?? "-"}`,
              5,
            )
            return
          case 'prompt':
            pushUserMsg(text, false)
            if (result.payload?.rendered) {
              pushUserMsg(result.payload.rendered, true)
            }
            await submitPrompt(result.payload?.rendered ?? text)
            return
          case 'message':
            message.info(result.payload.text, 3)
            return
          case 'unknown':
            pushUserMsg(text, false)
            await submitPrompt(text)
            return
          case 'error':
            message.error(result.payload.message)
            return
        }
      } catch (err) {
        message.error(`命令执行失败: ${(err as Error).message}`)
        return
      }
    }
    if (!text && blocks.length === 0) return
    if (status === 'streaming') return
    setInput('')

    pushUserMsg(text)
    attachments.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl))
    setAttachments([])

    if (blocks.length > 0) {
      // 含图片附件: 仍走原始 postPromptToLLM 内联实现 (不抽到 hook)
      const sid = sessionId || activeSessionId || undefined
      const { sessionId: returnedSessionId } = await api.post<{ sessionId: string }>(
        '/agent/prompt',
        { prompt: text || undefined, contentBlocks: blocks, sessionId: sid },
        { headers: sid ? { 'X-Session-Id': sid } : undefined },
      )
      useAgentStore.setState({
        sessionId: returnedSessionId,
        activeSessionId: returnedSessionId,
      })
      const localTitle = deriveLocalTitle(text)
      if (localTitle) {
        useAgentStore.getState().applySessionEvent({
          type: 'session.renamed',
          sessionId: returnedSessionId,
          title: localTitle,
          eventId: `session-renamed-${returnedSessionId}`,
          ts: Date.now(),
        })
      }
    } else {
      await submitPrompt(text)
    }
  }
```

3d) **新增 [⚡] 按钮** — 在 AgentInputBox.tsx return JSX 顶部 `data-testid="agent-input-status-row"` 的 `<div>` 内,找到第一个 `<span>` 渲染 ready dot 的位置,在它之前插入:

```tsx
        {isMobile && (
          <Tooltip title="常用指令" placement="top">
            <Button
              icon={<AppstoreAddOutlined />}
              onClick={() => useAppStore.getState().setQuickDrawerOpen(true)}
              data-testid="mobile-quick-drawer-toggle"
              aria-label="打开常用指令"
              style={toolbarIconButtonStyle}
            />
          </Tooltip>
        )}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test -- --run src/web/src/components/AgentInputBox.test.tsx`
Expected: PASS(全部用例,包括原 `'prompt' branch` / `'unknown' branch` 行为仍正确)

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/AgentInputBox.tsx \
        packages/zai/src/web/src/components/AgentInputBox.test.tsx
git commit -m "feat(web): AgentInputBox 接入 useSubmitPrompt + 移动端新增 [⚡] 触发按钮"
```

---

## Task 6: useAppStore 暴露 setQuickDrawerOpen + MobileAgent 挂载 Drawer

**Files:**
- Modify: `packages/zai/src/web/src/store/useAppStore.ts`
- Modify: `packages/zai/src/web/src/pages/MobileAgent.tsx`

**Interfaces:**
- Consumes: `MobileQuickDrawer` from `../components/MobileQuickDrawer.jsx`
- Produces:
  - `useAppStore.quickDrawerOpen: boolean`
  - `useAppStore.setQuickDrawerOpen: (open: boolean) => void`
  - `MobileAgent` 内挂载 `<MobileQuickDrawer open onClose />`

- [ ] **Step 1: 改 useAppStore**

打开 `packages/zai/src/web/src/store/useAppStore.ts`:

- 在 `AppState` interface 中新增:

```tsx
  quickDrawerOpen: boolean
  setQuickDrawerOpen: (open: boolean) => void
```

- 在 `create<AppState>((set) => ({ ... }))` 内部新增:

```tsx
  quickDrawerOpen: false,
  setQuickDrawerOpen: (open) => set({ quickDrawerOpen: open }),
```

- [ ] **Step 2: 改 MobileAgent**

打开 `packages/zai/src/web/src/pages/MobileAgent.tsx`:

2a) 顶部 imports 新增:

```tsx
import MobileQuickDrawer from '../components/MobileQuickDrawer.jsx'
```

2b) 在 `MobileAgent` 组件内,把原本的 `const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)` 之后新增:

```tsx
  const quickDrawerOpen = useAppStore((s) => s.quickDrawerOpen)
  const setQuickDrawerOpen = useAppStore((s) => s.setQuickDrawerOpen)
```

2c) 在 JSX `</>` 闭合前新增:

```tsx
      <MobileQuickDrawer
        open={quickDrawerOpen}
        onClose={() => setQuickDrawerOpen(false)}
      />
```

- [ ] **Step 3: 跑全量测试**

Run: `pnpm --filter @zn-ai/zai test -- --run`
Expected: PASS(所有文件,包括 BashTab / useBashRepl / AgentInputBox / MobileQuickDrawer / useQuickPrompts / useSubmitPrompt / useAgentStore 等既有测试仍通过)

- [ ] **Step 4: 类型检查**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/store/useAppStore.ts \
        packages/zai/src/web/src/pages/MobileAgent.tsx
git commit -m "feat(web): MobileAgent 挂载 MobileQuickDrawer + useAppStore 暴露 setQuickDrawerOpen"
```

---

## Task 7: 全量回归

- [ ] **Step 1: 全量单测**

Run: `pnpm --filter @zn-ai/zai test -- --run`
Expected: PASS

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: PASS

- [ ] **Step 3: 构建**

Run: `pnpm --filter @zn-ai/zai build`
Expected: PASS(Vite build + tsc -b)

- [ ] **Step 4: 手动 smoke**

1. 启动 `pnpm --filter @zn-ai/zai dev`
2. 浏览器 DevTools 切到移动 viewport (375×812)
3. 访问 http://localhost:<port>
4. 验证 [⚡] 按钮出现在状态栏最左
5. 点击 → 右侧 Drawer 弹出
6. 切到「常用指令」tab → 看到 3 条预填示例
7. 点击示例 → Drawer 关闭 + 消息出现在对话流 + AI 开始回应
8. 回到 Drawer → 「+ 新增」 → 输入新片段 → 保存 → 列表新增
9. 切到「快捷 Bash」tab → 如果 `/api/bash/history/top10` 有数据,看到命令列表;点击 → Drawer 关闭
10. 刷新页面 → Drawer 列表保留预填示例 + 之前新增的片段
11. (可选) 桌面 viewport 验证 [⚡] 按钮不出现,Drawer 也不挂载

- [ ] **Step 5: Commit(若前述步骤有改动)**

无新代码改动则跳过;若有 hotfix:

```bash
cd /Users/ethan/code/opencc-web
git add -A
git commit -m "fix(web): 移动端常用指令 Drawer 集成收尾"
```

---

## Self-Review(plan 写完后自查)

**1. Spec coverage:**

| Spec § | 覆盖 task |
|---|---|
| §2 目标 1 (一键触达) | Task 5 (按钮) + Task 4 (Drawer) + Task 6 (挂载) |
| §2 目标 2 (不破坏既有契约) | Task 3 (useSubmitPrompt 保留原 pushUserMsg/postPromptToLLM 行为)+ Task 5 Step 3c (附件逻辑保留) |
| §2 目标 3 (localStorage 持久化) | Task 2 (useQuickPrompts) |
| §2 目标 4 (UI 风格对齐) | Task 4 (AntD Drawer + Segmented + IconButton) |
| §5.4 [⚡] 按钮 | Task 5 Step 3d |
| §7 错误矩阵 | Task 4 Step 3 handleBashClick / handlePromptClick / handleSaveDraft |
| §8 测试矩阵 | Task 2/3/4/5 的 test 文件 + Task 7 全量回归 |

✅ 所有 spec 章节均有 task 覆盖。

**2. Placeholder scan:**

- 无 "TBD" / "TODO" / "类似 Task N"
- 所有改动均给出具体代码片段或精确文本替换
- ✅ 通过

**3. Type consistency:**

- `QuickPrompt` 在 Task 2 定义,Task 4 消费 — 接口对齐
- `useSubmitPrompt` 返回 `{ submitPrompt, pushUserMsg }` — Task 3 定义,Task 4/5 消费对齐
- `STORAGE_KEYS.quickPrompts` — Task 1 定义,Task 2 消费对齐
- `setQuickDrawerOpen` — Task 6 Step 1 定义,Task 5 Step 3d 与 Task 6 Step 2c 消费对齐
- ✅ 通过