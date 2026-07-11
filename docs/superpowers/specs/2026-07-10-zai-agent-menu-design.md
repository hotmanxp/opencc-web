# ZAI Agent 菜单 — 设计规格

> 本文档定义 `@zn-ai/zai` 新增 Agent 菜单（AI 对话 + 工具调用）的设计方案。服务端通过 `@zn-ai/zai-agent-core` 接入 agent runtime 能力，UI 为完整对话树。

---

## 1. 总体架构

### 1.1 核心理念

zai 现有定位是「轻量本地 HTTP server + React SPA」。Agent 菜单复用同样的形态：浏览器发送 prompt，zai server 调 `@zn-ai/zai-agent-core` 的 `DefaultAgentRuntime`，把 `RuntimeEvent` 流通过 SSE 写回浏览器，浏览器按事件类型渲染完整对话树。transcript 落盘到 `~/.zai/transcripts/`，会话身份在服务端按"最近一条"复用。

### 1.2 系统拓扑

```
┌─────────────────────────────────────────────────────────────┐
│                     用户 macOS 桌面                          │
│                                                             │
│  ┌──────────────────────────────────────┐                   │
│  │   Chrome / Safari / Edge (SPA)       │ ← 用户交互         │
│  │   http://localhost:9888              │                   │
│  │                                      │                   │
│  │   /agent 页：                        │                   │
│  │   - cwd 输入框                       │                   │
│  │   - 对话树（user/assistant/tool）     │                   │
│  │   - 发送 + 停止按钮                   │                   │
│  └──────────────┬───────────────────────┘                   │
│                 │ HTTP REST + SSE (X-Zai-Token)              │
│                 ▼                                           │
│  ┌──────────────────────────────────────┐                   │
│  │   zai (Node + Express)              │ ← 端口 9888        │
│  │   - POST /api/agent/stream (SSE)     │                   │
│  │   - POST /api/agent/abort            │                   │
│  │   services/agentRuntime.ts           │                   │
│  │   - getOrCreateAgentSession()        │                   │
│  │   - 凭据来自 agent-login             │                   │
│  └──────────────┬───────────────────────┘                   │
│                 │ import                                     │
│                 ▼                                           │
│  ┌──────────────────────────────────────┐                   │
│  │   @zn-ai/zai-agent-core              │                   │
│  │   - DefaultAgentRuntime.run()        │                   │
│  │   - loadAgentsMd(cwd) → systemPrompt │                   │
│  │   - query() → OpenCC StreamEvent     │                   │
│  │   - getZaiBaseTools (read/write/      │                   │
│  │     bash/file_search)                │                   │
│  │   - transcriptStore → ~/.zai/        │                   │
│  │   - wrapWithZaiMeta → RuntimeEvent   │                   │
│  └──────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 关键决策汇总

| 维度 | 选择 |
|------|------|
| MVP 范围 | 最小可用：单会话流式对话 + 基本工具，无审批弹窗 |
| CWD 边界 | 启动 cwd 为默认 + UI 可选 |
| LLM 凭据 | 复用 `/login` 凭据（agent-login） |
| UI 形态 | 完整对话树（user/assistant/tool 可折叠） |
| AGENTS.md | 自动从 cwd 向上加载 |
| Session 生命周期 | 服务端默认最近会话（页面刷新复用） |
| 集成路径 | zai 包内新增 agent 模块（方案 A），不抽独立 zai-server |
| 新增依赖 | `@zn-ai/zai-agent-core`（workspace 依赖） |

---

## 2. 目录结构与新增文件

### 2.1 新增文件布局

```
packages/zai/
├── package.json                          # +@zn-ai/zai-agent-core: workspace:*
├── src/
│   ├── server/
│   │   ├── routes/
│   │   │   └── agent.ts                  # POST /api/agent/stream (SSE)
│   │   │                                 # POST /api/agent/abort
│   │   └── services/
│   │       └── agentRuntime.ts           # DefaultAgentRuntime 单例
│   │                                     # getOrCreateAgentSession()
│   │                                     # 凭据注入
│   └── web/src/
│       ├── router.tsx                    # +<Route path="/agent" />
│       ├── components/
│       │   └── Layout.tsx                # +Agent 菜单项
│       ├── pages/
│       │   └── Agent.tsx                 # /agent 页：cwd + 对话树 + 输入区
│       └── lib/
│           └── sseAgent.ts               # fetch + ReadableStream SSE 客户端
└── test/
    ├── server/
    │   ├── agentRuntime.test.ts          # 单测
    │   └── routes-agent.test.ts          # supertest 集成测
    ├── web/
    │   └── Agent.test.tsx                # RTL 组件测
    └── integration/
        └── agent.spec.ts                 # 端到端 mock provider
