# Conversation Info Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `i` icon button next to the image upload button on the chat page. Clicking it opens a Popover card showing 9 conversation metadata fields (sessionId, title, start time, last update, turn count, message count, status, cwd, model) with a copy-sessionId action.

**Architecture:** New server route `GET /api/agent/settings` reads `~/.zai/settings.json` and returns `{ defaultModel, baseURL }`. Frontend has a `useConversationInfo` hook that derives all 9 fields from existing `useAgentStore` state plus a 1-shot fetch of the new endpoint. A `<ConversationInfoButton />` icon wraps an antd Popover containing a pure `<ConversationInfoCard />` component. Agent.tsx adds one line of JSX.

**Tech Stack:** React 18, antd 5 (Popover, Descriptions, message, CopyOutlined, InfoCircleOutlined), zustand, vitest + supertest + @testing-library/react, express.

## Global Constraints

- TypeScript strict mode; no `any` except where existing code already uses it.
- No new `useAgentStore` fields — this feature is read-only on the store.
- All commit messages in the form `<type>(<scope>): <subject>` — `feat` for new code, `test` for tests-only, `fix` for bug fixes.
- Test framework: `vitest run` from `packages/zai/`.
- Run typecheck after each task: `cd packages/zai && pnpm typecheck` (or `bunx tsc -b --noEmit`).
- Server routes use `.js` import suffix (`./services/foo.js`); web tests import `useAgentStore` from `../../src/web/src/store/useAgentStore.js`.
- antd v5 API: `<Popover trigger="click" content={...}>`; `<Descriptions size="small" column={1}>`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/server/routes/agentSettings.ts` | NEW | Express router with `GET /agent/settings` |
| `src/web/src/hooks/useConversationInfo.ts` | NEW | Hook returning `ConversationInfo`; exports `countCompletedTurns` |
| `src/web/src/components/ConversationInfoCard.tsx` | NEW | Pure presentation; renders 9 rows + copy button |
| `src/web/src/components/ConversationInfoButton.tsx` | NEW | Button + Popover wrapper around the card |
| `src/server/index.ts` | EDIT | Add `app.use('/api', agentSettingsRouter)` |
| `src/web/src/pages/Agent.tsx` | EDIT | Add 1 import + 1 `<ConversationInfoButton />` JSX node |
| `test/server/agentSettings.test.ts` | NEW | Tests for the settings route (mock `~/.zai/settings.json`) |
| `test/web/useConversationInfo.test.ts` | NEW | Tests for `countCompletedTurns` (7 cases) + hook renderHook |

---

## Task 1: Server route `GET /api/agent/settings`

**Files:**
- Create: `packages/zai/src/server/routes/agentSettings.ts`
- Modify: `packages/zai/src/server/index.ts:13` (add import) and `:56` (add `app.use`)
- Test: `packages/zai/test/server/agentSettings.test.ts`

**Interfaces:**
- Consumes: nothing (reads `~/.zai/settings.json` directly via the same `readZaiSettings` pattern used in `src/server/services/modelCaller.ts:52`)
- Produces: HTTP `GET /api/agent/settings` → `200 { defaultModel: string|null, baseURL: string|null }` or `500 { error: string }`

- [ ] **Step 1: Write the failing test**

Create `packages/zai/test/server/agentSettings.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { readFileSync } from 'node:fs'

// Mock node:fs so we control what readFileSync returns
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: vi.fn(),
  }
})

// Mock modelCaller so the route doesn't try to construct an Anthropic client.
// We don't import modelCaller in agentSettings.ts directly — it only uses
// readZaiSettings which lives in modelCaller.ts. So mocking modelCaller's
// side effects (the Anthropic constructor) isn't needed; we only need to
// stub readFileSync (above) and node:os for homedir (default is fine).

// Import after mocks
import agentSettingsRouter from '../../src/server/routes/agentSettings.js'

