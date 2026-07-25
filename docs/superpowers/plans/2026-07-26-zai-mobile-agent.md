# zai Mobile /agent 页面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 LAN 分享的 `http://<LAN-IP>:<port>/agent?sid=xxx` 链接在移动端自动进入一个只显示对话内容 + 触摸优化 + 虚拟键盘适配的移动版 `/m` 页面;PC 端行为零回归。

**Architecture:** 服务端 `redirectMobileUA` 中间件按 UA 把 `/agent` 302 重定向到 `/m`;前端新增 `/m` 路由与 `MobileAgent` 页面 + `MobileLayout`(无 Sider,挂 `useVisualViewportHeight`);`Agent.tsx` 把对话核心 JSX 抽到共享组件 `AgentConversation`,PC 与移动两套页面都引用它;`AgentInputBox` 加 `isMobile` prop 收敛分屏相关 UI。

**Tech Stack:** Express 4 (中间件)、React Router v6 (路由)、Zustand (`useAgentStore`)、AntD 5 (`Drawer` `Button`)、TypeScript、Vitest (测试)。

**Spec:** `docs/superpowers/specs/2026-07-26-zai-mobile-agent-design.md`

## Global Constraints

- 服务端只对路径 `/agent` 做重定向;`/login`、`/dashboard`、`/config` 等路径不干预
- 服务端不对 `/m` 路径做重定向(避免死循环)
- UA 白名单:`/Mobile|iPhone|iPad|iPod|Android.*Mobile|Mobile.*Safari/`
- 重定向时透传 querystring:`/agent?sid=xxx&foo=bar` → `/m?sid=xxx&foo=bar`
- 移动端跳过渲染的 UI:`<SplitPane />` 整块、AgentInputBox 内的 split-pane toggle / transcript-collapse / transcript-repair 按钮
- 虚拟键盘适配:容器高度跟随 `window.visualViewport.height`,不支持的浏览器降级 `window.innerHeight`
- TypeScript `tsc -b --noEmit` 全绿

---

## File Structure

### 新增文件

| 路径 | 职责 |
|---|---|
| `packages/zai/src/server/middleware/redirectMobileUA.ts` | UA 检测 + 302 重定向 |
| `packages/zai/src/server/test/unit/middleware/redirectMobileUA.test.ts` | UA 命中/不命中/路径过滤/querystring 透传 |
| `packages/zai/src/web/src/hooks/useVisualViewportHeight.ts` | 监听 `visualViewport.resize` 返回当前可用高度 |
| `packages/zai/src/web/src/hooks/useVisualViewportHeight.test.ts` | 单元测试(mock visualViewport) |
| `packages/zai/src/web/src/components/MobileLayout.tsx` | 替代 Layout,无 Sider,挂 visualViewport |
| `packages/zai/src/web/src/components/MobileHeader.tsx` | 顶栏(56px):Drawer 触发 + 标题 |
| `packages/zai/src/web/src/components/MobileSessionDrawer.tsx` | AntD Drawer 渲染会话列表 |
| `packages/zai/src/web/src/components/mobile.test.tsx` | MobileHeader / MobileSessionDrawer 测试 |
| `packages/zai/src/web/src/pages/AgentConversation.tsx` | 共享对话核心(从 Agent.tsx 抽出) |
| `packages/zai/src/web/src/pages/AgentConversation.test.tsx` | 共享组件测试 |
| `packages/zai/src/web/src/pages/MobileAgent.tsx` | 移动端主页面 |
| `packages/zai/src/web/src/pages/MobileAgent.test.tsx` | 装配 + 行为测试 |

### 修改文件

| 路径 | 改动 |
|---|---|
| `packages/zai/src/server/index.ts` | createApp 末尾挂 `app.use('/agent', redirectMobileUA)` |
| `packages/zai/src/web/src/router.tsx` | 拆出两层父路由,新增 `/m` 子路由走 `<MobileLayout>` |
| `packages/zai/src/web/src/pages/Agent.tsx` | 把对话核心 JSX 替换为 `<AgentConversation>` |
| `packages/zai/src/web/src/components/AgentInputBox.tsx` | 新增 `isMobile?: boolean` prop,3 个按钮加 `&& !isMobile` |

---

### Task 1: 服务端 redirectMobileUA 中间件

**Files:**
- Create: `packages/zai/src/server/middleware/redirectMobileUA.ts`
- Test: `packages/zai/src/server/test/unit/middleware/redirectMobileUA.test.ts`

**Interfaces:**
- Produces: `export function redirectMobileUA(req: Request, res: Response, next: NextFunction): void` + `export function matchesMobileUA(ua: string | undefined): boolean`

- [ ] **Step 1: 写失败测试**

创建 `packages/zai/src/server/test/unit/middleware/redirectMobileUA.test.ts`:

```ts
import { describe, test, expect, vi } from 'vitest'
import type { Request, Response } from 'express'
import { redirectMobileUA, matchesMobileUA } from '../../../../middleware/redirectMobileUA.js'

function mkReq(path: string, ua: string | undefined): Request {
  return { path, url: path, headers: ua ? { 'user-agent': ua } : {} } as unknown as Request
}
function mkRes(): Response {
  const res: any = {
    statusCode: 200,
    headers: {},
    setHeader(k: string, v: string) { this.headers[k] = v },
    getHeader(k: string) { return this.headers[k] },
    status(c: number) { this.statusCode = c; return this },
    redirect(c: number, loc: string) { this.statusCode = c; this.headers.location = loc; return this },
  }
  return res as Response
}

describe('matchesMobileUA', () => {
  test.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', true],
    ['Mozilla/5.0 (Linux; Android 13; Pixel 7)', true],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', true],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', false],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', false],
    ['', false],
    [undefined, false],
  ])('UA=%s -> %s', (ua, expected) => {
    expect(matchesMobileUA(ua)).toBe(expected)
  })
})

describe('redirectMobileUA', () => {
  test('redirects /agent?sid=abc to /m?sid=abc (querystring preserved)', () => {
    const req = mkReq('/agent', 'Mozilla/5.0 (iPhone)')
    req.url = '/agent?sid=abc&foo=bar'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/m?sid=abc&foo=bar')
    expect(next).not.toHaveBeenCalled()
  })

  test('does NOT redirect /login', () => {
    const req = mkReq('/login', 'Mozilla/5.0 (iPhone)')
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(res.statusCode).toBe(200)
    expect(next).toHaveBeenCalledOnce()
  })

  test('does NOT redirect /dashboard', () => {
    const req = mkReq('/dashboard', 'Mozilla/5.0 (iPhone)')
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  test('does NOT redirect /m (loop guard)', () => {
    const req = mkReq('/m', 'Mozilla/5.0 (iPhone)')
    req.url = '/m?sid=abc'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.headers.location).toBeUndefined()
  })

  test('does NOT redirect /agent when UA is desktop', () => {
    const req = mkReq('/agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    req.url = '/agent'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.headers.location).toBeUndefined()
  })

  test('does NOT redirect /agent when UA is undefined', () => {
    const req = mkReq('/agent', undefined)
    req.url = '/agent'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/zai && pnpm test src/server/test/unit/middleware/redirectMobileUA.test.ts
```

