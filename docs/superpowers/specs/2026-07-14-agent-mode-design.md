# Agent Permission Mode — Design

**Date:** 2026-07-14
**Status:** Draft (pending user review)
**Author:** brainstorming session
**Ticket:** HRMSV3-ZN-WEBSITE#668

## Goal

把 OpenCC 的 5 个 permission mode（`default` / `acceptEdits` / `plan` / `bypassPermissions` / `dontAsk`）暴露到 zai 平台：在 Agent 页面底栏用一个 popover 选择当前会话的 mode，仿 OpenCC TUI 风格；切换 mode 在 transcript 元数据里持久化，下次发消息时透传到 `zai-agent-core` 的 `QueryOptions.permissionMode`，由 runtime 据此初始化 `toolPermissionContext`。

**核心不变量**：`transcript.meta.permissionMode` 是每个 session mode 的唯一真源；runtime 无状态；切换 mode 不中断正在 streaming 的 turn。

## Scope

**In scope：**
- zai-agent-core 的 `QueryOptions` + `RuntimeConfig` 加 `permissionMode?: PermissionMode` 字段
- zai-agent-core 内部把 `permissionMode` 注入 `toolPermissionContext`（与 OpenCC `QueryEngine.ts:538-549` 一致）
- 新增 `PATCH /api/sessions/:id` 路由（对称已有 `patchSessionModel` 流程）
- `transcript.meta` schema 新增 `permissionMode: z.enum(...)` 字段
- `~/.zai/settings.json` 扩展 `defaultMode?: PermissionMode` 字段，新建会话时读取
- 新组件 `ModeStatusButton.tsx`（仿 `ModelStatusButton.tsx`）
- `useAgentStore` 扩展 `sessions[].permissionMode` 字段 + `patchSessionMode` action
- 底栏把静态的 `▶▶ zai` 替换为 `<ModeStatusButton />`
- shift+tab 快捷键循环切换 mode（与 OpenCC TUI 一致）

**Out of scope (YAGNI)：**
- 跨 session 的 mode 同步
- Mode 变更时的埋点 / metric
- 自定义 mode（用户自定义 mode 集合）
- 在 Config 页修改 defaultMode（V1 仅读 settings；改 defaultMode 是后续工作）
- 工具 allow / deny 决策的端到端测试（属于 zai-agent-core 内部行为）

## Architecture

```
┌─────────────── Frontend (React) ───────────────────────┐
│ ModeStatusButton (底栏 popover, 仿 ModelStatusButton) │
│   · 5 个 mode 单选                                    │
│   · 键盘导航 ↑↓ / Enter / Esc                          │
│   · 选中 → patchSessionMode(sessionId, mode)          │
│                                                       │
│ useAgentStore (Zustand)                                │
│   · sessions[].permissionMode (新字段)                │
│   · patchSessionMode: PATCH /api/sessions/:id         │
│                                                       │
│ Agent.tsx handleKeyDown (shift+tab)                    │
│   · cycle → patchSessionMode(sessionId, nextMode)     │
└────────────────────────┬──────────────────────────────┘
                         │ HTTP
┌────────────────────────▼──────────────────────────────┐
│ routes/agentSettings.ts (新)                           │
│   PATCH /api/sessions/:id                              │
│   · Zod 校验 body.permissionMode                       │
│   · 调 services 写 transcript.meta.permissionMode     │
│   · 返回更新后的 SessionMeta                           │
└────────────────────────┬──────────────────────────────┘
                         │
┌────────────────────────▼──────────────────────────────┐
│ services/agentRuntime.ts (改)                          │
│   query() 流程:                                        │
│   · loadTranscript(transcriptId)                       │
│   · resolveMode = meta.permissionMode                  │
│           ?? settings.defaultMode ?? 'default'         │
│   · DefaultAgentRuntime.query({ permissionMode })      │
└────────────────────────┬──────────────────────────────┘
                         │
┌────────────────────────▼──────────────────────────────┐
│ zai-agent-core                                        │
│   runtime/types.ts: QueryOptions 加 permissionMode    │
│   runtime/DefaultAgentRuntime.ts: query() 透传        │
│   runtime/queryEngine.ts: 注入 toolPermissionContext  │
│   (复用 opencc-internals 的 EXTERNAL_PERMISSION_MODES)│
└──────────────────────────────────────────────────────┘
```

