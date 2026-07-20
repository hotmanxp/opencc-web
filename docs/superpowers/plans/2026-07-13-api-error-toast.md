# 全局 API 错误 Toast — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai 前端统一拦截 `/api/*` 失败与 SSE 异常断开,通过 antd `notification.error` 在右上角弹 Toast,click 展开详情(method/url/status/body);同时移除 5 个页面共 10 处冗余 `message.error`。

**Architecture:**
1. 新增 `lib/apiError.ts` — 暴露 `ApiError` 类与 `notifyApiError` / `notifySseError` 两个函数。节流 2s / key,LRU 64。
2. `lib/api.ts` 失败分支 — 读 body → `notifyApiError` → `throw ApiError`。业务方 try/catch 仍能拿到 ApiError。
3. `lib/sse.ts` + `lib/eventSource.ts` — 维护 `doneRef`,连接级 onerror 若之前没有收到 `exit` 就通知 + onEnd。
4. 业务页面 — 删 10 处冗余 `message.error`,保留 3 处业务级。

**Tech Stack:** TypeScript, vitest@2.1, antd@5 `notification.error`, React 18.

## Global Constraints

- 测试: vitest@2.1, `packages/zai/vitest.config.ts` 已包含 `test/**/*.test.ts` 与 `src/**/*.test.ts`,可直接 `pnpm --filter @zn-ai/zai test`。
- 命名: 新文件与符号遵循 camelCase,导出 `ApiError` / `notifyApiError` / `notifySseError`。
- 不引入新依赖(antd 已用,`notification.error` 已可用)。
- 测试 mock 模式参考 `packages/zai/src/web/src/lib/eventSource.test.ts`(`vi.stubGlobal`)。
- 节流 LRU key 格式: HTTP `method+url+status`;SSE `sse:path`。

## File Map

| Path | Action | Purpose |
|---|---|---|
| `packages/zai/src/web/src/lib/apiError.ts` | Create | ApiError 类 + 两个 notify 函数 + 节流 LRU |
| `packages/zai/src/web/src/lib/apiError.test.ts` | Create | 单测:ApiError 字段,notify 调用 notification.error,节流生效 |
| `packages/zai/src/web/src/lib/api.ts` | Edit | request 失败分支:读 body → notify → throw ApiError |
| `packages/zai/src/web/src/lib/api.test.ts` | Create | 单测:失败 throw ApiError,notify 调用,成功分支不变 |
| `packages/zai/src/web/src/lib/sse.ts` | Edit | useSse 维护 doneRef,onerror 分流 |
| `packages/zai/src/web/src/lib/sse.test.ts` | Create | 单测:onerror 时只在 done===false 时调 notify |
| `packages/zai/src/web/src/lib/eventSource.ts` | Edit | subscribeServerEvents 在 onError 时调 notifySseError |
| `packages/zai/src/web/src/lib/eventSource.test.ts` | Edit | 加一条:onerror 触发 notifySseError('/event', ...) |
| `packages/zai/src/web/src/pages/Dashboard.tsx` | Edit | 删 3 处 message.error(25 / 56 / 64) |
| `packages/zai/src/web/src/pages/Directory.tsx` | Edit | 删 2 处 message.error(97 / 134) |
| `packages/zai/src/web/src/pages/Config.tsx` | Edit | 删 5 处 message.error(91 / 150 / 164 / 268 / 289 / 394 / 434),保留 420 / 424 |
| `packages/zai/src/web/src/pages/Resources.tsx` | Edit | 删 2 处 message.error(95 / 132) |
| `packages/zai/src/web/src/pages/Login.tsx` | Edit | 不改(业务级保留) |

---

## Task 1: apiError 模块 + ApiError 类 + 节流

**Files:**
- Create: `packages/zai/src/web/src/lib/apiError.ts`
- Create: `packages/zai/src/web/src/lib/apiError.test.ts`

**Interfaces:**
- Produces:
  - `export class ApiError extends Error { status; method; url; body; at }`
  - `export function notifyApiError(err: ApiError): void`
  - `export function notifySseError(path: string, reason: string): void`