Expected: FAIL — "Cannot find module"

- [ ] **Step 3: 实现中间件**

创建 `packages/zai/src/server/middleware/redirectMobileUA.ts`:

```ts
import type { Request, Response, NextFunction } from 'express'

/**
 * UA 白名单 — 最小集覆盖 iPhone / iPad / iPod / Android 移动 / 通用 Mobile。
 * 不包含 'Macintosh' — iPadOS 13+ 桌面伪装 UA 走桌面端,在前端 MobileAgent
 * 横幅处兜底(见 spec §3.3)。
 */
const MOBILE_UA_RE = /Mobile|iPhone|iPad|iPod|Android.*Mobile|Mobile.*Safari/

export function matchesMobileUA(ua: string | undefined): boolean {
  if (!ua) return false
  return MOBILE_UA_RE.test(ua)
}

/**
 * 把 /agent 重定向到 /m,保留 querystring。
 * 只对 /agent 路径生效;其它路径(/login /dashboard /m /api/...)直接 next()。
 * 不对 /m 重定向 — 避免 /m -> /m 死循环。
 */
export function redirectMobileUA(req: Request, res: Response, next: NextFunction): void {
  if (req.path !== '/agent') {
    next()
    return
  }
  const ua = req.headers['user-agent']
  if (!matchesMobileUA(typeof ua === 'string' ? ua : undefined)) {
    next()
    return
  }
  // req.url 形如 '/agent?sid=xxx&foo=bar',strip 前缀 -> '?sid=xxx&foo=bar'
  const suffix = req.url.replace(/^\/agent/, '')
  res.redirect(302, '/m' + suffix)
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd packages/zai && pnpm test src/server/test/unit/middleware/redirectMobileUA.test.ts
```

Expected: 13 个测试 PASS(7 matchesMobileUA + 6 redirectMobileUA)

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/middleware/redirectMobileUA.ts packages/zai/src/server/test/unit/middleware/redirectMobileUA.test.ts
git commit -m "feat(zai-server): add redirectMobileUA middleware for /agent -> /m 302"
```

---

### Task 2: 挂 redirectMobileUA 到 Express app

**Files:**
- Modify: `packages/zai/src/server/index.ts`(顶部 import + createApp 内末尾)

**Interfaces:**
- Consumes: `redirectMobileUA` from Task 1

- [ ] **Step 1: 在 createApp() 中挂中间件**

在 `packages/zai/src/server/index.ts` 顶部 import 区域(`noCacheForApi` import 之后)加:

```ts
import { redirectMobileUA } from './middleware/redirectMobileUA.js';
```

把 `startBranchChecker(opts.cwd);` 这一行(在 `return app;` 之前)替换为:

```ts
  // 移动端 UA 检测: 命中手机/平板 UA 时把 /agent 302 到 /m,
  // 让分享到 LAN 的链接在移动设备上自动进入移动版对话页面。
  // 路径仅匹配 /agent — /api/* /login /dashboard 等路径不被干预。
  app.use('/agent', redirectMobileUA);

  // 启动分支检查器（每 10 秒检测一次 git 分支变化）
  startBranchChecker(opts.cwd);

  return app;
}
```

- [ ] **Step 2: typecheck**

```bash
cd packages/zai && pnpm typecheck
```

Expected: 无报错

- [ ] **Step 3: 跑现有所有测试**

```bash
cd packages/zai && pnpm test
```

Expected: 全部 PASS(redirectMobileUA + 既有所有测试)

- [ ] **Step 4: 提交**

```bash
git add packages/zai/src/server/index.ts
git commit -m "feat(zai-server): mount redirectMobileUA on /agent path"
```

---

### Task 3: useVisualViewportHeight hook

**Files:**
- Create: `packages/zai/src/web/src/hooks/useVisualViewportHeight.ts`
- Create: `packages/zai/src/web/src/hooks/useVisualViewportHeight.test.ts`

**Interfaces:**
- Produces: `export function useVisualViewportHeight(): number`

**前置依赖**:确认 `@testing-library/react` 在 devDependencies 中。若未装,在 `packages/zai/package.json` 加 `"@testing-library/react": "^14.0.0"` 到 devDependencies 并 `pnpm install`。

- [ ] **Step 1: 写失败测试**

创建 `packages/zai/src/web/src/hooks/useVisualViewportHeight.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVisualViewportHeight } from './useVisualViewportHeight'