## Files

### New files (4)

| Path | Purpose |
|---|---|
| `packages/zai/src/web/src/components/ModeStatusButton.tsx` | 底栏 popover 组件，仿 `ModelStatusButton.tsx`（~150 行） |
| `packages/zai/src/server/routes/agentSettings.ts` | `PATCH /api/sessions/:id` 路由（~50 行） |
| `packages/zai/test/web/ModeStatusButton.test.tsx` | 渲染 / 键盘 / 点击 单元测试 |
| `packages/zai/test/server/agentSettings.test.ts` | PATCH 路由 happy path + 400/404 单元测试 |

### Edited files (8)

| Path | Change |
|---|---|
| `packages/zai-agent-core/src/runtime/types.ts` | `QueryOptions` + `RuntimeConfig` 加 `permissionMode?: PermissionMode`；从 `opencc-internals/types/permissions.ts` re-export `PermissionMode` |
| `packages/zai-agent-core/src/runtime/DefaultAgentRuntime.ts` | `query()` 透传 `permissionMode` 到 `queryEngine` |
| `packages/zai-agent-core/src/runtime/queryEngine.ts` | 把 `permissionMode` 注入 `toolPermissionContext` |
| `packages/zai/src/shared/sessions.ts`（如不存在则新建） | Zod schema: `SessionMeta.permissionMode: z.enum([...])` |
| `packages/zai/src/server/services/transcriptStore.ts` | 持久化 `permissionMode` 到 `transcript.meta` |
| `packages/zai/src/server/services/settings.ts` | 读 `settings.defaultMode`；非法值 fallback 'default' |
| `packages/zai/src/web/src/store/useAgentStore.ts` | `sessions[].permissionMode` + `patchSessionMode()` action（optimistic + 回滚） |
| `packages/zai/src/web/src/pages/Agent.tsx` | 底栏用 `<ModeStatusButton />` 替换静态 `▶▶ zai`；`handleKeyDown` 加 shift+tab cycle |

## Data contract

```ts
// 新增 (zai-agent-core 暴露)
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'plan'
// (从 opencc-internals re-export，5 个 user-facing mode)

// QueryOptions 新字段 (optional, 向后兼容)
type QueryOptions = {
  ...
  permissionMode?: PermissionMode
}

// 新增 (frontend/backend 共享)
type SessionMeta = {
  transcriptId: string
  title?: string
  updatedAt: number
  model?: string
  permissionMode?: PermissionMode   // ← 新增
  cwd?: string
  createdAt?: number
  messageCount?: number
}

// API 契约
PATCH /api/sessions/:id
  body: { permissionMode: PermissionMode }
  resp: { ok: true, session: SessionMeta }
  err:  400 (invalid mode) / 404 (no session) / 500

GET /api/sessions
  resp: { sessions: SessionMeta[] }   // 已包含 permissionMode

GET /api/settings
  resp: { ..., defaultMode?: PermissionMode }   // 扩展现有接口
```

## UI 规范

### 底栏（改造前 → 改造后）

**改造前**（`Agent.tsx:1849-1874`）：
```
▶▶ zai · cwd · branch · model · task dock
```

**改造后**：
```
▶▶ plan (shift+tab to cycle) · cwd · branch · model · task dock
        ↑ 替换为 <ModeStatusButton />
```

### Popover 内容

仿 `ModelStatusButton.tsx` 的视觉风格（深色背景、紫色选中态）：