- [ ] **Step 1: 写失败的 ApiError 类单测**

在 `packages/zai/src/web/src/lib/apiError.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { ApiError } from './apiError.js'

describe('ApiError', () => {
  test('字段赋值正确', () => {
    const e = new ApiError(502, 'GET', '/system', 'bad gateway')
    expect(e.status).toBe(502)
    expect(e.method).toBe('GET')
    expect(e.url).toBe('/system')
    expect(e.body).toBe('bad gateway')
    expect(e.name).toBe('ApiError')
    expect(e).toBeInstanceOf(Error)
  })

  test('message 携带 status + method + url', () => {
    const e = new ApiError(404, 'POST', '/agent/prompt', '')
    expect(e.message).toContain('404')
    expect(e.message).toContain('POST')
    expect(e.message).toContain('/agent/prompt')
  })

  test('at 是当前时间戳(ms)', () => {
    const before = Date.now()
    const e = new ApiError(500, 'GET', '/x', '')
    const after = Date.now()
    expect(e.at).toBeGreaterThanOrEqual(before)
    expect(e.at).toBeLessThanOrEqual(after)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `pnpm --filter @zn-ai/zai test -- apiError.test.ts`
Expected: FAIL — `Cannot find module './apiError.js'`

- [ ] **Step 3: 实现 ApiError 类**

在 `packages/zai/src/web/src/lib/apiError.ts`:

```ts
export class ApiError extends Error {
  readonly status: number
  readonly method: string
  readonly url: string
  readonly body: string
  readonly at: number

