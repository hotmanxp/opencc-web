# Conversation Info Button — Design

**Date:** 2026-07-13
**Status:** Draft (pending user review)
**Author:** brainstorming session

## Goal

Add an `i` icon button next to the existing image upload button on the chat page. Clicking it opens a Popover card showing conversation metadata — most importantly the `sessionId` for debugging.

## Scope

- New icon button in the input area status bar (right side, next to `<PictureOutlined />`).
- Popover displays 9 fields (see "Card content" below).
- New `/api/agent/settings` endpoint returns runtime defaults (model / baseURL) since `session.model` is hard-coded to `'unknown'` at session creation (`agent.ts:401`).
- Helper hook `useConversationInfo` derives all fields from existing store state + the new endpoint response.

Out of scope: editing any of the displayed fields, exporting transcript, sharing links. (YAGNI.)

## Architecture

```
┌─ Agent.tsx (input area)
│   <PictureOutlined /> 上传图片
│   <InfoCircleOutlined /> 点击弹 Popover   ← 新增
│
└─ ConversationInfoButton.tsx
    ├─ trigger: antd Popover, trigger="click"
    ├─ content: <ConversationInfoCard info={...} />
    └─ data:
        ├─ useAgentStore → sessionId / messages / status / cwd / sessions
        └─ useConversationInfo() hook → 派生所有字段
            └─ GET /api/agent/settings → 运行时 model / baseURL

┌─ Server (agentSettings.ts)
│   GET /api/agent/settings
│   └─ read ~/.zai/settings.json → { defaultModel, baseURL }
└─ mounted from server/index.ts alongside agent.ts
```

Data layer = hook derivation + 1-shot settings fetch.
Presentation layer = 1 button component + 1 card component.

## Files

### New files (5)

| Path | Purpose |
|---|---|
| `packages/zai/src/web/src/components/ConversationInfoButton.tsx` | Button + Popover wrapper (~80 行) |
| `packages/zai/src/web/src/components/ConversationInfoCard.tsx` | Pure presentation card with Descriptions + copy button (~110 行) |
| `packages/zai/src/web/src/hooks/useConversationInfo.ts` | Derives `ConversationInfo`; exports `countCompletedTurns` for unit testing (~60 行) |
| `packages/zai/src/server/routes/agentSettings.ts` | `GET /api/agent/settings` (~40 行) |
| `packages/zai/test/web/useConversationInfo.test.ts` | Unit tests for `countCompletedTurns` + integration render check |
| `packages/zai/test/server/agentSettings.test.ts` | Unit tests for the new route (mock settings.json read) |

### Edited files (2)

| Path | Change |
|---|---|
| `packages/zai/src/web/src/pages/Agent.tsx` | Add 1 import + 1 `<ConversationInfoButton />` line at `Agent.tsx:1373` (immediately after the PictureOutlined Button) |
| `packages/zai/src/server/index.ts` | Add `app.use('/api', agentSettingsRouter)` (or equivalent mount point — verify by reading current router registration) |

## Card content (Popover body)

Rendered as antd `<Descriptions size="small" column={1}>`:

| Label | Value source | Fallback |
|---|---|---|
| **Session ID** | `useAgentStore.sessionId`（fallback `activeSessionId`，覆盖 streaming 期间差异） | "暂无活跃会话" 全卡降级 |
| 标题 | `sessions.find(s.transcriptId === sessionId)?.title` | `—` |
| 首条消息时间 | `messages[0]?.ts` | `sess?.createdAt` → `—` |
| 最后更新时间 | `sess?.updatedAt` | `—` |
| 对话轮次 | `countCompletedTurns(messages)` | 0 |
| 消息数 | `messages.length` | 0 |
| 当前状态 | `useAgentStore.status` | "idle" |
| 工作目录 (cwd) | `useAgentStore.cwd \|\| sess?.cwd` | `—` |
| 当前模型 | `sess?.model !== 'unknown' ? sess.model : runtime.defaultModel` | "未知" |

Session ID row also has a `<CopyOutlined />` button → `navigator.clipboard.writeText` + antd `message.success('已复制 sessionId')`.

### `countCompletedTurns` algorithm