```
┌─ Select mode ───── esc ─┐
│ ◉ plan                  │   ← 当前 mode (紫色 ●)
│ ○ default               │
│ ○ accept edits          │
│ ○ bypass permissions    │   ← 红色字体 (高风险)
│ ○ don't ask             │   ← 红色字体
├─────────────────────────┤
│ ↑↓ Navigate  ⏎ Select   │
│ shift+tab cycle         │
└─────────────────────────┘
```

### Mode 显示文本与颜色

| mode | 显示文本 | 颜色 | 备注 |
|------|---------|------|------|
| `default` | `default` | `rgba(255,255,255,0.65)` | 默认 |
| `acceptEdits` | `accept edits` | `rgba(255,255,255,0.65)` | 默认 |
| `plan` | `plan` | `#a78bfa` (紫) | 当前选中时高亮 |
| `bypassPermissions` | `bypass on` | `#f43f5e` (红) | 高风险 |
| `dontAsk` | `don't ask` | `#f43f5e` (红) | 高风险 |

底栏当前 mode 文字颜色规则同上（与 OpenCC TUI 一致）。

## 关键流程

### A. 新建会话

```
1. User: 点击 "新建会话" 按钮
2. Frontend: POST /api/sessions { cwd, ... }
3. Server:
   a. 读 ~/.zai/settings.json → defaultMode (缺省 'default')
   b. 创建 transcript.json:
      {
        meta: {
          transcriptId, cwd, model,
          permissionMode: defaultMode,
          createdAt
        },
        messages: []
      }
   c. 返回 SessionMeta
4. Frontend: store.sessions.push(newSession), currentSession = newSession
```

### B. 切换 mode（核心）

```
1. User: 点开 ModeStatusButton → 选 plan
2. Frontend:
   a. Optimistic update: store.sessions[i].permissionMode = 'plan' (UI 立即变)
   b. PATCH /api/sessions/:id { permissionMode: 'plan' }
3. Server:
   a. Zod 校验
   b. 读 transcript, 改 meta.permissionMode, 原子写入 (tmp + rename)
   c. 返回 { ok, session }
4. Frontend:
   a. 收到响应 → 用 server 返回的 session 替换 store 项（确认）
   b. 如失败 → 回滚到旧 mode，弹 antd message.error
5. 若当前 turn 在 streaming: 不打断 (用户决策)
6. 下次发消息: server 读 transcript.meta.permissionMode = 'plan'
```

### C. 发消息（mode 透传）

```
1. User: 在 input 输入 → 按 Enter
2. Frontend: POST /api/agent/query { prompt, transcriptId, ... }
3. Server (agentRuntime.query):
   a. loadTranscript(transcriptId) → 拿 meta.permissionMode
   b. resolveMode = meta.permissionMode ?? settings.defaultMode ?? 'default'
   c. DefaultAgentRuntime.query({ ..., permissionMode: resolveMode })
4. Runtime:
   a. queryEngine 启动，permissionMode 注入 toolPermissionContext
   b. 与 OpenCC 一致，permissionContext 决定工具调用的 allow/deny
5. SSE 事件流: 客户端不需要感知 mode（已记录在 transcript 内）
```

### D. shift+tab 快捷键

**Canonical cycle order** (固定，与 OpenCC TUI 一致)：
```
default → acceptEdits → plan → bypassPermissions → dontAsk → default → ...
```

```
1. User: 在 input 焦点下按 shift+tab
2. Pre-check: 必须在 status === 'idle' 且 sessionId 存在时处理（streaming 时不响应）
3. Agent.tsx handleKeyDown:
   a. 阻止默认行为 (避免切焦点)
   b. 当前 mode 在 cycle order 里的索引 +1 (mod 5)
   c. 调 patchSessionMode(sessionId, nextMode)
   d. 与 OpenCC 的 shift+tab cycle 一致
4. (同 B 流程)
```