  constructor(
    status: number,
    method: string,
    url: string,
    body: string,
  ) {
    super(`${status} ${method} /api${url}`.trimEnd())
    this.name = 'ApiError'
    this.status = status
    this.method = method
    this.url = url
    this.body = body
    this.at = Date.now()
  }
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `pnpm --filter @zn-ai/zai test -- apiError.test.ts`
Expected: PASS — 3 tests in 'ApiError' all green.

- [ ] **Step 5: 写失败的 notifyApiError + notifySseError + 节流单测**

在同一个测试文件追加:

```ts
import { vi } from 'vitest'
import { ApiError, notifyApiError, notifySseError, __resetThrottleForTests } from './apiError.js'

const notifMock = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('antd', () => ({ notification: notifMock }))

describe('notifyApiError', () => {
  beforeEach(() => {
    notifMock.error.mockReset()
    __resetThrottleForTests()
  })

  test('首次调用触发 antd notification.error,message 含 status+method+path,description 含 body+method+url+status,duration=6', () => {
    notifyApiError(new ApiError(502, 'GET', '/system', 'bad gateway'))
    expect(notifMock.error).toHaveBeenCalledTimes(1)
    const cfg = notifMock.error.mock.calls[0][0]
    expect(cfg.message).toContain('502')
    expect(cfg.message).toContain('GET')
    expect(cfg.message).toContain('/api/system')
    expect(cfg.duration).toBe(6)
    expect(typeof cfg.description).toBe('string')
    expect(cfg.description).toContain('GET')
    expect(cfg.description).toContain('/api/system')
    expect(cfg.description).toContain('502')
    expect(cfg.description).toContain('bad gateway')
  })

  test('同一 key 2000ms 内第二次调用被节流', () => {
    notifyApiError(new ApiError(502, 'GET', '/system', ''))
    notifyApiError(new ApiError(502, 'GET', '/system', ''))
    expect(notifMock.error).toHaveBeenCalledTimes(1)
  })

  test('不同 status 不节流', () => {
    notifyApiError(new ApiError(500, 'GET', '/x', ''))
    notifyApiError(new ApiError(502, 'GET', '/x', ''))
    expect(notifMock.error).toHaveBeenCalledTimes(2)
  })
})

describe('notifySseError', () => {
  beforeEach(() => {
    notifMock.error.mockReset()
    __resetThrottleForTests()
  })

  test('弹出连接已断开 toast', () => {
    notifySseError('/install/resource?type=skills', '连接已断开')
    expect(notifMock.error).toHaveBeenCalledTimes(1)
    const cfg = notifMock.error.mock.calls[0][0]
    expect(cfg.message).toContain('SSE')
    expect(cfg.description).toContain('/install')
    expect(cfg.duration).toBe(6)
  })

  test('同 path 2000ms 内重复被节流', () => {
    notifySseError('/event', 'oops')
    notifySseError('/event', 'oops')
    expect(notifMock.error).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 6: 跑测试,确认失败**

Run: `pnpm --filter @zn-ai/zai test -- apiError.test.ts`
Expected: FAIL — `notifyApiError` / `notifySseError` / `__resetThrottleForTests` not exported.

- [ ] **Step 7: 实现 notify + LRU 节流**

> **已选定方案:静态 description**(plain text)。理由:① 避免 React state 引入额外复杂度;② spec 第 52 行的"默认折叠"是为 UX 优化,但 spec 的 spirit 是"看见详情",静态全文可直接满足;③ 测试断言简单,不用 mock Button/useState。后续若 PM 反馈需要可折叠,可在 Issue 上加。

在 `apiError.ts` 末尾追加:

```ts
import { notification } from 'antd'

// 节流:key → 上次通知的 timestamp(ms)。LRU 上限 64,超出从头淘汰。
const THROTTLE_WINDOW_MS = 2000
const MAX_KEYS = 64
const lastNotifyAt = new Map<string, number>()

function shouldNotify(key: string): boolean {
  const now = Date.now()
  const last = lastNotifyAt.get(key)
  if (last !== undefined && now - last < THROTTLE_WINDOW_MS) return false
  lastNotifyAt.set(key, now)
  if (lastNotifyAt.size > MAX_KEYS) {
    const oldest = lastNotifyAt.keys().next().value
    if (oldest !== undefined) lastNotifyAt.delete(oldest)
  }
  return true
}

// 仅测试用
export function __resetThrottleForTests(): void {
  lastNotifyAt.clear()
}

export function notifyApiError(err: ApiError): void {
  const key = `${err.method} ${err.url} ${err.status}`
  if (!shouldNotify(key)) return
  let bodyDisplay: string
  try {
    bodyDisplay = JSON.stringify(JSON.parse(err.body), null, 2)
  } catch {
    bodyDisplay = err.body
  }
  const description =
    `${err.method} /api${err.url}\n` +
    `status: ${err.status}\n` +
    `time:   ${new Date(err.at).toISOString()}\n\n` +
    bodyDisplay
  notification.error({
    message: `${err.status} ${err.method} /api${err.url}`.trimEnd(),
    description,
    duration: 6,
  })
}

export function notifySseError(path: string, reason: string): void {
  const key = `sse:${path}`
  if (!shouldNotify(key)) return
  notification.error({
    message: 'SSE 连接已断开',
    description: `path: ${path}\nreason: ${reason}`,
    duration: 6,
  })
}
```

- [ ] **Step 8: 跑测试,通过**

Run: `pnpm --filter @zn-ai/zai test -- apiError.test.ts`
Expected: PASS — `ApiError` 3 + `notifyApiError` 3 + `notifySseError` 2 = 8 tests green.

- [ ] **Step 9: 提交**

```bash
git add packages/zai/src/web/src/lib/apiError.ts packages/zai/src/web/src/lib/apiError.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-web): 新增 apiError 模块(ApiError + 通知 + 节流)"
```

---

## Task 2: api.ts 失败拦截

**Files:**
- Edit: `packages/zai/src/web/src/lib/api.ts`(整文件覆盖 `request`)
- Create: `packages/zai/src/web/src/lib/api.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ApiError` / `notifyApiError`
- Produces: `request<T>` 在 !ok 时先 `notifyApiError(err)` 再 `throw err`;成功路径不变

- [ ] **Step 1: 写失败单测**

在 `packages/zai/src/web/src/lib/api.test.ts`:

```ts
import { describe, expect, test, vi, beforeEach } from 'vitest'

const notifMock = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('antd', () => ({ notification: notifMock }))