describe('useVisualViewportHeight', () => {
  let listeners: Function[]

  beforeEach(() => {
    listeners = []
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 800,
        addEventListener: (ev: string, cb: Function) => { if (ev === 'resize') listeners.push(cb) },
        removeEventListener: (ev: string, cb: Function) => {
          if (ev === 'resize') listeners = listeners.filter((f) => f !== cb)
        },
      },
    })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
  })

  afterEach(() => {
    delete (window as any).visualViewport
  })

  test('returns visualViewport.height on mount', () => {
    const { result } = renderHook(() => useVisualViewportHeight())
    expect(result.current).toBe(800)
  })

  test('updates on visualViewport resize event', () => {
    const { result } = renderHook(() => useVisualViewportHeight())
    expect(result.current).toBe(800)
    act(() => {
      ;(window as any).visualViewport.height = 500
      listeners.forEach((cb) => cb())
    })
    expect(result.current).toBe(500)
  })

  test('falls back to window.innerHeight when visualViewport is absent', () => {
    delete (window as any).visualViewport
    const { result } = renderHook(() => useVisualViewportHeight())
    expect(result.current).toBe(900)
  })

  test('removes listener on unmount', () => {
    const { unmount } = renderHook(() => useVisualViewportHeight())
    expect(listeners.length).toBe(1)
    unmount()
    expect(listeners.length).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/zai && pnpm test src/web/src/hooks/useVisualViewportHeight.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: 实现 hook**

创建 `packages/zai/src/web/src/hooks/useVisualViewportHeight.ts`:

```ts
import { useEffect, useState } from 'react'

/**
 * 监听 window.visualViewport.resize,返回当前可视区域高度(px)。
 * 移动端虚拟键盘弹出/收起时,容器高度跟随 visualViewport.height 调整,
 * 避免 TextArea 被键盘遮挡。
 * SSR / 老浏览器(无 visualViewport)降级到 window.innerHeight。
 */
export function useVisualViewportHeight(): number {
  const [h, setH] = useState<number>(() => {
    if (typeof window === 'undefined') return 0
    return window.visualViewport?.height ?? window.innerHeight
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setH(vv.height)
    vv.addEventListener('resize', update)
    update()
    return () => vv.removeEventListener('resize', update)
  }, [])

  return h
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd packages/zai && pnpm test src/web/src/hooks/useVisualViewportHeight.test.ts
```

Expected: 4 个测试 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/hooks/useVisualViewportHeight.ts packages/zai/src/web/src/hooks/useVisualViewportHeight.test.ts
git commit -m "feat(zai-web): add useVisualViewportHeight hook for mobile keyboard adaptation"
```

---

### Task 4: MobileLayout 组件

**Files:**
- Create: `packages/zai/src/web/src/components/MobileLayout.tsx`

**Interfaces:**
- Consumes: `useVisualViewportHeight` from Task 3, `useAppStore.setInstanceContext` / `setOutputStyle` / `setMaxVisibleMessages` / `setTranscriptCollapsed`, `api.get('/system')` / `api.get('/agent/settings')`

- [ ] **Step 1: 实现 MobileLayout**

创建 `packages/zai/src/web/src/components/MobileLayout.tsx`:

```tsx
import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { useVisualViewportHeight } from '../hooks/useVisualViewportHeight'
import { useAppStore } from '../store/useAppStore'
import { useAgentStore } from '../store/useAgentStore'
import { api } from '../lib/api'

/**
 * 移动端顶层布局 — 没有 Sider / 顶栏 / 任何桌面 chrome。
 * 高度跟随 window.visualViewport.height,键盘弹出/收起时容器自动收缩。
 * paddingBottom 用 env(safe-area-inset-bottom) 适配 iPhone X+ 底部 home indicator。
 *
 * 这里仍负责 1) 拉 /system 写 cwdName 到 useAppStore.instanceContext 与
 * document.title;2) hydrate outputStyle / maxVisibleMessages — 与 Layout.tsx
 * 同样的 boot 步骤,确保移动端 store 一致。
 */
export default function MobileLayout() {
  const vvHeight = useVisualViewportHeight()
  const setInstanceContext = useAppStore((s) => s.setInstanceContext)
  const setOutputStyle = useAppStore((s) => s.setOutputStyle)
  const setMaxVisibleMessages = useAppStore((s) => s.setMaxVisibleMessages)
  const setTranscriptCollapsed = useAgentStore((s) => s.setTranscriptCollapsed)

  useEffect(() => {
    api
      .get<{ ok: boolean; cwd: string; cwdName: string }>('/system')
      .then((data) => {
        setInstanceContext({
          cwd: data.cwd,
          cwdName: data.cwdName,
          branch: null,
          host: '',
          port: 0,
          ips: [],
        })
        document.title = `${data.cwdName}-Z.AI`
      })
      .catch(() => {
        document.title = 'opencc-web-Z.AI'
      })
  }, [setInstanceContext])

  useEffect(() => {
    let cancelled = false
    api
      .get<{ outputStyle?: 'default' | 'compact' | 'verbose'; maxVisibleMessages?: number }>(
        '/agent/settings',
      )
      .then((data) => {
        if (cancelled) return
        if (
          data.outputStyle === 'default' ||
          data.outputStyle === 'compact' ||
          data.outputStyle === 'verbose'
        ) {
          setOutputStyle(data.outputStyle)
          setTranscriptCollapsed(data.outputStyle === 'compact')
        }
        if (typeof data.maxVisibleMessages === 'number') {
          setMaxVisibleMessages(Math.max(1, Math.min(1000, Math.floor(data.maxVisibleMessages))))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [setOutputStyle, setMaxVisibleMessages, setTranscriptCollapsed])

  return (
    <div
      style={{
        height: vvHeight || '100vh',
        paddingBottom: 'env(safe-area-inset-bottom)',
        display: 'flex',
        flexDirection: 'column',
        background: '#0a0a0f',
        color: '#f1f5f9',
        overflow: 'hidden',
      }}
    >
      <Outlet />
    </div>
  )
}

```

- [ ] **Step 2: typecheck**

```bash
cd packages/zai && pnpm typecheck
```

Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add packages/zai/src/web/src/components/MobileLayout.tsx
git commit -m "feat(zai-web): add MobileLayout (no sider, virtualViewport-sized)"
```

---

### Task 5: 抽 AgentConversation 共享组件

**Files:**
- Create: `packages/zai/src/web/src/pages/AgentConversation.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`
- Create: `packages/zai/src/web/src/pages/AgentConversation.test.tsx`

**Interfaces:**
- Produces: `interface AgentConversationProps { isMobile?: boolean }`, `export default function AgentConversation(props): JSX.Element`

- [ ] **Step 1: 写失败测试**

创建 `packages/zai/src/web/src/pages/AgentConversation.test.tsx`:

```tsx
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import AgentConversation from './AgentConversation'
import { useAgentStore } from '../store/useAgentStore'

vi.mock('../components/transcript/MessageListView', () => ({
  MessageListView: ({ messages }: any) => <div data-testid="mlv">{messages.length}</div>,
}))
vi.mock('../components/TodoZone', () => ({ default: () => <div data-testid="todo" /> }))
vi.mock('../components/QuestionCard', () => ({ default: () => <div data-testid="qc" /> }))
vi.mock('../components/AgentInputBox', () => ({
  default: ({ isMobile }: { isMobile?: boolean }) => (
    <div data-testid="aib" data-mobile={String(!!isMobile)} />
  ),
}))

beforeEach(() => {
  useAgentStore.setState({
    messages: [],
    pendingAsk: null,
    sessionId: 'sess-1',
    activeSessionId: 'sess-1',
    todosBySession: {},
    status: 'idle',
    sessions: [],
    cwdBySession: {},
  } as any)
})

describe('AgentConversation', () => {
  test('renders messages count via MessageListView', () => {
    useAgentStore.setState({
      messages: [
        { type: 'user.text', eventId: '1', sessionId: 's', ts: 0, turnIndex: 0, text: 'hi' } as any,
      ],
    })
    render(<AgentConversation />)
    expect(screen.getByTestId('mlv')).toHaveTextContent('1')
  })

  test('renders AgentInputBox with isMobile=false by default', () => {
    render(<AgentConversation />)
    expect(screen.getByTestId('aib').getAttribute('data-mobile')).toBe('false')
  })

  test('renders AgentInputBox with isMobile=true when prop set', () => {
    render(<AgentConversation isMobile />)
    expect(screen.getByTestId('aib').getAttribute('data-mobile')).toBe('true')
  })

  test('renders QuestionCard when pendingAsk is set', () => {
    useAgentStore.setState({
      pendingAsk: {
        toolUseId: 't1',
        sessionId: 's',
        questions: [{ question: 'q', header: 'h', options: [] }],
        answers: [],
        annotations: {},
        status: 'pending',
      },
    } as any)
    render(<AgentConversation />)
    expect(screen.getByTestId('qc')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/zai && pnpm test src/web/src/pages/AgentConversation.test.tsx
```

Expected: FAIL — module not found

- [ ] **Step 3: 创建 AgentConversation**

创建 `packages/zai/src/web/src/pages/AgentConversation.tsx`:

```tsx
import { useState, useRef, useEffect, useMemo } from 'react'
import { Typography, Button, theme } from 'antd'
import { RobotFilled, UpOutlined } from '@ant-design/icons'
import {
  useAgentStore,
  type TodoItem,
} from '../store/useAgentStore'
import { useAppStore } from '../store/useAppStore'
import QuestionCard from '../components/QuestionCard.jsx'
import { TodoZone } from '../components/TodoZone.jsx'
import AgentInputBox from '../components/AgentInputBox'
import { MessageListView } from '../components/transcript/MessageListView.js'
import { useAutoScrollToBottom } from '../hooks/useAutoScrollToBottom'

const { Paragraph } = Typography

export interface AgentConversationProps {
  /** 移动端下 AgentInputBox 隐藏 split-pane toggle / transcript-collapse / transcript-repair 按钮 */
  isMobile?: boolean
}

export default function AgentConversation({ isMobile = false }: AgentConversationProps) {
  const messages = useAgentStore((s) => s.messages)
  const maxVisibleMessages = useAppStore((s) => s.maxVisibleMessages)
  const outputStyle = useAppStore((s) => s.outputStyle)
  const [showAllMessages, setShowAllMessages] = useState(false)

  const { hiddenCount, visibleMessages } = useMemo(() => {
    const hc = Math.max(0, messages.length - maxVisibleMessages)
    if (showAllMessages) return { hiddenCount: 0, visibleMessages: messages }
    if (hc === 0) return { hiddenCount: 0, visibleMessages: messages }
    if (outputStyle === 'compact') {
      let lastAssistantIdx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if ((messages[i] as { type?: string }).type === 'assistant.text') {
          lastAssistantIdx = i
          break
        }
      }
      if (lastAssistantIdx >= 0 && lastAssistantIdx < hc) {
        return { hiddenCount: lastAssistantIdx, visibleMessages: messages.slice(lastAssistantIdx) }
      }
    }
    return { hiddenCount: hc, visibleMessages: messages.slice(hc) }
  }, [messages, maxVisibleMessages, showAllMessages, outputStyle])

  const hiddenCountAtExpandRef = useRef(hiddenCount)
  useEffect(() => {
    if (!showAllMessages) {
      hiddenCountAtExpandRef.current = hiddenCount
      return
    }
    if (hiddenCount > hiddenCountAtExpandRef.current) {
      setShowAllMessages(false)
    }
  }, [showAllMessages, hiddenCount])
  const showPill = hiddenCount > 0 && !showAllMessages

  const status = useAgentStore((s) => s.status)
  const sessionId = useAgentStore((s) => s.sessionId)
  const pendingAsk = useAgentStore((s) => s.pendingAsk)
  const setAskAnswer = useAgentStore((s) => s.setAskAnswer)
  const setAskNotes = useAgentStore((s) => s.setAskNotes)
  const setAskOtherText = useAgentStore((s) => s.setAskOtherText)
  const submitAsk = useAgentStore((s) => s.submitAsk)
  const rejectAsk = useAgentStore((s) => s.rejectAsk)

  const todosBySession = useAgentStore((s) => s.todosBySession)
  const todosForCurrentSession: TodoItem[] =
    sessionId != null ? (todosBySession[sessionId] ?? []) : []

  const stop = useAgentStore((s) => s.stop)
  const questionCardRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const autoScroll = useAutoScrollToBottom(scrollContainerRef)

  useEffect(() => {
    if (pendingAsk) {
      questionCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
      return
    }
    autoScroll.scrollToBottom(messages.length)
  }, [messages, pendingAsk, autoScroll])

  useEffect(() => {
    if (status !== 'streaming') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void stop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [status, stop])

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        maxWidth: '100%',
        overflowX: 'hidden',
      }}
    >
      <div
        ref={scrollContainerRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '0 8px',
          marginBottom: 16,
          background: '#000000',
          maxWidth: '100%',
          overflowX: 'hidden',
        }}
      >
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', marginTop: 80, color: '#999' }}>
            <RobotFilled style={{ fontSize: 48, marginBottom: 16, color: '#ff6600' }} />
            <Paragraph type="secondary">发送消息开始与 AI Agent 对话</Paragraph>
            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              支持文件搜索、读写文件和 Bash 执行
            </Paragraph>
          </div>
        )}
        <TodoZone todos={todosForCurrentSession} />
        {showPill && (
          <div
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 10,
              display: 'flex',
              justifyContent: 'center',
              paddingTop: 8,
              paddingBottom: 4,
            }}
          >
            <Button
              shape="round"
              size="small"
              icon={<UpOutlined />}
              onClick={() => setShowAllMessages(true)}
              data-testid="show-all-messages-pill"
            >
              显示全部 ({hiddenCount} 条隐藏)
            </Button>
          </div>
        )}
        <MessageListView messages={visibleMessages} streaming={status === 'streaming'} />
        {pendingAsk && (
          <div ref={questionCardRef}>
            <QuestionCard
              questions={pendingAsk.questions}
              answers={pendingAsk.answers}
              annotations={pendingAsk.annotations}
              status={pendingAsk.status}
              errorMessage={pendingAsk.errorMessage}
              onAnswer={setAskAnswer}
              onNotesChange={setAskNotes}
              onOtherChange={setAskOtherText}
              onSubmit={() => void submitAsk()}
              onReject={() => void rejectAsk()}
            />
          </div>
        )}
      </div>
      <div className="bottom-stack">
        <AgentInputBox isMobile={isMobile} />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd packages/zai && pnpm test src/web/src/pages/AgentConversation.test.tsx
```

Expected: 4 个测试 PASS

- [ ] **Step 5: 重构 Agent.tsx 引用 AgentConversation**

修改 `packages/zai/src/web/src/pages/Agent.tsx`:

1. 在文件顶部 import 区域加:

```tsx
import AgentConversation from './AgentConversation'
```

2. 把原第 565-666 行(主对话区 JSX + ConfigStatusBar)替换为:

```tsx
{/* 对话核心(消息滚动 + 输入框 + QuestionCard)由 AgentConversation 渲染 */}
<AgentConversation />

{/* ConfigStatusBar 留在 Agent.tsx,因为它要接收 selectedTaskId + splitPaneOpen */}
<ConfigStatusBar
  cwdName={cwdName}
  branch={branch}
  onTaskSelect={setSelectedTaskId}
  splitPaneOpen={splitPaneOpen}
/>
```

3. **删除**以下已迁出的代码块:
   - `showAllMessages` state(原 78 行)
   - `hiddenCountAtExpandRef` + useEffect(原 120-129 行)
   - `visibleMessages` / `hiddenCount` useMemo(原 81-115 行)
   - `useAutoScrollToBottom` 调用(原 200-201 行)
   - `scrollContainerRef` / `questionCardRef`(原 194-201 行)
   - Esc 中断 useEffect(原 238-248 行)
   - `pendingAsk` / `setAskAnswer` / `setAskNotes` / `setAskOtherText` / `submitAsk` / `rejectAsk` store selectors(原 156-161 行)
   - `MessageListView` 渲染(原 631 行)
   - `<QuestionCard>` 渲染(原 632-647 行)
   - `<TodoZone todos={todosForCurrentSession} />`(原 607 行)
   - "messages 为空" 占位(原 588-606 行)
   - "显示全部" pill 按钮(原 608-630 行)

完整 diff 通过 `git diff` 验证:Agent.tsx 行数应从 ~678 缩减到 ~520 左右。

- [ ] **Step 6: 跑 Agent.tsx 现有测试,确认未破坏**

```bash
cd packages/zai && pnpm test src/web/src/pages/Agent.test.tsx
```

Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add packages/zai/src/web/src/pages/AgentConversation.tsx packages/zai/src/web/src/pages/AgentConversation.test.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "refactor(zai-web): extract AgentConversation shared component for PC + mobile"
```

---

### Task 6: AgentInputBox `isMobile` prop

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx`
- Modify: `packages/zai/src/web/src/components/AgentInputBox.test.tsx`

**Interfaces:**
- Consumes: `isMobile?: boolean` from Task 5
- Produces: `AgentInputBox` 接受 `isMobile?: boolean` prop,默认 false;`isMobile=true` 时不渲染 split-pane toggle / transcript-collapse / transcript-repair 按钮

- [ ] **Step 1: 加失败测试**

在 `packages/zai/src/web/src/components/AgentInputBox.test.tsx` 末尾追加:

```tsx
import AgentInputBox from './AgentInputBox'

describe('AgentInputBox isMobile', () => {
  test('isMobile=true hides split-pane toggle', () => {
    render(<AgentInputBox isMobile />)
    expect(screen.queryByTestId('split-pane-toggle-inputbox')).toBeNull()
  })

  test('isMobile=false (default) shows split-pane toggle', () => {
    render(<AgentInputBox />)
    expect(screen.queryByTestId('split-pane-toggle-inputbox')).not.toBeNull()
  })

  test('isMobile=true hides transcript-collapse button', () => {
    render(<AgentInputBox isMobile />)
    expect(screen.queryByTestId('transcript-collapse-button')).toBeNull()
  })

  test('isMobile=true hides transcript-repair button', () => {
    render(<AgentInputBox isMobile />)
    expect(screen.queryByTestId('transcript-repair-button')).toBeNull()
  })
})
```

> 注:上面的 import / render / screen 来自文件顶部既有 import 行,不需要再加。若该测试文件尚无 `render` / `screen` 的 import,在文件顶部加 `import { render, screen } from '@testing-library/react'`。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/zai && pnpm test src/web/src/components/AgentInputBox.test.tsx
```

Expected: 4 个新测试中前两个 FAIL(`split-pane-toggle-inputbox` 在 isMobile=true 时仍渲染)— 因为当前 prop 还没接上

- [ ] **Step 3: 实现 isMobile prop**

修改 `packages/zai/src/web/src/components/AgentInputBox.tsx`:

1. 在 `export default React.memo(function AgentInputBox() {` 这一行(原 79 行附近)加 prop 参数:

```tsx
export interface AgentInputBoxProps {
  /** 移动端下隐藏 split-pane toggle / transcript-collapse / transcript-repair 按钮 */
  isMobile?: boolean
}

export default React.memo(function AgentInputBox({ isMobile = false }: AgentInputBoxProps = {}) {
```

2. 在 3 个按钮渲染条件上加 `&& !isMobile`:

- 第 783 行附近 `transcript-collapse-button` 条件:

```tsx
{!transcriptLockActive && !isMobile && (
```

- 第 879 行附近 `split-pane-toggle-inputbox` 条件(其外层是 Tooltip + Button + Tooltip):

```tsx
{!isMobile && (
  <Tooltip title="切换右侧分屏" placement="top">
    <Button ... />
  </Tooltip>
)}
```

- 第 810 行附近 `transcript-repair-button` 的 Tooltip 包整个一段,在最外层 `Tooltip` 之前加 `{!isMobile && (` 并在对应闭合:

```tsx
{!isMobile && (
  <Tooltip title={...}>
    <Button ... />
  </Tooltip>
)}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd packages/zai && pnpm test src/web/src/components/AgentInputBox.test.tsx
```

Expected: 所有测试(含既有 + 新增 4 个)PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/components/AgentInputBox.tsx packages/zai/src/web/src/components/AgentInputBox.test.tsx
git commit -m "feat(zai-web): add isMobile prop to AgentInputBox to hide split-pane controls"
```

---

### Task 7: MobileHeader 组件

**Files:**
- Create: `packages/zai/src/web/src/components/MobileHeader.tsx`

**Interfaces:**
- Consumes: `useAgentStore.sessionId` / `sessions` / `createNewSession`, `onOpenSessionDrawer: () => void` 回调 prop

- [ ] **Step 1: 实现 MobileHeader**

创建 `packages/zai/src/web/src/components/MobileHeader.tsx`:

```tsx
import { Button } from 'antd'
import { MenuOutlined, PlusOutlined } from '@ant-design/icons'
import { useAgentStore } from '../store/useAgentStore'

export interface MobileHeaderProps {
  /** 点左上角 [≡] 按钮触发(父组件打开会话列表 Drawer) */
  onOpenSessionDrawer: () => void
}

/**
 * 移动端 56px 顶栏:
 *   左: [≡] 抽屉触发按钮 + 当前会话标题(取 sessions.find(s => s.transcriptId === sessionId).title)
 *   右: [+] 新建会话按钮
 * 不渲染设置/分享按钮 — 这两个由 AgentInputBox 内部工具栏提供。
 */
export default function MobileHeader({ onOpenSessionDrawer }: MobileHeaderProps) {
  const sessionId = useAgentStore((s) => s.sessionId)
  const sessions = useAgentStore((s) => s.sessions)
  const createNewSession = useAgentStore((s) => s.createNewSession)
  const current = sessions.find((s) => s.transcriptId === sessionId)
  const title = current?.title || '新会话'

  return (
    <div
      style={{
        height: 56,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        borderBottom: '1px solid rgba(255,255,255,0.10)',
        background: '#12121a',
        flexShrink: 0,
      }}
    >
      <Button
        type="text"
        icon={<MenuOutlined />}
        onClick={onOpenSessionDrawer}
        data-testid="mobile-header-drawer-toggle"
        aria-label="打开会话列表"
        style={{ width: 40, height: 40, padding: 0 }}
      />
      <div
        style={{
          flex: 1,
          textAlign: 'center',
          fontSize: 14,
          fontWeight: 500,
          color: '#f1f5f9',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          padding: '0 8px',
        }}
        data-testid="mobile-header-title"
      >
        {title}
      </div>
      <Button
        type="text"
        icon={<PlusOutlined />}
        onClick={() => void createNewSession()}
        data-testid="mobile-header-new-session"
        aria-label="新建会话"
        style={{ width: 40, height: 40, padding: 0 }}
      />
    </div>
  )
}
```

- [ ] **Step 2: typecheck**

```bash
cd packages/zai && pnpm typecheck
```

Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add packages/zai/src/web/src/components/MobileHeader.tsx
git commit -m "feat(zai-web): add MobileHeader (drawer toggle + title + new session)"
```

---

### Task 8: MobileSessionDrawer 组件

**Files:**
- Create: `packages/zai/src/web/src/components/MobileSessionDrawer.tsx`

**Interfaces:**
- Consumes: `useAgentStore.sessions` / `sessionId` / `setCurrentSession` / `loadTranscript` / `deleteSession` / `createNewSession`

- [ ] **Step 1: 实现 MobileSessionDrawer**

创建 `packages/zai/src/web/src/components/MobileSessionDrawer.tsx`:

```tsx
import { Drawer, Button, Popconfirm } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { useAgentStore } from '../store/useAgentStore'

export interface MobileSessionDrawerProps {
  open: boolean
  onClose: () => void
}

/**
 * 从左侧滑出的会话列表 — 替代 PC 端内嵌的 40/140px 列。
 * 点某条会话 → setCurrentSession + loadTranscript,然后调 onClose 关抽屉。
 */
export default function MobileSessionDrawer({ open, onClose }: MobileSessionDrawerProps) {
  const sessions = useAgentStore((s) => s.sessions)
  const sessionId = useAgentStore((s) => s.sessionId)
  const setCurrentSession = useAgentStore((s) => s.setCurrentSession)
  const loadTranscript = useAgentStore((s) => s.loadTranscript)
  const deleteSession = useAgentStore((s) => s.deleteSession)
  const createNewSession = useAgentStore((s) => s.createNewSession)

  const handlePick = (sid: string) => {
    setCurrentSession(sid)
    void loadTranscript(sid)
    onClose()
  }

  return (
    <Drawer
      title="会话历史"
      placement="left"
      open={open}
      onClose={onClose}
      width="80%"
      styles={{ body: { padding: 0 } }}
      data-testid="mobile-session-drawer"
      extra={
        <Button
          type="text"
          icon={<PlusOutlined />}
          onClick={() => void createNewSession()}
          aria-label="新建会话"
        />
      }
    >
      {sessions.length === 0 && (
        <div style={{ padding: 16, color: '#999', fontSize: 13 }}>暂无历史会话</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {sessions.map((s) => {
          const active = s.transcriptId === sessionId
          return (
            <div
              key={s.transcriptId}
              role="button"
              tabIndex={0}
              onClick={() => handlePick(s.transcriptId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  handlePick(s.transcriptId)
                }
              }}
              data-testid={`mobile-session-item-${s.transcriptId}`}
              style={{
                padding: '12px 16px',
                cursor: 'pointer',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                background: active ? 'rgba(255,102,0,0.10)' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 14,
                    color: active ? '#ff8533' : '#f1f5f9',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {s.title || '新会话'}
                </div>
                <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                  {new Date(s.updatedAt).toLocaleString()}
                </div>
              </div>
              <Popconfirm
                title="删除该会话?"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={(e) => {
                  e?.stopPropagation()
                  void deleteSession(s.transcriptId)
                }}
                onCancel={(e) => e?.stopPropagation()}
              >
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={(e) => e.stopPropagation()}
                  aria-label="删除会话"
                />
              </Popconfirm>
            </div>
          )
        })}
      </div>
    </Drawer>
  )
}
```

- [ ] **Step 2: typecheck**

```bash
cd packages/zai && pnpm typecheck
```

Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add packages/zai/src/web/src/components/MobileSessionDrawer.tsx
git commit -m "feat(zai-web): add MobileSessionDrawer (left Drawer with sessions list)"
```

---

### Task 9: MobileAgent 页面 + 测试

**Files:**
- Create: `packages/zai/src/web/src/pages/MobileAgent.tsx`
- Create: `packages/zai/src/web/src/pages/MobileAgent.test.tsx`

**Interfaces:**
- Consumes: `useAgentStore.loadSessions` + `createNewSession`(挂载时), `AgentConversation` from Task 5, `MobileHeader` from Task 7, `MobileSessionDrawer` from Task 8

- [ ] **Step 1: 实现 MobileAgent**

创建 `packages/zai/src/web/src/pages/MobileAgent.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useAgentStore } from '../store/useAgentStore'
import { useAppStore } from '../store/useAppStore'
import AgentConversation from './AgentConversation'
import MobileHeader from '../components/MobileHeader'
import MobileSessionDrawer from '../components/MobileSessionDrawer'
import { SessionCwdBridge } from '../components/SessionCwdBridge'
import { TaskDrawer } from '../components/TaskDrawer'
import { ApproveDrawer } from '../components/ApproveDrawer'
import { SettingsDrawer } from '../components/SettingsDrawer'

/**
 * 移动端 /agent 页面:
 *   - MobileHeader 顶栏(≡ / 标题 / +)
 *   - AgentConversation 对话核心(isMobile=true,屏蔽分屏相关 UI)
 *   - MobileSessionDrawer 左侧抽屉式会话切换
 *   - 不挂 SplitPane / 不挂 Sider 导航栏 / 不挂 TaskDock / 不挂 BottomStatusBar
 *   - 保留:SessionCwdBridge(更新 cwdName)/ TaskDrawer / ApproveDrawer / SettingsDrawer
 */
export default function MobileAgent() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const loadSessions = useAgentStore((s) => s.loadSessions)
  const sessions = useAgentStore((s) => s.sessions)
  const sessionId = useAgentStore((s) => s.sessionId)
  const createNewSession = useAgentStore((s) => s.createNewSession)
  const { instanceContext } = useAppStore()
  const cwdName = instanceContext?.cwdName || '~'
  const branch = instanceContext?.branch || 'master'
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  // 首次挂载:拉 sessions;为空则自动建一条空会话(与 Agent.tsx 行为对齐)
  useEffect(() => {
    ;(async () => {
      await loadSessions()
      if (useAgentStore.getState().sessions.length === 0) {
        await useAgentStore.getState().createNewSession()
      }
    })()
  }, [])

  return (
    <>
      <MobileHeader onOpenSessionDrawer={() => setDrawerOpen(true)} />
      <AgentConversation isMobile />
      <MobileSessionDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <TaskDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      <ApproveDrawer />
      <SettingsDrawer />
      <SessionCwdBridge />
      {/* cwdName / branch / sessions / sessionId 占位 — 不在 DOM 里渲染,仅满足类型 */}
      <span
        hidden
        data-cwd-name={cwdName}
        data-branch={branch}
        data-sessions-count={sessions.length}
        data-session-id={sessionId ?? ''}
        data-create-new-session={String(typeof createNewSession)}
      />
    </>
  )
}
```

- [ ] **Step 2: 写失败测试**

创建 `packages/zai/src/web/src/pages/MobileAgent.test.tsx`:

```tsx
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MobileAgent from './MobileAgent'
import { useAgentStore } from '../store/useAgentStore'

vi.mock('./AgentConversation', () => ({
  default: ({ isMobile }: { isMobile?: boolean }) => (
    <div data-testid="agent-conv" data-mobile={String(!!isMobile)} />
  ),
}))
vi.mock('../components/MobileHeader', () => ({
  default: ({ onOpenSessionDrawer }: { onOpenSessionDrawer: () => void }) => (
    <button data-testid="mobile-header" onClick={onOpenSessionDrawer}>
      ≡
    </button>
  ),
}))
vi.mock('../components/MobileSessionDrawer', () => ({
  default: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
    <div data-testid="mobile-session-drawer" data-open={String(open)}>
      <button data-testid="close-drawer" onClick={onClose}>X</button>
    </div>
  ),
}))
vi.mock('../components/TaskDrawer', () => ({ default: () => null }))
vi.mock('../components/ApproveDrawer', () => ({ default: () => null }))
vi.mock('../components/SettingsDrawer', () => ({ default: () => null }))
vi.mock('../components/SessionCwdBridge', () => ({ default: () => null }))

beforeEach(() => {
  useAgentStore.setState({
    sessions: [
      { transcriptId: 's1', title: '会话 1', updatedAt: Date.now() } as any,
      { transcriptId: 's2', title: '会话 2', updatedAt: Date.now() } as any,
    ],
    sessionId: 's1',
    activeSessionId: 's1',
    messages: [],
    pendingAsk: null,
    status: 'idle',
    todosBySession: {},
    cwdBySession: {},
    loadSessions: vi.fn().mockResolvedValue(undefined),
    createNewSession: vi.fn().mockResolvedValue(undefined),
    setCurrentSession: vi.fn(),
    loadTranscript: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  } as any)
})

describe('MobileAgent', () => {
  test('renders MobileHeader + AgentConversation(isMobile=true)', () => {
    render(<MobileAgent />)
    expect(screen.getByTestId('mobile-header')).toBeTruthy()
    expect(screen.getByTestId('agent-conv').getAttribute('data-mobile')).toBe('true')
  })

  test('does NOT render SplitPane', () => {
    render(<MobileAgent />)
    expect(screen.queryByTestId('split-pane')).toBeNull()
  })

  test('clicking [≡] in header opens session drawer', () => {
    render(<MobileAgent />)
    expect(screen.getByTestId('mobile-session-drawer').getAttribute('data-open')).toBe('false')
    fireEvent.click(screen.getByTestId('mobile-header'))
    expect(screen.getByTestId('mobile-session-drawer').getAttribute('data-open')).toBe('true')
  })

  test('closing drawer fires onClose', () => {
    render(<MobileAgent />)
    fireEvent.click(screen.getByTestId('mobile-header'))
    fireEvent.click(screen.getByTestId('close-drawer'))
    expect(screen.getByTestId('mobile-session-drawer').getAttribute('data-open')).toBe('false')
  })

  test('calls loadSessions on mount', () => {
    const loadSessions = vi.fn().mockResolvedValue(undefined)
    useAgentStore.setState({ loadSessions } as any)
    render(<MobileAgent />)
    expect(loadSessions).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: 运行测试确认通过**

```bash
cd packages/zai && pnpm test src/web/src/pages/MobileAgent.test.tsx
```

Expected: 5 个测试 PASS

- [ ] **Step 4: 提交**

```bash
git add packages/zai/src/web/src/pages/MobileAgent.tsx packages/zai/src/web/src/pages/MobileAgent.test.tsx
git commit -m "feat(zai-web): add MobileAgent page (header + conversation + session drawer)"
```

---

### Task 10: 路由配置 — 把 /m 接入 router.tsx

**Files:**
- Modify: `packages/zai/src/web/src/router.tsx`

**Interfaces:**
- Produces: 新增 `<Route path="/m" element={<MobileAgent />} />`,挂到 `<Route element={<MobileLayout />}>` 父路由下

- [ ] **Step 1: 修改 router.tsx**

把 `packages/zai/src/web/src/router.tsx` 整个文件替换为:

```tsx
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import MobileLayout from './components/MobileLayout'
import Dashboard from './pages/Dashboard'
import Tools from './pages/Tools'
import Resources from './pages/Resources'
import Login from './pages/Login'
import Config from './pages/Config'
import Directory from './pages/Directory'
import Agent from './pages/Agent'
import MobileAgent from './pages/MobileAgent'

export default function AppRouter() {
  return (
    <Routes>
      {/* 桌面端 — 走 Layout(含 Sider) */}
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/tools" element={<Tools />} />
        <Route path="/resources" element={<Resources />} />
        <Route path="/config" element={<Config />} />
        <Route path="/dirs" element={<Directory />} />
        <Route path="/agent" element={<Agent />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Route>

      {/* 移动端 — 走 MobileLayout(无 Sider, 挂 visualViewport) */}
      <Route element={<MobileLayout />}>
        <Route path="/m" element={<MobileAgent />} />
      </Route>
    </Routes>
  )
}
```

- [ ] **Step 2: typecheck**

```bash
cd packages/zai && pnpm typecheck
```

Expected: PASS

- [ ] **Step 3: 跑全量测试**

```bash
cd packages/zai && pnpm test
```

Expected: 全部 PASS(redirectMobileUA + useVisualViewportHeight + AgentConversation + AgentInputBox isMobile + MobileAgent + 既有所有测试)

- [ ] **Step 4: 提交**

```bash
git add packages/zai/src/web/src/router.tsx
git commit -m "feat(zai-web): wire /m route through MobileLayout -> MobileAgent"
```

---

### Task 11: 全量回归 + 手动 smoke

**Files:**
- 无文件改动 — 纯验证

- [ ] **Step 1: typecheck 全绿**

```bash
cd packages/zai && pnpm typecheck
```

Expected: 无错误

- [ ] **Step 2: 全量单测全绿**

```bash
cd packages/zai && pnpm test
```

Expected: 全部 PASS

- [ ] **Step 3: 手动 smoke — Chrome DevTools**

1. 启动 zai dev:
   ```bash
   cd packages/zai && pnpm dev
   ```
2. 浏览器访问 `http://localhost:9201/agent`(或 vite port),F12 → Network → 点 UA 列表 → 选 `iPhone`。
3. **预期**:服务器 302 → `/m` → 渲染 MobileAgent,顶栏(≡ / 当前会话标题 / +),主对话区,无 SplitPane,无 Sider。
4. 在浏览器控制台点 [≡] 按钮 → 左侧 Drawer 滑出显示会话列表 → 点某条 → 抽屉关闭,会话切换。
5. 点击输入框 → 虚拟键盘弹出 → 容器高度自动收缩,TextArea 仍可见。
6. 切回 PC UA → 访问 `http://localhost:9201/agent` → 应直接走桌面版(Layout + Agent.tsx),不再 302。

- [ ] **Step 4: 提交(若有 smoke 发现的小改动)**

```bash
git add -A
git diff --cached --quiet || git commit -m "fix(zai-mobile): smoke-test polish"
```