## 错误处理

| 场景 | 行为 |
|------|------|
| PATCH 时 session 不存在 | 404 + 前端回滚 + `message.error("会话不存在")` |
| PATCH 时 body 校验失败 | 400 + `message.error("无效 mode")`；optimistic update 回滚 |
| 写入 transcript 失败 (磁盘满 / 权限) | 500 + 前端回滚 + `message.error("保存失败")` |
| 发消息时 transcript.meta 缺 mode 字段 (旧数据) | fallback 到 `settings.defaultMode ?? 'default'` |
| settings.defaultMode 字段值非法 | 忽略该字段，fallback 'default'，不报错 |
| shift+tab 时没有 session | 不响应 |
| shift+tab 时 status=streaming | 不响应 (避免冲突, 行为与 OpenCC 一致) |
| 用户连续切 mode | 不防抖，每次 PATCH 都发，server 端最后写赢 |

## 兼容旧数据

- **旧 transcript** (无 `permissionMode` 字段): 读时缺省 `settings.defaultMode ?? 'default'`
- **首次升级**: 无需迁移脚本，下次写入时自然补字段
- **CLI 兼容**: zai-agent-core 的 `permissionMode` 字段是 optional，向后兼容现有调用

## 测试策略

### 单元测试

| 包 | 文件 | 覆盖点 |
|---|---|---|
| `zai-agent-core` | `runtime/types.test.ts` (新) | `QueryOptions.permissionMode` 类型 |
| `zai-agent-core` | `runtime/DefaultAgentRuntime.test.ts` (扩展) | `query()` 透传 `permissionMode` 到 `queryEngine` (spy) |
| `zai` (server) | `services/transcriptStore.test.ts` (新/扩展) | 读写 `transcript.meta.permissionMode`；缺字段回退 |
| `zai` (server) | `services/settings.test.ts` (扩展) | 读 `settings.defaultMode`；非法值回退 |
| `zai` (web) | `components/ModeStatusButton.test.tsx` (新) | 渲染 5 个 mode、键盘导航、点击触发 patchSessionMode |
| `zai` (web) | `store/useAgentStore.test.ts` (扩展) | `patchSessionMode` 的 optimistic update + 失败回滚 |

### 集成测试 (API 路径)

| 路由 | 场景 | 期望 |
|---|---|---|
| `PATCH /api/sessions/:id` | 合法 mode (plan) | 200 + session 反映新 mode；transcript 文件被写 |
| `PATCH /api/sessions/:id` | 非法 mode (typo) | 400，transcript 未变 |
| `PATCH /api/sessions/:id` | 不存在的 session | 404 |
| `POST /api/sessions` | 无 `defaultMode` 配置 | 新 session mode = 'default' |
| `POST /api/sessions` | `settings.defaultMode = 'plan'` | 新 session mode = 'plan' |
| `POST /api/agent/query` | transcript.mode = 'plan' | runtime.query 收到的 mode = 'plan' (spy 验证) |
| `POST /api/agent/query` | transcript.mode 缺字段 | runtime.query 收到的 mode = `settings.defaultMode ?? 'default'` |

### 测试数据

- Fixture transcript: 3 个样本 (无 mode 字段 / 合法 mode / 非法 mode)
- Mock settings.json: 3 个变体 (无 defaultMode / 合法 defaultMode / 非法 defaultMode)

### 不测试的 (YAGNI)

- 跨 session 的 mode 同步 (per-session 决策已排除)
- Mode 变更时的埋点 / metric
- 工具 allow / deny 决策的端到端验证 (属于 zai-agent-core 内部行为)
- Visual snapshot 测试
- 真实 LLM 的 e2e

## 后续工作 (不在本次范围)

- 在 Config 页可视化编辑 `defaultMode`
- Mode 切换的 metric / 埋点
- 自定义 mode 集合 (允许用户配置)