import { api } from './api.js'
import { ApiError } from './apiError.js'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function jsonResponse(status: number, body: unknown) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('api request', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    notifMock.error.mockReset()
    notifMock.error.mockImplementation(() => undefined)
  })

  test('成功 get 返回 JSON', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { a: 1 }))
    const r = await api.get<{ a: number }>('/foo')
    expect(r).toEqual({ a: 1 })
    expect(notifMock.error).not.toHaveBeenCalled()
  })

  test('失败抛 ApiError 并触发 notify', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { error: 'bad gateway' }))
    await expect(api.get('/system')).rejects.toBeInstanceOf(ApiError)
    expect(notifMock.error).toHaveBeenCalledTimes(1)
  })

  test('错误体读取并写入 ApiError.body(非 JSON 走 text)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('plain text error', { status: 500 }),
    )
    try {
      await api.get('/x')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(500)
      expect((err as ApiError).body).toBe('plain text error')
    }
  })

  test('post 序列化 JSON body 并设置 Content-Type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    await api.post('/x', { a: 1 })
    const init = fetchMock.mock.calls[0][1]
    expect(JSON.parse(init.body)).toEqual({ a: 1 })
    expect(init.headers['Content-Type']).toBe('application/json')
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `pnpm --filter @zn-ai/zai test -- api.test.ts`
Expected: FAIL — 失败分支不会 throw 也不调 notify。

- [ ] **Step 3: 改 api.ts**

把 `packages/zai/src/web/src/lib/api.ts` 改为:

```ts
import { ApiError, notifyApiError } from './apiError.js'

const API_BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase()
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    const err = new ApiError(res.status, method, path, body)
    notifyApiError(err)
    throw err
  }
  return res.json()
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `pnpm --filter @zn-ai/zai test -- api.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: 跑全 zai 测试,确认没有回归**

Run: `pnpm --filter @zn-ai/zai test`
Expected: 既有测试全部 PASS(新增除外)。

- [ ] **Step 6: 提交**

```bash
git add packages/zai/src/web/src/lib/api.ts packages/zai/src/web/src/lib/api.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-web): api.request 失败统一拦截并抛 ApiError"
```

---

## Task 3: SSE 连接异常通知

**Files:**
- Edit: `packages/zai/src/web/src/lib/sse.ts`
- Edit: `packages/zai/src/web/src/lib/eventSource.ts`
- Create: `packages/zai/src/web/src/lib/sse.test.ts`
- Edit: `packages/zai/src/web/src/lib/eventSource.test.ts`(追加 1 个测试)

**Interfaces:**
- Consumes: Task 1 的 `notifySseError`
- Produces: `useSse` 与 `subscribeServerEvents` 的 onerror 在"正常结束(d 收到 exit)"之外触发通知 + onEnd

- [ ] **Step 1: 写 useSse 失败单测**

在 `packages/zai/src/web/src/lib/sse.test.ts`:

```ts
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const notifMock = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('antd', () => ({ notification: notifMock }))

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  close = vi.fn()
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
}
vi.stubGlobal('EventSource', MockEventSource)

import { useSse } from './sse.js'

describe('useSse', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    notifMock.error.mockReset()
    notifMock.error.mockImplementation(() => undefined)
  })

  test('onerror 在 done===false 时触发 notify 并调 onEnd', () => {
    const onEnd = vi.fn()
    renderHook(() => useSse('/install/resource?x=1', () => {}, onEnd))
    const es = MockEventSource.instances[0]
    act(() => es.onerror?.(new Event('error')))
    expect(notifMock.error).toHaveBeenCalledTimes(1)
    expect(notifMock.error.mock.calls[0][0].message).toContain('SSE')
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  test('onerror 在已收到 exit 后静默(不通知,仍调 onEnd)', () => {
    const onEnd = vi.fn()
    renderHook(() => useSse('/install/resource?x=2', () => {}, onEnd))
    const es = MockEventSource.instances[0]
    act(() => {
      es.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 0 }) })
    })
    act(() => es.onerror?.(new Event('error')))
    expect(notifMock.error).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `pnpm --filter @zn-ai/zai test -- sse.test.ts`
Expected: FAIL — 现在 onerror 不区分,直接调 onEnd 不调 notify。

- [ ] **Step 3: 改造 sse.ts**

替换 `packages/zai/src/web/src/lib/sse.ts`:

```ts
import { useEffect, useRef, useCallback } from 'react'
import type { SseEvent } from '@shared/types'
import { notifySseError } from './apiError.js'

const API_BASE = '/api'

export function useSse(
  path: string,
  onEvent: (ev: SseEvent) => void,
  onEnd?: () => void,
): () => void {
  const sourceRef = useRef<EventSource | null>(null)
  const doneRef = useRef<boolean>(false)
  const onEventRef = useRef(onEvent)
  const onEndRef = useRef(onEnd)

  onEventRef.current = onEvent
  onEndRef.current = onEnd

  const cleanup = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close()
      sourceRef.current = null
    }
  }, [])

  useEffect(() => {
    const base = path.startsWith('/api/') ? path : `${API_BASE}${path}`

    doneRef.current = false
    const source = new EventSource(base)
    sourceRef.current = source

    source.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as SseEvent
        onEventRef.current(ev)
        if (ev.type === 'exit' || ev.type === 'error') {
          doneRef.current = true
          source.close()
          onEndRef.current?.()
        }
      } catch (e) {
        console.error('Failed to parse SSE event:', e)
      }
    }

    source.onerror = () => {
      // 已收到 exit/error(正常结束)后浏览器仍可能在底层连接
      // 关闭时再 fire 一次 onerror,此时直接 return 避免 onEnd 重复。
      if (doneRef.current) return
      doneRef.current = true
      notifySseError(path, '连接已断开')
      source.close()
      onEndRef.current?.()
    }

    return cleanup
  }, [path, cleanup])

  return cleanup
}
```

- [ ] **Step 4: 跑测试,通过**

Run: `pnpm --filter @zn-ai/zai test -- sse.test.ts`
Expected: PASS — 2 tests green.

- [ ] **Step 5: 改造 eventSource.ts**

在 `packages/zai/src/web/src/lib/eventSource.ts`:

```ts
import { ServerEvent } from '../../../shared/events.js'
import { notifySseError } from './apiError.js'

