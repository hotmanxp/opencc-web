# zai Clickable Model Switcher Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the model badge in the zai-web chat status bar clickable so users can pick a different model for the active session, with the choice persisted in the session's transcript and new sessions retaining the default model resolution chain.

**Architecture:** OpenCC-inspired layered model resolution + per-session override. Server reads `transcript.meta.model` and threads it through `runtime.run({ model })` (already supported by zai-agent-core's `queryLoop`). Settings file gets a `models[]` alias table that powers the picker UI; the picked alias is resolved to a full model ID and written back to `transcript.meta.model`. Existing sessions with `meta.model === 'unknown'` (or missing) keep falling through to the env/settings/default chain — no migration needed.

**Tech Stack:** Express + zod (server), React + antd Popover + zustand (client), vitest + supertest + @testing-library/react.

---

## Global Constraints

- **Model list source:** `~/.zai/settings.json` gets a new top-level `models: ModelEntry[]`. The Picker UI is driven exclusively by this array — no hardcoded model list anywhere in the codebase.
- **Persistence format:** `transcript.meta.model` always stores the **resolved full model name** (e.g. `"MiniMax-M3"`), never the alias. Aliases are a presentation concern only.
- **New-session default resolution:** new sessions (via `POST /api/agent/sessions`) keep writing `model: 'unknown'` as a placeholder. `'unknown'` (or null/missing) is treated as "not specified" by `resolveModel` and falls through to the chain.
- **Existing session compatibility:** all sessions created before this change have `meta.model === 'unknown'` or no `meta.model`. `resolveModel` treats both identically — no migration needed.
- **UI styling:** Popover follows the same pattern as `ConversationInfoButton` (click trigger, `placement="topRight"`, `destroyTooltipOnHide`, content wrapped in `<div onClick={stopPropagation}>` to avoid outside-click dismissal).
- **No global default override:** switching a session's model does NOT modify `~/.zai/settings.json → settings.model`. New sessions keep their env/settings-based default.

---

## Resolution chain (per-turn)

For every `/agent/prompt` request, the server resolves the effective model in this order:

| Layer | Source | `resolveModel` `source` tag |
|---|---|---|
| 1 | `transcript.meta.model` (only if not `'unknown'`) | `session` |
| 2 | `env.ANTHROPIC_DEFAULT_SONNET_MODEL` | `env_default_sonnet` |
| 3 | `env.ANTHROPIC_SMALL_FAST_MODEL` | `env_small_fast` |
| 4 | `settings.model` | `settings_model` |
| 5 | Built-in fallback | `builtin_fallback` (always returns `"MiniMax-M3"`) |

The result of layer 5 is non-null by construction, so callers can treat the resolved model as always-defined.

---

## settings.json schema

```ts
// src/shared/settings.ts (NEW file, shared by server + client)

export interface ModelEntry {
  /** Short identifier used in the picker UI. Required. */
  alias: string
  /** Full model ID sent to the upstream API. Required. */
  model: string
  /** Display label (picker list item primary text). Defaults to `alias` if omitted. */
  label?: string
  /** Description (picker list item secondary text). Optional. */
  description?: string
}

export interface ZaiSettings {
  env?: Record<string, string>
  /** Global default (resolution chain layer 4). */
  model?: string
  /** Alias table powering the picker UI. Optional. */
  models?: ModelEntry[]
}
```

Example:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_BASE_URL": "https://api.minimax.com/v1"
  },
  "model": "MiniMax-M3",
  "models": [
    { "alias": "M3",    "model": "MiniMax-M3",            "label": "M3 · 默认最强" },
    { "alias": "haiku", "model": "MiniMax-M2.7-highspeed", "label": "M2.7 · 快速轻量", "description": "日常对话首选" }
  ]
}
```

---

## Server changes

### `src/server/lib/resolveModel.ts` (NEW)

```ts
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ResolveModelInput {
  sessionModel: string | null | undefined
  cwd: string
}

export interface ResolveModelResult {
  model: string
  source: 'session' | 'env_default_sonnet' | 'env_small_fast' | 'settings_model' | 'builtin_fallback'
}

export const BUILTIN_FALLBACK_MODEL = 'MiniMax-M3'

function readZaiSettings(): { env?: Record<string, string>; model?: string } {
  try {
    const p = join(homedir(), '.zai', 'settings.json')
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch (err) {
    if (err instanceof SyntaxError) return {}
    throw err
  }
}

export function resolveModel(input: ResolveModelInput): ResolveModelResult {
  if (input.sessionModel && input.sessionModel !== 'unknown') {
    return { model: input.sessionModel, source: 'session' }
  }
  const settings = readZaiSettings()
  const env = settings.env ?? {}
  if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return { model: env.ANTHROPIC_DEFAULT_SONNET_MODEL, source: 'env_default_sonnet' }
  }
  if (env.ANTHROPIC_SMALL_FAST_MODEL) {
    return { model: env.ANTHROPIC_SMALL_FAST_MODEL, source: 'env_small_fast' }
  }
  if (settings.model) {
    return { model: settings.model, source: 'settings_model' }
  }
  return { model: BUILTIN_FALLBACK_MODEL, source: 'builtin_fallback' }
}
```

### `src/server/routes/agentSettings.ts` (MODIFIED)

Existing `GET /api/agent/settings` endpoint extended:

```ts
import { resolveModel } from '../lib/resolveModel.js'