```

### 2.2 不变的文件

- `packages/zai/src/cli/{dev,start}.ts`：CLI 命令无需修改
- `packages/zai/src/server/index.ts`：在 createApp() 里 `app.use('/api/agent', agentRouter)`
- `packages/zai-agent-core/`：本期 0 改动，能力已就位
- `packages/zai/src/web/src/lib/api.ts`：复用 fetch 封装，不变

### 2.3 启动时序变化

zai server 启动时（沿用现有 `cli/start.ts` 流程）增加：
```
1. read agent-login 凭据 from ~/.nova/credentials.json
2. new DefaultAgentRuntime({ dataDir: resolveDataDir(), providers: [凭据配置] })
3. 暴露给 routes/agent.ts
若凭据不存在：runtime 仍创建，但 provider 配置为空；
  /api/agent/stream 收到 prompt 后返回 llm_provider 错误，
  UI 顶部红条提示「请先到 /login 登录」
```

---

## 3. API 表面

### 3.1 接口列表

| 方法 | 路径 | 输入 | 输出 | 鉴权 |
|------|------|------|------|------|
| POST | `/api/agent/stream` | `{ prompt: string, cwd?: string }` | **SSE** `RuntimeEvent` 流 | `X-Zai-Token` |
| POST | `/api/agent/abort` | — | `{ ok: true, sessionId }` | `X-Zai-Token` |

### 3.2 入参 zod schema

```ts
const StreamRequest = z.object({
  prompt: z.string().min(1).max(32_000),
  cwd: z.string().optional(),  // 未传则用 zai 启动 cwd（从 process.cwd() 取）
})
```

### 3.3 SSE 事件 schema

直接转发 zai-agent-core 的 `RuntimeEvent`，不另定义封装：

```ts
type RuntimeEvent = {
  eventId: string
  sessionId: string
  ts: number
  turnIndex: number
  type: string          // 'user.text' | 'assistant.text' | 'tool.call' |
                        // 'tool.result' | 'runtime.error' | 'runtime.done' |
                        // 'runtime.aborted' | ...
  [key: string]: unknown
}
```

### 3.4 安全约束

- 沿用 zai 现有 `X-Zai-Token`（zai 启动时随机生成并写到 stdout）
- 入参 zod 严格校验
- cwd 字段不限制值（用户主动选择信任），由 zai-agent-core 的 `filterToolsByDenyRules` 默认放行
- 5 分钟硬超时（与 exec 路由一致）

---

## 4. 前端 UI

### 4.1 路由表

```
/                Dashboard  系统信息
/tools           Tools      CLI 状态
/resources       Resources  资源浏览
/login           Login      登录
/config          Config     配置
/dirs            Directory  目录
/agent           Agent      AI 对话（本设计新增）
```

### 4.2 Layout 菜单新增

在 `Layout.tsx:17-26` 菜单数组末尾追加：

```ts
{ key: '/agent', icon: <RobotOutlined />, label: 'Agent' }
```

### 4.3 Agent 页布局

```
┌─────────────────────────────────────────────────────────────┐
│ Agent                                                         │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ cwd: [ /Users/.../myproject                       ] [应用]│ │  ← cwd 输入
│ └──────────────────────────────────────────────────────────┘ │
│                                                               │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ 👤 帮我列出 src 下的 ts 文件                               │ │  ← user.message
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ 🤖 好的，我用 file_search 看一下                          │ │  ← assistant.text
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ 🔧 tool: file_search         [展开]                       │ │  ← tool.call 折叠
│ │   └─ args: { pattern: "src/**/*.ts" }                     │ │
│ │   └─ result: ["src/a.ts", "src/b.ts", ...]               │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ 🤖 找到了 3 个文件：...                                    │ │  ← assistant.text
│ └──────────────────────────────────────────────────────────┘ │
│                                                               │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ [输入框                                       ] [发送|停止]│ │  ← 底部
│ └──────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