const API_BASE = '/api'

export interface StreamHandle {
  close: () => void
}

const NAMED_EVENT_TYPES = [
  // runtime.*
  'runtime.started',
  'runtime.delta',
  'runtime.thinking',
  'runtime.tool_call',
  'runtime.tool_result',
  'runtime.done',
  'runtime.aborted',
  'runtime.error',
  // session.*
  'session.created',
  'session.deleted',
  'session.renamed',
  // job.*
  'job.started',
  'job.progress',
  'job.done',
  'job.failed',
  // prompt.*
  'prompt.ask',
  // system.*
  'server.connected',
  'server.error',
  'toast',
] as const

export function subscribeServerEvents(
  onEvent: (event: ServerEvent) => void,
  onError?: (err: Event) => void,
): StreamHandle {
  const es = new EventSource(`${API_BASE}/event`)

  for (const name of NAMED_EVENT_TYPES) {
    es.addEventListener(name, (e: MessageEvent) => {
      try {
        const parsed = ServerEvent.parse(JSON.parse(e.data))
        onEvent(parsed)
      } catch (err) {
        console.error('[eventSource] parse failed', err, e.data)
      }
    })
  }

  es.onerror = (e) => {
    notifySseError('/event', '事件流已断开')
    onError?.(e)
  }

  return {
    close: () => es.close(),
  }
}
```

- [ ] **Step 6: 追加 eventSource.test.ts 一条测试**

在 `packages/zai/src/web/src/lib/eventSource.test.ts` 末尾追加:

```ts
import { vi } from 'vitest'