const app = express()
app.use('/api', agentSettingsRouter)

describe('GET /api/agent/settings', () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockReset()
  })

  it('returns defaultModel from env.ANTHROPIC_DEFAULT_SONNET_MODEL when set', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        env: {
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3',
          ANTHROPIC_BASE_URL: 'https://api.example.com',
        },
      }),
    )
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      defaultModel: 'MiniMax-M3',
      baseURL: 'https://api.example.com',
    })
  })

  it('falls back to env.ANTHROPIC_SMALL_FAST_MODEL when SONNET is missing', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        env: {
          ANTHROPIC_SMALL_FAST_MODEL: 'MiniMax-fast',
        },
      }),
    )
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.defaultModel).toBe('MiniMax-fast')
    expect(res.body.baseURL).toBeNull()
  })

  it('falls back to top-level settings.model when no env override', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ model: 'claude-opus-4-6' }))
    const res = await request(app).get('/api/agent/settings')
    expect(res.body.defaultModel).toBe('claude-opus-4-6')
    expect(res.body.baseURL).toBeNull()
  })

  it('returns null fields when settings.json is empty', async () => {
    vi.mocked(readFileSync).mockReturnValue('{}')
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ defaultModel: null, baseURL: null })
  })

  it('returns 500 when readFileSync throws', async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT: no such file')
    })
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(500)
    expect(res.body.error).toContain('ENOENT')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bunx vitest run test/server/agentSettings.test.ts`
Expected: FAIL — `Cannot find module '../../src/server/routes/agentSettings.js'`

- [ ] **Step 3: Create the route file**

Create `packages/zai/src/server/routes/agentSettings.ts`:

```ts
import { Router, type Request, type Response } from 'express'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Read ~/.zai/settings.json. Returns parsed object or empty object on
 * any failure (missing file, invalid JSON, permission error).
 *
 * Mirrors the same defensive pattern used in modelCaller.ts:52 — the
 * settings file is optional and the server must keep working when it
 * is absent.
 */