渲染规则：

| RuntimeEvent.type | UI 块 |
|-------------------|------|
| `user.text` / 用户消息 | 右侧气泡（👤） |
| `assistant.text` | 左侧气泡（🤖） |
| `tool.call` | Ant Design `<Collapse>` 折叠块，header 显示工具名 + 简短描述 |
| `tool.result` | 嵌入对应 `tool.call` 折叠块内 |
| `runtime.error` | 底部红色 Banner，按 `error.category` 选择不同文案 |
| `runtime.done` | 流结束，发送按钮复位 |
| `runtime.aborted` | 流结束，发送按钮复位，顶部黄条「已中止」 |

### 4.4 状态管理

- 使用 zustand `useAgentStore`：当前 sessionId、cwd、消息列表（按 RuntimeEvent 顺序追加）、流式状态（idle / streaming / aborted）
- 流式状态切换发送按钮形态：idle → 发送；streaming → 停止（点击触发 `abortAgent`）
- 重连策略：MVP 不做自动重连（用户主动刷新页面，服务端复用最近 sessionId）

---

## 5. 服务端核心逻辑

### 5.1 agentRuntime.ts

```ts
import { DefaultAgentRuntime, resolveDataDir } from '@zn-ai/zai-agent-core'
import { randomUUID } from 'node:crypto'
import { readAgentLoginCredentials } from './agentLoginBridge'

let runtime: DefaultAgentRuntime | null = null
let currentSessionId: string | null = null

export function initAgentRuntime() {
  if (runtime) return
  const credentials = readAgentLoginCredentials()  // ~/.nova/credentials.json
  const dataDir = resolveDataDir()
  runtime = new DefaultAgentRuntime({
    dataDir,
    providers: credentials ? buildProvidersFromCredentials(credentials) : [],
  })
}

export async function getOrCreateAgentSession(): Promise<string> {
  if (currentSessionId) return currentSessionId
  const sessions = await runtime!.listSessions()
  if (sessions.length > 0) {
    currentSessionId = sessions[0].transcriptId  // 最近一条
    return currentSessionId
  }
  currentSessionId = randomUUID()
  return currentSessionId
}

export function getRuntime(): DefaultAgentRuntime {
  if (!runtime) throw new Error('Agent runtime not initialized')
  return runtime
}
```

### 5.2 agent.ts 路由