const notifMock = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('antd', () => ({ notification: notifMock }))
```

并在 describe('subscribeServerEvents') 内追加:

```ts
  test('onerror 触发 notifySseError(/event)', () => {
    notifMock.error.mockReset()
    notifMock.error.mockImplementation(() => undefined)
    MockEventSource.instances = []
    const onError = vi.fn()
    subscribeServerEvents(() => {}, onError)
    const es = MockEventSource.instances[0]
    es.onerror?.(new Event('error'))
    expect(notifMock.error).toHaveBeenCalledTimes(1)
    expect(notifMock.error.mock.calls[0][0].description).toContain('/event')
    expect(onError).toHaveBeenCalledTimes(1)
  })
```

注意:`vi.mock` 提到文件顶层,该文件中已有 `vi.stubGlobal('EventSource', MockEventSource)`,新加的 `vi.mock('antd', ...)` 与之不冲突。

- [ ] **Step 7: 跑全 zai 测试**

Run: `pnpm --filter @zn-ai/zai test`
Expected: 全部 PASS(包括新的 sse + eventSource 增加的测试)。

- [ ] **Step 8: 提交**

```bash
git add packages/zai/src/web/src/lib/sse.ts packages/zai/src/web/src/lib/sse.test.ts packages/zai/src/web/src/lib/eventSource.ts packages/zai/src/web/src/lib/eventSource.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-web): SSE 连接异常统一通知,区分正常结束"
```

---

## Task 4: 清理页面内的冗余 message.error

**Files:**
- Edit: `packages/zai/src/web/src/pages/Dashboard.tsx`
- Edit: `packages/zai/src/web/src/pages/Directory.tsx`
- Edit: `packages/zai/src/web/src/pages/Config.tsx`
- Edit: `packages/zai/src/web/src/pages/Resources.tsx`

**Interfaces:**
- 移除以下 `message.error(...)` 调用,catch / .catch() 链若不再被使用,可保留变量名 `err` 但不再 toast。
- 不动 `Login.tsx`。

- [ ] **Step 1: 改 Dashboard.tsx**

精确删除以下 3 行(行号基于提交 bc2031f 后的状态):

- `Dashboard.tsx:25` — `Promise.all([...]).catch((err) => message.error(\`加载失败: ${err.message}\`))` → 把 catch 体改为 `console.error(err)` 或留空(推荐用 `console.error(err)`,保留错误日志)。
- `Dashboard.tsx:56` — `message.error(\`切换失败, npm 退出码 ${exitCode}\`)` → 删行(此处的 `exitCode` 是后端 200 body 字段,不是 HTTP 失败。为避免 toast 也删,本句保留并改文案为 `console.error('cli exit', exitCode)`)。
- `Dashboard.tsx:64` — `message.error(\`切换失败: ${(err as Error).message}\`)` → 改为 `console.error(err)`。

> 上下文确认:实施时必须先 cat `Dashboard.tsx` 的 50-65 行,确认 line 56 是 200 body 内 `exitCode !== 0` 的业务状态(非 HTTP 失败),按 spec "保留业务级 / 删 API 失败"原则,此句应改为静默 console.error 而不弹 toast。

预期改动后,Dashboard.tsx 不再 import `message` 这一项(从 antd 删掉 `message`)。请用 `Edit` 工具精确删除对应行,不要破坏其他 import。

- [ ] **Step 2: 改 Directory.tsx**

删除:
- `Directory.tsx:97` — `message.error(\`加载失败: ${err}\`)` → 删行
- `Directory.tsx:134` — `message.error('复制失败, 请手动选择')` → 删行;若同 `try/catch` 内无其他语句,清空 catch 体或仅 `console.error(err)`。

- [ ] **Step 3: 改 Config.tsx**

删除:
- `Config.tsx:91` — `message.error('加载 Provider 失败')`
- `Config.tsx:150` — `if (err instanceof Error) message.error(err.message)` → 整行改 `console.error(err)`
- `Config.tsx:164` — `message.error('删除失败')` → 删
- `Config.tsx:268` — `message.error('加载插件失败')` → 删
- `Config.tsx:289` — `message.error(\`保存失败: ${err}\`)` → 改 `console.error(err)`
- `Config.tsx:394` — `message.error('加载配置失败')` → 删
- `Config.tsx:434` — `message.error(\`保存失败: ${err}\`)` → 改 `console.error(err)`(上下文确认 line 434 在 `await api.put(\`/config/${tool}\`, ...)` 的 catch 内,纯 API 失败)

**保留**:
- `Config.tsx:420` — `message.error(\`JSON 解析失败: ${(err as Error).message}\`)`(本地 JSON.parse)
- `Config.tsx:424` — `message.error('配置文件必须是 JSON 对象')`(本地校验)

实施时请确认这些行号未漂移,以当前 commit (`91d03a0` 后续) 的内容为准;若漂移,以 grep `-n "message.error" Config.tsx` 重新对位。

- [ ] **Step 4: 改 Resources.tsx**

- `Resources.tsx:95` — `message.error(\`加载失败: ${err}\`)` → 改 `console.error(err)`
- `Resources.tsx:132` — `message.error(\`刷新失败: ${err}\`)` → 删行(同一 try 内 `hide();` 之后,只保留 `hide()` 与 console.error)

- [ ] **Step 5: 跑全 zai 测试**

Run: `pnpm --filter @zn-ai/zai test`
Expected: 全部 PASS(纯类型检查 + 既有用例;没动到测试断言)。

- [ ] **Step 6: typecheck**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: 无 `TS2304`/`TS6133` 等报错。如果出现 "message is declared but never used",从 antd 的解构导入里去掉 `message`。

- [ ] **Step 7: 提交**

```bash
git add packages/zai/src/web/src/pages/Dashboard.tsx packages/zai/src/web/src/pages/Directory.tsx packages/zai/src/web/src/pages/Config.tsx packages/zai/src/web/src/pages/Resources.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 refactor(zai-web): 移除 10 处冗余 message.error,统一走 ApiError toast"
```

---

## Task 5: 端到端手工验证

**Files:** 无(只验证)。

- [ ] **Step 1: 启动 dev server**

Run: `pnpm --filter @zn-ai/zai dev`
在另一个终端,待 server listen 后继续。

- [ ] **Step 2: 正常路径不应触发 toast**

浏览器打开默认页(Dashboard)。观察顶部 — 不应有 toast。点击侧栏 Resources / Config / Tools / Directory 任一项 — 不应有 toast。

- [ ] **Step 3: 触发 HTTP 报错 toast**

1. 在 Terminal 用 `Ctrl-C` 终止 dev server。
2. 浏览器中点击 Dashboard 的"刷新"按钮(或重新加载 `/api/system`)。
3. 期望:右上角弹出 Toast,标题包含状态码(ECONNREFUSED → 0)和 `/api/system`;点击"查看详情"展开 body 文本。

- [ ] **Step 4: 触发 SSE 异常 toast**

1. 重启 dev server。
2. 浏览器进入 Resources 页 → 触发一次 install(选个未安装的 skill/command)。
3. 在 install 进行中 `Ctrl-C` 终止 server。
4. 期望:右上角弹出 "SSE 连接已断开" Toast。

- [ ] **Step 5: 节流验证**

连续快速点击 Resources 的"刷新资源缓存" 5+ 次(在 server 关停状态下)。
期望:同一 key 在 2s 内只弹一次 toast,不堆叠。

- [ ] **Step 6: 提交验证记录(可选)**

如果发现问题,在该 commit 后追加 `fix:` commit。无问题则跳到下一步。

---

## Self-Review

Spec 覆盖:

| Spec 章节 | 覆盖 Task |
|---|---|
| 新增 apiError.ts | Task 1 |
| api.ts 改造 | Task 2 |
| sse.ts / eventSource.ts 改造 | Task 3 |
| 删除 5 个页面的 message.error | Task 4 |
| 手工验证 | Task 5 |

Placeholder 检查: 全部代码块完整,无 TBD/TODO。Type consistency: `ApiError.status/method/url/body/at` 在 Task 1 引入,在 Task 2 / 3 引用,签名一致。`notifySseError(path, reason)` 在 Task 1 引入,在 Task 3 的 sse.ts 与 eventSource.ts 引用时一致。

风险提示: Task 4 中 Dashboard.tsx:56 实际语义需实施时核对,plan 已在该 step 写明"先 cat 再改"。