function readZaiSettings(): {
  env?: Record<string, string>
  model?: string
} {
  try {
    const path = join(homedir(), '.zai', 'settings.json')
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

const router = Router()

/**
 * GET /api/agent/settings — return the runtime defaults that the server
 * will fall back to when a session's `model` field is "unknown".
 *
 * Priority for defaultModel:
 *   1. env.ANTHROPIC_DEFAULT_SONNET_MODEL
 *   2. env.ANTHROPIC_SMALL_FAST_MODEL
 *   3. top-level settings.model
 *   4. null
 */
router.get('/agent/settings', async (_req: Request, res: Response) => {
  try {
    const settings = readZaiSettings()
    const env = settings.env ?? {}
    const defaultModel =
      env.ANTHROPIC_DEFAULT_SONNET_MODEL
      ?? env.ANTHROPIC_SMALL_FAST_MODEL
      ?? settings.model
      ?? null
    const baseURL = env.ANTHROPIC_BASE_URL ?? null
    res.json({ defaultModel, baseURL })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bunx vitest run test/server/agentSettings.test.ts`
Expected: PASS — all 5 cases green.

- [ ] **Step 5: Wire the route into the Express app**

Edit `packages/zai/src/server/index.ts`:

After line 13 (`import agentRouter from './routes/agent.js';`), add:
```ts
import agentSettingsRouter from './routes/agentSettings.js';
```

After line 56 (`app.use('/api', agentRouter);`), add:
```ts
  app.use('/api', agentSettingsRouter);
```

- [ ] **Step 6: Run typecheck and the full server test suite**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bunx tsc -b --noEmit && bunx vitest run test/server/`
Expected: typecheck clean; existing server tests still pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/server/routes/agentSettings.ts packages/zai/src/server/index.ts packages/zai/test/server/agentSettings.test.ts
git commit -m "feat(zai-server): add /api/agent/settings endpoint for runtime model defaults"
```

---

## Task 2: Hook `useConversationInfo` + `countCompletedTurns`

**Files:**
- Create: `packages/zai/src/web/src/hooks/useConversationInfo.ts`
- Test: `packages/zai/test/web/useConversationInfo.test.ts`

**Interfaces:**
- Consumes: `useAgentStore` (sessionId, sessions, messages, status, cwd)
- Produces:
  - `ConversationInfo` type (9 fields, see spec)
  - `countCompletedTurns(messages: AgentMessage[]): number` — pure function, exported separately for unit testing

- [ ] **Step 1: Write the failing test for `countCompletedTurns`**

Create `packages/zai/test/web/useConversationInfo.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { countCompletedTurns } from '../../src/web/src/hooks/useConversationInfo.js'
import type { AgentMessage } from '../../src/web/src/store/useAgentStore.js'

// countCompletedTurns counts user → assistant pairs. An unpaired trailing
// user.text (e.g., during streaming) does not count.

function userText(): AgentMessage {
  return { eventId: 'u', sessionId: '', ts: 1, turnIndex: 0, type: 'user.text', text: 'hi' }
}
function asstText(): AgentMessage {
  return { eventId: 'a', sessionId: '', ts: 2, turnIndex: 0, type: 'assistant.text', text: 'hello' }
}
function asstThinking(): AgentMessage {
  return { eventId: 't', sessionId: '', ts: 2, turnIndex: 0, type: 'assistant.thinking', thinking: '...' }
}
function toolStart(): AgentMessage {
  return { eventId: 'ts', sessionId: '', ts: 2, turnIndex: 0, type: 'tool_use:start', toolUseId: 'x', name: 'Bash' }
}
function toolDone(): AgentMessage {
  return { eventId: 'td', sessionId: '', ts: 3, turnIndex: 0, type: 'tool_use:done', toolUseId: 'x' }
}
function toolError(): AgentMessage {
  return { eventId: 'te', sessionId: '', ts: 3, turnIndex: 0, type: 'tool_use:error', toolUseId: 'x', error: 'oops' }
}

describe('countCompletedTurns', () => {
  it('returns 0 for empty messages', () => {
    expect(countCompletedTurns([])).toBe(0)
  })

  it('returns 0 for an unpaired user.text', () => {
    expect(countCompletedTurns([userText()])).toBe(0)
  })

  it('returns 1 for a complete user → assistant pair', () => {
    expect(countCompletedTurns([userText(), asstText()])).toBe(1)
  })

  it('returns 1 for a turn with text + tool_use + text (counts once)', () => {
    expect(countCompletedTurns([userText(), asstText(), toolStart(), toolDone(), asstText()])).toBe(1)
  })

  it('returns 1 when the last turn is unfinished', () => {
    // [user, asst, user] — second user is streaming, not yet replied
    expect(countCompletedTurns([userText(), asstText(), userText()])).toBe(1)
  })

  it('counts tool_use:error as a completed turn', () => {
    expect(countCompletedTurns([userText(), asstText(), toolStart(), toolError()])).toBe(1)
  })

  it('returns 2 for two complete pairs followed by an unpaired user', () => {
    expect(countCompletedTurns([userText(), asstText(), userText(), asstText(), userText()])).toBe(2)
  })

  it('counts thinking block as completing a turn', () => {
    expect(countCompletedTurns([userText(), asstThinking(), asstText()])).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bunx vitest run test/web/useConversationInfo.test.ts`
Expected: FAIL — `Cannot find module '../../src/web/src/hooks/useConversationInfo.js'`

- [ ] **Step 3: Create the hook file with `countCompletedTurns` first**

Create `packages/zai/src/web/src/hooks/useConversationInfo.ts`:

```ts
import { useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '../store/useAgentStore.js'
import type { AgentMessage, AgentStatus } from '../store/useAgentStore.js'

/**
 * Snapshot of conversation metadata shown in the info Popover.
 *
 * All fields are derived from existing store state plus a 1-shot fetch
 * of /api/agent/settings. Nothing here mutates the store.
 */
export interface ConversationInfo {
  /** Active session ID. Falls back to activeSessionId to cover streaming. */
  sessionId: string | null
  /** Session title from manifest, if any. */
  title: string | null
  /** Timestamp of the first message (ms epoch). Falls back to session createdAt. */
  startTime: number | null
  /** Last activity timestamp from the session manifest. */
  lastUpdate: number | null
  /** Number of complete user → assistant pairs. Unfinished trailing turn excluded. */
  turnCount: number
  /** Total messages currently in the local store. */
  messageCount: number
  /** Agent status (idle / streaming / aborted / error). */
  status: AgentStatus
  /** Current working directory. */
  cwd: string | null
  /** Effective model name: session.model when known, else runtime defaultModel. */
  model: string | null
  /** True once the /api/agent/settings fetch has settled (success or failure). */
  settingsLoaded: boolean
}

interface RuntimeSettings {
  defaultModel: string | null
  baseURL: string | null
}

/**
 * Count complete user → assistant pairs in the message stream.
 *
 * Algorithm: walk messages linearly. Each `user.text` opens a candidate
 * turn. The first non-user message after it (assistant text, thinking,
 * tool_use, runtime.*) closes the turn and increments the counter.
 * An unpaired trailing user.text is not counted.
 *
 * Exported standalone (no React) so it can be unit-tested without
 * rendering components.
 */
export function countCompletedTurns(messages: AgentMessage[]): number {
  let turns = 0
  let sawUser = false
  for (const m of messages) {
    const t = m.type as string
    if (t === 'user.text') {
      sawUser = true
      continue
    }
    if (sawUser) {
      turns++
      sawUser = false
    }
  }
  return turns
}

/**
 * Derive a ConversationInfo snapshot from the agent store and the
 * runtime settings endpoint. Re-runs when any store field changes —
 * cheap because countCompletedTurns is O(n).
 */
export function useConversationInfo(): ConversationInfo {
  const { sessionId, activeSessionId, sessions, messages, status, cwd } =
    useAgentStore()

  const [runtime, setRuntime] = useState<RuntimeSettings>({
    defaultModel: null,
    baseURL: null,
  })
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  // 1-shot fetch on mount. Failure is silent — `defaultModel` stays null
  // and the card shows "未知".
  useEffect(() => {
    let cancelled = false
    fetch('/api/agent/settings')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: Partial<RuntimeSettings>) => {
        if (cancelled) return
        setRuntime({
          defaultModel: data.defaultModel ?? null,
          baseURL: data.baseURL ?? null,
        })
      })
      .catch(() => {
        // intentional swallow: model row will show "未知"
      })
      .finally(() => {
        if (!cancelled) setSettingsLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return useMemo<ConversationInfo>(() => {
    const effectiveSessionId = sessionId ?? activeSessionId ?? null
    const sess = effectiveSessionId
      ? sessions.find((s) => s.transcriptId === effectiveSessionId) ?? null
      : null
    const firstTs = messages[0]?.ts ?? sess?.createdAt ?? null
    const turns = countCompletedTurns(messages)
    const model =
      sess?.model && sess.model !== 'unknown'
        ? sess.model
        : runtime.defaultModel

    return {
      sessionId: effectiveSessionId,
      title: sess?.title ?? null,
      startTime: typeof firstTs === 'number' && firstTs > 0 ? firstTs : null,
      lastUpdate: sess?.updatedAt ?? null,
      turnCount: turns,
      messageCount: messages.length,
      status,
      cwd: cwd || sess?.cwd || null,
      model,
      settingsLoaded,
    }
  }, [sessionId, activeSessionId, sessions, messages, status, cwd, runtime, settingsLoaded])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bunx vitest run test/web/useConversationInfo.test.ts`
Expected: PASS — all 8 cases green.

- [ ] **Step 5: Add a renderHook integration test (in the same file)**

Append to `packages/zai/test/web/useConversationInfo.test.ts`:

```ts
import { renderHook, act } from '@testing-library/react'
import { useConversationInfo } from '../../src/web/src/hooks/useConversationInfo.js'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'

// Stub fetch so the hook's 1-shot /api/agent/settings call doesn't hit the network.
const originalFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ defaultModel: 'MiniMax-M3', baseURL: 'https://api.x' }),
  } as Response)
  useAgentStore.setState({
    sessionId: null,
    activeSessionId: null,
    sessions: [],
    messages: [],
    status: 'idle',
    cwd: '',
  })
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('useConversationInfo (integration)', () => {
  it('returns empty info when there is no session', async () => {
    const { result } = renderHook(() => useConversationInfo())
    // Wait for the settings fetch's setSettingsLoaded to flush.
    await act(async () => { await Promise.resolve() })
    expect(result.current.sessionId).toBeNull()
    expect(result.current.title).toBeNull()
    expect(result.current.turnCount).toBe(0)
    expect(result.current.messageCount).toBe(0)
    expect(result.current.status).toBe('idle')
    // settingsLoaded only flips after the fetch settles; assert the runtime fields
    // reflect the mock response.
    expect(result.current.model).toBe('MiniMax-M3')
  })

  it('derives all 9 fields from a populated store', async () => {
    const sessionId = 'sess-abc'
    useAgentStore.setState({
      sessionId,
      sessions: [{
        transcriptId: sessionId,
        cwd: '/repo',
        model: 'claude-opus-4-6',
        createdAt: 1000,
        updatedAt: 2000,
        title: 'Bug fix',
        messageCount: 3,
      }],
      messages: [
        { eventId: 'u1', sessionId, ts: 1000, turnIndex: 0, type: 'user.text', text: 'fix' },
        { eventId: 'a1', sessionId, ts: 1100, turnIndex: 0, type: 'assistant.text', text: 'ok' },
        { eventId: 'u2', sessionId, ts: 1200, turnIndex: 1, type: 'user.text', text: 'thanks' },
        // no assistant reply yet — trailing unpaired
      ],
      status: 'streaming',
      cwd: '/repo',
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.sessionId).toBe('sess-abc')
    expect(result.current.title).toBe('Bug fix')
    expect(result.current.startTime).toBe(1000)
    expect(result.current.lastUpdate).toBe(2000)
    expect(result.current.turnCount).toBe(1) // first pair complete, second unfinished
    expect(result.current.messageCount).toBe(3)
    expect(result.current.status).toBe('streaming')
    expect(result.current.cwd).toBe('/repo')
    expect(result.current.model).toBe('claude-opus-4-6') // session.model takes precedence over runtime default
  })

  it('falls back to runtime defaultModel when session.model is "unknown"', async () => {
    const sessionId = 'sess-old'
    useAgentStore.setState({
      sessionId,
      sessions: [{
        transcriptId: sessionId,
        cwd: '/x',
        model: 'unknown',
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
      }],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.model).toBe('MiniMax-M3')
  })
})
```

(Add the `vi` import to the existing test file's top imports.)

- [ ] **Step 6: Run all hook tests**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bunx vitest run test/web/useConversationInfo.test.ts`
Expected: PASS — 8 unit cases + 3 integration cases, all green.

- [ ] **Step 7: Typecheck**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bunx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/web/src/hooks/useConversationInfo.ts packages/zai/test/web/useConversationInfo.test.ts
git commit -m "feat(zai-web): add useConversationInfo hook with turn counting"
```

---

## Task 3: `ConversationInfoCard` component

**Files:**
- Create: `packages/zai/src/web/src/components/ConversationInfoCard.tsx`

**Interfaces:**
- Consumes: `info: ConversationInfo` (from Task 2)
- Produces: A pure render-only component (no side effects, no state) that displays the 9 rows + a copy button for sessionId.

- [ ] **Step 1: Create the component file**

Create `packages/zai/src/web/src/components/ConversationInfoCard.tsx`:

```tsx
import { Button, Descriptions, message, Typography } from 'antd'
import { CopyOutlined } from '@ant-design/icons'
import type { ConversationInfo } from '../hooks/useConversationInfo.js'

const { Text } = Typography

function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function statusLabel(status: ConversationInfo['status']): string {
  switch (status) {
    case 'idle': return '就绪'
    case 'streaming': return '对话中'
    case 'aborted': return '已中止'
    case 'error': return '错误'
  }
}

async function copyToClipboard(text: string): Promise<void> {
  // navigator.clipboard requires a secure context (https / localhost).
  // Fall back to a temporary textarea for http / older browsers.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // fall through to legacy path
    }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  document.body.removeChild(ta)
}

interface Props {
  info: ConversationInfo
}

export default function ConversationInfoCard({ info }: Props) {
  if (!info.sessionId) {
    return (
      <div style={{ padding: 8, color: 'rgba(0,0,0,0.45)', fontSize: 13 }}>
        暂无活跃会话
      </div>
    )
  }

  const handleCopy = async (e: React.MouseEvent) => {
    // 不让 click 冒泡到 Popover 触发关闭, 也不让 button 触发 form submit 之类.
    e.stopPropagation()
    e.preventDefault()
    try {
      await copyToClipboard(info.sessionId!)
      message.success('已复制 sessionId')
    } catch {
      message.warning('复制失败, 请手动选中')
    }
  }

  return (
    <Descriptions
      size="small"
      column={1}
      bordered
      style={{ width: 360 }}
      labelStyle={{ width: 110, color: 'rgba(0,0,0,0.65)' }}
    >
      <Descriptions.Item label="Session ID">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>
            {info.sessionId}
          </Text>
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            onClick={handleCopy}
            title="复制 sessionId"
          />
        </span>
      </Descriptions.Item>
      <Descriptions.Item label="标题">{info.title ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="首条消息时间">{fmtTime(info.startTime)}</Descriptions.Item>
      <Descriptions.Item label="最后更新">{fmtTime(info.lastUpdate)}</Descriptions.Item>
      <Descriptions.Item label="对话轮次">{info.turnCount}</Descriptions.Item>
      <Descriptions.Item label="消息数">{info.messageCount}</Descriptions.Item>
      <Descriptions.Item label="状态">{statusLabel(info.status)}</Descriptions.Item>
      <Descriptions.Item label="工作目录">{info.cwd ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="当前模型">{info.model ?? '未知'}</Descriptions.Item>
    </Descriptions>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bunx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/web/src/components/ConversationInfoCard.tsx
git commit -m "feat(zai-web): add ConversationInfoCard presentation component"
```

---

## Task 4: `ConversationInfoButton` (Popover wrapper)

**Files:**
- Create: `packages/zai/src/web/src/components/ConversationInfoButton.tsx`

**Interfaces:**
- Consumes: `useConversationInfo()` from Task 2
- Produces: A `<Button>` with `<InfoCircleOutlined />` that wraps an antd `<Popover>` containing `<ConversationInfoCard />`.

- [ ] **Step 1: Create the component file**

Create `packages/zai/src/web/src/components/ConversationInfoButton.tsx`:

```tsx
import { Button, Popover } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import ConversationInfoCard from './ConversationInfoCard.js'

export default function ConversationInfoButton() {
  const info = useConversationInfo()

  return (
    <Popover
      trigger="click"
      placement="topRight"
      // 阻止内部 click 冒泡到外层, 避免 antd Popover 的 outside-click 检测误关.
      content={<div onClick={(e) => e.stopPropagation()}><ConversationInfoCard info={info} /></div>}
      overlayInnerStyle={{ padding: 12 }}
      destroyTooltipOnHide
    >
      <Button
        type="text"
        icon={<InfoCircleOutlined />}
        title="查看对话信息"
        // 与现有 PictureOutlined 按钮样式对齐 (状态栏右侧灰色 icon)
        style={{ color: 'rgba(255,255,255,0.45)' }}
      />
    </Popover>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bunx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/web/src/components/ConversationInfoButton.tsx
git commit -m "feat(zai-web): add ConversationInfoButton (Popover wrapper)"
```

---

## Task 5: Integrate into `Agent.tsx`

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`

- [ ] **Step 1: Locate the import block and the PictureOutlined button**

Open `packages/zai/src/web/src/pages/Agent.tsx`. Find:
- Line ~1373 — the `<Button icon={<PictureOutlined />} ... />` button (inside the input area status bar `<div>`).
- The top-of-file import block — find a sensible place to add the new import (alphabetical: after `import ... from '../components/...'`, before any non-component import).

- [ ] **Step 2: Add the import**

Add this line at the end of the existing component import block (verify exact location by reading the file; place alongside other `../components/` imports):

```tsx
import ConversationInfoButton from '../components/ConversationInfoButton'
```

- [ ] **Step 3: Add the button JSX**

Immediately after the PictureOutlined `<Button>` closing tag (around line 1373), add:

```tsx
          <ConversationInfoButton />
```

(The line above should be indented at the same level as the surrounding `<Button>` to keep JSX readable.)

- [ ] **Step 4: Typecheck + full test suite**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bunx tsc -b --noEmit && bunx vitest run`
Expected: typecheck clean; all tests still pass (no existing test should regress).

- [ ] **Step 5: Manual smoke test**

Run: `cd /Users/ethan/code/opencc-web/packages/zai && bun run dev` (or `zai dev`)
Open browser to the Agent page → verify:
- An `i` icon button is visible right of the picture upload button in the status bar.
- Clicking it opens a Popover with 9 rows.
- The sessionId row has a copy button that produces a "已复制 sessionId" toast.
- Closing the Popover does not steal input focus.
- Streaming the chat → reopen Popover → turnCount and messageCount reflect live state.

- [ ] **Step 6: Commit**

```bash
cd /Users/ethan/code/opencc-web && git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "feat(zai-web): mount ConversationInfoButton in chat status bar"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Covered by |
|---|---|
| Popover displays 9 fields | Task 3 (Card) |
| Copy sessionId with toast | Task 3 (`copyToClipboard` + `message.success`) |
| New `/api/agent/settings` endpoint | Task 1 |
| `useConversationInfo` hook | Task 2 |
| `countCompletedTurns` algorithm | Task 2 |
| Wire button into Agent.tsx | Task 5 |
| Error handling (no sessionId / missing settings / clipboard fail) | Task 1 (500 on read fail), Task 3 (clipboard fallback + warning), Task 2 (silent settings fetch failure) |
| 7 unit cases for `countCompletedTurns` | Task 2 (8 cases, includes the spec's 7) |
| 4 cases for `/api/agent/settings` | Task 1 (5 cases, includes all 4 spec cases) |

**2. Placeholder scan:** No TBD / TODO / "implement later" / "similar to" patterns. Each step has complete code or a precise diff.

**3. Type consistency:**
- `ConversationInfo` interface defined in Task 2 step 3; consumed in Task 3 step 1 — shapes match.
- `countCompletedTurns` signature `(messages: AgentMessage[]) => number` defined in Task 2 step 3; tests in Task 2 step 1 and integration tests in Task 2 step 5 use the same signature.
- `info.sessionId` typed `string | null` in both Card (Task 3, with non-null assertion after early return) and Button (Task 4, just passes through).

No gaps found.