```ts
import { Router } from 'express'
import { z } from 'zod'
import { createSseStream } from './stream.js'
import { getRuntime, getOrCreateAgentSession } from '../services/agentRuntime.js'
import { loadAgentsMd, buildAgentsMdSystemPrompt } from '@zn-ai/zai-agent-core'

const router = Router()

const HARD_TIMEOUT_MS = 5 * 60 * 1000

router.post('/stream', async (req, res) => {
  const { prompt, cwd = process.cwd() } = StreamRequest.parse(req.body)
  const sessionId = await getOrCreateAgentSession()
  const runtime = getRuntime()

  // 加载 AGENTS.md 上下文
  const agentsMd = await loadAgentsMd(cwd)
  const systemPrompt = buildAgentsMdSystemPrompt(agentsMd)

  const stream = createSseStream(res)
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort('timeout'), HARD_TIMEOUT_MS)

  // 浏览器断开 → 中止
  req.on('close', () => abortController.abort('client_disconnect'))

  try {
    const events = runtime.run({ prompt, sessionId, cwd, systemPrompt, signal: abortController.signal })
    for await (const event of events) {
      stream.send(event as SseEvent)
      if (event.type === 'runtime.done' || event.type === 'runtime.aborted') break
    }
  } catch (err) {
    stream.send({ type: 'runtime.error', error: { category: 'internal', message: String(err) } })
  } finally {
    clearTimeout(timer)
    stream.end()
  }
})

router.post('/abort', async (req, res) => {
  const sessionId = await getOrCreateAgentSession()
  await getRuntime().abort(sessionId, 'user_abort')
  res.json({ ok: true, sessionId })
})

export default router
```

### 5.3 关键点

- **不读 OpenCC settings.json** — 沿用 zai-agent-core 的设计（ARCHITECTURE.md:51）
- **不挂审批 UI** — `getZaiBaseTools()` 默认放行；`filterToolsByDenyRules` 走默认空规则
- **不挂 MCP / skills** — MVP 不涉及
- **错误走 RuntimeErrorEvent 流式** — 永远不抛 HTTP 5xx（ARCHITECTURE.md:52）
- **超时硬限制 5 分钟** — 沿用 exec 路由规则
- **AGENTS.md 自动加载** — `loadAgentsMd(cwd)` 向上查找目录树中的 AGENTS.md

---

## 6. 数据流

```
Browser Agent.tsx
  │ POST /api/agent/stream { prompt, cwd? }  X-Zai-Token
  ▼
zai server routes/agent.ts
  │ 1. 校验 X-Zai-Token（401 if 无效）
  │ 2. getOrCreateAgentSession() → sessionId
  │ 3. loadAgentsMd(cwd) → buildAgentsMdSystemPrompt() → systemPrompt
  │ 4. runtime.run({ prompt, sessionId, cwd, systemPrompt, signal })
  ▼
DefaultAgentRuntime.run
  │ query() → OpenCC query() → StreamEvent
  │       ├─ user.text / assistant.text / tool.call / tool.result
  │       └─ provider 凭据来自 agent-login 启动时读出的 PA/OP
  │ transcriptStore.append 自动写入 ~/.zai/transcripts/<sessionId>.json
  │ wrapWithZaiMeta → RuntimeEvent { eventId, sessionId, ts, turnIndex, type, ... }
  ▼ AsyncIterable<RuntimeEvent>
zai routes/agent.ts
  │ for await (event of runtime.run(...)) stream.send(event)
  ▼ text/event-stream
Browser sseAgent.ts
  │ fetch + ReadableStream → 逐行解析 `data: {...}` → onEvent 回调
  ▼
Agent.tsx 状态追加（按 event.type 分发到不同 UI 块）
```

---

## 7. 错误处理

| 错误类别 | 处理位置 | UI 表现 |
|---------|---------|---------|
| `llm_provider` | RuntimeErrorEvent 流式 | 底部红色 banner，附 message，提示重试 |
| `tool_execution` | RuntimeErrorEvent 流式 | 对应 `tool.result` 折叠块内红字展示 detail |
| `permission_denied` | RuntimeErrorEvent 流式 | MVP 不挂审批 UI，理论上不触发；触发则落日志 |
| `transcript_io` | RuntimeErrorEvent 流式 | 顶部黄条「会话记录失败，对话可继续」 |
| `context_window` / `compaction_failure` | RuntimeErrorEvent 流式 | 提示「上下文超限，建议新建会话」 |
| `mcp_server` / `skill_load` | 不挂载 | MVP 不挂 MCP / skills，不会触发 |
| `internal` | RuntimeErrorEvent 流式 | 简化消息 + 服务端日志（zai/server 日志） |
| `aborted` | RuntimeAbortedEvent | 正常关闭 stream，前端停止按钮复位 |