Scan `messages[]` linearly:
- Each `user.text` sets a flag `sawUser = true`.
- Any non-user message while `sawUser` increments `turns` and clears `sawUser`.
- An unpaired trailing `user.text` is not counted.

This counts "complete user → assistant pairs" and excludes the in-progress last turn.

## Data flow on Popover open

```
mount  →  useEffect → fetch /api/agent/settings (1 time)
              ↓ failure: silent, model field falls back to "未知"
open Popover
              ↓
        useConversationInfo() re-runs useMemo
              ├─ sessionId = store.sessionId
              ├─ sess = sessions.find(...)
              ├─ firstTs = messages[0]?.ts ?? sess?.createdAt
              ├─ turns  = countCompletedTurns(messages)
              └─ model  = sess?.model && sess.model !== 'unknown'
                          ? sess.model : runtime.defaultModel
              ↓
        ConversationInfoCard renders
              ↓
        user clicks CopyOutlined
              ↓
        navigator.clipboard.writeText(sessionId)
              ↓ success → message.success('已复制 sessionId')
              ↓ failure → message.warning('复制失败, 请手动选中')
```

## Error handling matrix

| Scenario | Behavior |
|---|---|
| No `sessionId` (new empty session) | Card shows gray "暂无活跃会话" placeholder; other rows hidden |
| `sessions` does not contain current `sessionId` | startTime/cwd/title fall back to `—`; other fields unaffected |
| `messages[0]` has no `ts` | Fall back to `sess?.createdAt`, then `—` |
| `/api/agent/settings` fetch fails | `runtime` stays `null`; model row shows "未知" |
| `navigator.clipboard` unavailable (old browser / http) | try/catch around writeText; show `message.warning` to manual-copy |
| Popover closes then reopens | No re-fetch (state preserved); only `useMemo` re-runs |
| Popover open during streaming | Live updates: `status` / `turnCount` / `messageCount` re-derive on each store change |

## Invariants

- Opening the Popover triggers no backend side effects beyond the 1-time settings fetch (failure silent).
- Popover does not steal input focus — antd's default focus-restore on close is preserved.
- Copy button does not close the Popover (`e.stopPropagation()` + `e.preventDefault()`).
- No new store fields. `useAgentStore` is read-only for this feature.

## Testing

### `useConversationInfo.test.ts`

| Case | Input | Expected |
|---|---|---|
| Empty | `[]` | 0 |
| Only user.text | `[user.text]` | 0 (unfinished) |
| Complete pair | `[user.text, assistant.text]` | 1 |
| Multi-message turn | `[user, asst.text, tool_use, asst.text]` | 1 |
| Unfinished last turn | `[user, asst.text, user]` | 1 |
| Tool error ends turn | `[user, asst.text, tool_use:error]` | 1 |
| Multiple complete pairs | `[user, asst, user, asst, user]` | 2 |

Plus 1 integration test: render the hook with a mock store, assert all 9 `ConversationInfo` fields.

### `agentSettings.test.ts`

| Case | Mock input | Expected response |
|---|---|---|
| `env.ANTHROPIC_DEFAULT_SONNET_MODEL` set | `{ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3', ANTHROPIC_BASE_URL: 'https://x' } }` | `{ defaultModel: 'MiniMax-M3', baseURL: 'https://x' }` |
| No env, top-level `model` set | `{ model: 'claude-opus' }` | `{ defaultModel: 'claude-opus', baseURL: null }` |
| Empty settings | `{}` | `{ defaultModel: null, baseURL: null }` |
| Settings file missing | readFile throws | 500 + error message (matches existing `/agent/sessions` behavior) |

### Manual smoke (not automated)

Open browser → click `i` icon → verify card content. Visual review covers the antd Descriptions + Popover styling, which is hard to assert without browser.

## Risks

1. **`session.model` is `'unknown'` for sessions created before this feature ships.**  → Mitigated by the runtime fallback to `defaultModel`.
2. **`messages[0].ts` may be 0 or undefined in degenerate cases.**  → Fallback chain (`ts → createdAt → —`).
3. **Clipboard API gated by secure context (https / localhost).**  → try/catch + warning fallback.
4. **`server/index.ts` router registration may not be in a single file.**  → Discover during implementation; add the route wherever other `agent.*` routes are mounted.

## Open questions

None — all clarifications resolved in brainstorming.