router.get('/agent/settings', async (_req, res) => {
  try {
    const settings = readZaiSettings()  // extended to also return `models: ModelEntry[]`
    const env = settings.env ?? {}
    const { model: defaultModel } = resolveModel({ sessionModel: null, cwd: '' })
    const baseURL = env.ANTHROPIC_BASE_URL ?? null
    res.json({
      defaultModel,
      baseURL,
      models: settings.models ?? [],
    })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

The shared `ZaiSettings` shape lives in `src/shared/settings.ts`; both server (`agentSettings.ts`, `resolveModel.ts`) and client (`useConversationInfo.ts`) import from it.

### `src/server/routes/agent.ts` (MODIFIED)

Two changes:

1. **POST `/agent/prompt`** — resolve the model from `transcript.meta.model` and pass to `runtime.run`:

```ts
let sessionModel: string | null = null
try {
  const existing = await getTranscriptStore().read(sessionId)
  sessionModel = existing.meta.model ?? null
} catch {
  // New session / no transcript yet — sessionModel stays null → fall through
}

const { model: resolvedModel, source: modelSource } = resolveModel({
  sessionModel,
  cwd,
})

if (process.env.ZAI_DEBUG === '1') {
  console.error('[zai.agent.prompt] resolved model', { sessionId, modelSource, resolvedModel })
}

const events = getRuntime().run({
  prompt: promptArg,
  cwd,
  transcriptId: sessionId,
  systemPrompt,
  abortSignal: abortController.signal,
  model: resolvedModel,
})
```

2. **NEW PATCH `/agent/sessions/:id`** — accepts `{ model }`, writes to transcript meta:

```ts
const PatchSessionRequest = z.object({
  model: z.string().min(1).max(256).optional(),
})

router.patch('/agent/sessions/:id', async (req, res) => {
  const parsed = PatchSessionRequest.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body' })
  }
  const sid = req.params.id
  try {
    const store = getTranscriptStore()
    if (parsed.data.model && parsed.data.model !== 'unknown') {
      await store.patch(sid, { model: parsed.data.model })
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

POST `/api/agent/sessions` (new session creation) keeps writing `model: 'unknown'` — no change.

### `src/server/services/agentRuntime.ts`

No change. Existing `defaultModel` env fallback at line 62-64 is kept as the catch-all for non-`/agent/prompt` callers of `runtime.run()`. The new `resolveModel` runs *before* `runtime.run()` in the prompt path, so per-session model takes priority over the runtime-wide default.

### Integration verification

`zai-agent-core/dist/runtime/queryLoop.js:73` confirms `model: options.model ?? config.defaultModel ?? 'default'`. Threading `model` through `runtime.run({ model })` already flows to the modelCaller. **No zai-agent-core change required.**

---

## Client changes

### `src/shared/settings.ts` (NEW — same file imported by both server and client)

Already described above. Both server routes and client hook import the same `ZaiSettings` / `ModelEntry` types.

### `src/web/src/store/useAgentStore.ts` (MODIFIED)

```ts
import type { ModelEntry } from '../../../shared/settings.js'

interface Session {
  transcriptId: string
  title?: string
  updatedAt: number
  model?: string       // NEW — synced from transcript.meta.model
  cwd?: string
  createdAt?: number
}

interface AgentState {
  // ... existing fields
  availableModels: ModelEntry[]              // NEW — synced from /api/agent/settings
  patchSessionModel: (sid: string, model: string) => Promise<void>  // NEW
}

// In store impl:
availableModels: [],
patchSessionModel: async (sid, model) => {
  // Optimistic local update
  const prev = get().sessions
  set({
    sessions: prev.map((x) => (x.transcriptId === sid ? { ...x, model } : x)),
  })
  try {
    const token = localStorage.getItem('zai-token') || ''
    const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sid)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Zai-Token': token },
      body: JSON.stringify({ model }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch {
    // Revert
    set({ sessions: prev })
    // Surface to user via message (imported from antd) — or noop if already showing
  }
},
```

`loadSessions` is extended to populate `availableModels`: in addition to fetching `/api/agent/sessions`, it parallel-fetches `/api/agent/settings` and stores `data.models ?? []` into `availableModels`. Failure of the settings fetch is silent (existing pattern in `loadSessions`); `availableModels` stays `[]` and the Popover shows the "未配置 models[]" placeholder.

### `src/web/src/hooks/useConversationInfo.ts` (MODIFIED)

Add an alias-resolution helper and surface the resolved display label:

```ts
import type { ModelEntry } from '../../../shared/settings.js'

function findAliasForModel(model: string | null, models: ModelEntry[]): ModelEntry | null {
  if (!model) return null
  return models.find((m) => m.model === model) ?? null
}

// Inside useConversationInfo, after parsing `runtime` from /api/agent/settings:
const alias = findAliasForModel(model, runtime.models)
const displayLabel = alias?.label ?? alias?.alias ?? model

return {
  // ... existing fields
  displayLabel,         // NEW — alias-aware display text
}
```

### `src/web/src/components/ModelStatusButton.tsx` (NEW — replaces ModelStatusBadge.tsx)

```tsx
import { Button, Popover } from 'antd'
import { CheckOutlined } from '@ant-design/icons'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import { useAgentStore } from '../store/useAgentStore.js'

export default function ModelStatusButton() {
  const { displayLabel, model, sessionId } = useConversationInfo()
  const models = useAgentStore((s) => s.availableModels)
  const patchSessionModel = useAgentStore((s) => s.patchSessionModel)

  const content = (
    <div style={{ width: 280 }}>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginBottom: 8 }}>
        切换当前会话的模型
      </div>
      {models.length === 0 && (
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
          ~/.zai/settings.json 未配置 models[]
        </div>
      )}
      {models.map((m) => {
        const isCurrent = m.model === model
        return (
          <div
            key={m.alias}
            onClick={() => {
              if (isCurrent || !sessionId) return
              void patchSessionModel(sessionId, m.model)
            }}
            style={{
              padding: '6px 8px',
              borderRadius: 4,
              cursor: isCurrent ? 'default' : 'pointer',
              background: isCurrent ? 'rgba(22,119,255,0.15)' : 'transparent',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#fff', fontWeight: isCurrent ? 600 : 400 }}>
                {m.label ?? m.alias}
              </span>
              {isCurrent && <CheckOutlined style={{ color: '#1677ff', fontSize: 12 }} />}
            </div>
            {m.description && (
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
                {m.description}
              </span>
            )}
          </div>
        )
      })}
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.30)', marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 6 }}>
        仅作用于当前会话. 新建会话仍按 ~/.zai/settings.json 解析.
      </div>
    </div>
  )

  return (
    <Popover
      content={<div onClick={(e) => e.stopPropagation()}>{content}</div>}
      trigger="click"
      placement="topRight"
      destroyTooltipOnHide
    >
      <Button
        type="text"
        size="small"
        title={`当前模型: ${displayLabel ?? '未知'}\n点击切换`}
        style={{
          color: model ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.30)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        }}
      >
        {displayLabel ?? '未知'}
      </Button>
    </Popover>
  )
}
```

`ModelStatusBadge.tsx` is **deleted**; `Agent.tsx` is updated to import `ModelStatusButton` instead. Position in the status bar (input-area bottom bar) is unchanged.

### `src/web/src/pages/Agent.tsx`

Single-line import swap: `<ModelStatusBadge />` → `<ModelStatusButton />`. No layout change.

---

## Error handling

| Failure | Behavior |
|---|---|
| `~/.zai/settings.json` missing or invalid | `models[]` returns `[]`; Popover shows "未配置 models[]" placeholder. `resolveModel` falls through to `MiniMax-M3`. |
| PATCH `/api/agent/sessions/:id` returns non-2xx | Optimistic local `sessions[i].model` reverts; popover remains open so user can retry. No toast in v1 (YAGNI). |
| User clicks the current model | No-op (early return in onClick). |
| User clicks a model without an active session (`sessionId === null`) | No-op (early return). |
| `transcript.meta.model` contains an alias (e.g. user manually edited it) | `resolveModel` passes it through unchanged. If the alias is not a valid model ID, Anthropic SDK will reject with a 4xx; surface the error via existing `runtime.error` event handling. Not a v1 concern. |

---

## Testing strategy

| File | Tests |
|---|---|
| `test/server/resolveModel.test.ts` (NEW) | 6 cases: `sessionModel='M3'` returns `M3`/session; `sessionModel='unknown'` → env chain; `sessionModel=null` → env chain; env empty → settings.model; settings empty → builtin fallback; `sessionModel=''` → env chain (empty string treated as not-specified) |
| `test/server/routes-agent.test.ts` (EXTENDED) | 4 PATCH cases: success writes meta.model; invalid body → 400; missing session → 500; `model: 'unknown'` rejected (no-op) |
| `test/server/agentSettings.test.ts` (EXTENDED) | Existing 5 cases still pass; new case: GET returns `models: []` when settings.json omits it |
| `test/web/useConversationInfo.test.ts` (EXTENDED) | Existing 11 cases pass; new alias cases: `model` hits alias → `displayLabel = alias.label`; `model` hits alias with no label → `displayLabel = alias.alias`; `model` doesn't hit any alias → `displayLabel = model` raw |
| `test/web/ModelStatusButton.test.tsx` (NEW) | 4 cases: renders displayLabel; click opens Popover; click on model item calls `patchSessionModel(sid, model.model)`; click on current item is no-op |

---

## Out of scope (v1)

- "Reset to default" action in the picker (would require PATCH with explicit `model: 'unknown'` sentinel — YAGNI).
- Per-session model history (which models were used, when).
- Editing the picker list from the UI (users edit `~/.zai/settings.json` directly).
- Resolving aliases for the runtime path (aliases are display-only; runtime always sees resolved names).
- Per-CWD model overrides (the `cwd` parameter on `resolveModel` is reserved for future use; v1 ignores it).