中止语义：
- 浏览器关闭页面 → fetch AbortController 触发 → zai server 检测 `req.close` → `runtime.abort(sessionId)`
- 浏览器点「停止」按钮 → `POST /api/agent/abort` → `runtime.abort(sessionId)`
- 服务端硬超时 5 分钟 → 强制 `runtime.abort` 并发 `runtime.aborted`

---

## 8. 测试策略

### 8.1 单元测试

zai 包新增：

- `src/server/services/agentRuntime.test.ts`
  - `getOrCreateAgentSession()`：mock `listSessions()` 空 → 返回新 UUID；mock 非空 → 返回最近一条
  - 凭据注入：mock agent-login 凭据存在/缺失 → provider 配置是否正确组装
- `src/server/routes/agent.test.ts`（supertest）
  - 401：无 `X-Zai-Token`
  - SSE 正常路径：mock `DefaultAgentRuntime.run()` 返回固定事件序列 → 断言 SSE 流逐条写回
  - RuntimeErrorEvent 透传：mock 触发 `tool_execution` → 断言事件原样下发，HTTP 仍 200
  - 5min 超时：mock `runtime.run` 永挂 → 断言超时后 abort 并发 `runtime.aborted`
- `src/web/src/pages/Agent.test.tsx`（@testing-library/react）
  - 渲染：初始有 cwd 输入框 + 输入区 + 发送按钮
  - 发送：mock `sseAgent.runAgentStream` 推 3 条事件 → 断言对话树追加 user/assistant/tool 三块
  - 折叠：`tool.call` 块默认折叠，点击展开显示 result

zai-agent-core 包：
- 本期不改动；既有 `test/` 已覆盖 query / abortSession / streamAdapter

### 8.2 集成测试

`test/integration/agent.spec.ts`（zai 包）：
- 启动 zai server（test 模式，port 不同）
- fetch `POST /api/agent/stream`，固定 prompt "echo hi"，配 mock provider（zai-agent-core RuntimeConfig 支持）
- 断言：收到至少一条 `assistant.text`，含 mock 标记字符串
- 跑完检查 `~/.zai/transcripts/` 有对应 JSON 文件

### 8.3 手动验证清单

- 启动 zai dev → 访问 `/agent` → 默认 cwd 显示正确
- 发「列出当前目录文件」 → 看到 assistant 文本 + `tool.call(file_search)` + `tool.result(文件列表)`
- 发「读 package.json」 → 看到 read 工具调用
- 发「运行 echo hi」 → 看到 bash 工具调用
- cwd 改 `/tmp` → 后续消息 cwd 跟随
- 含 AGENTS.md 的目录打开 → 助手回复体现上下文
- 点停止按钮 → 流立即关闭
- 关浏览器标签 → 服务端日志显示 sessionId aborted
- 重启 zai → 再访问 `/agent` → 服务端 session 复用最近一条（transcript 不丢）

### 8.4 覆盖率目标

- `routes/agent.ts` 行覆盖 ≥ 80%（与现有 `exec.ts` 一致）
- 全包不强制覆盖率门槛

---

## 附录 A：依赖变更

### zai 包新增

```json
{
  "dependencies": {
    "@zn-ai/zai-agent-core": "workspace:*"
  }
}
```

### zai-agent-core 包

无变更。

---

## 附录 B：参考

- `packages/zai-agent-core/docs/ARCHITECTURE.md` — zai-agent-core 架构
- `packages/zai-agent-core/src/runtime/contract.ts` — AgentRuntime 接口
- `packages/zai-agent-core/src/runtime/events.ts` — RuntimeEvent 类型
- `packages/zai/src/server/routes/stream.ts` — 现有 SSE 工具
- `packages/zai/src/web/src/router.tsx` — 现有路由表
- `packages/zai/src/web/src/components/Layout.tsx` — 现有菜单定义
