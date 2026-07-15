# zai 内置指令基础能力与扩展机制 — 设计规格

> 文档版本: 1.0 · 2026-07-15 · 状态: 设计已敲定, 待用户 review

## 0. 背景

zai / zai-agent-core 目前**没有任何内置 slash 命令支持**:用户在 web `Agent.tsx` 输入框打 `/xxx` 时,会被 `handleSend` 原样 POST 到 `/api/agent/prompt`,最终被当作普通 prompt 发给 LLM。OpenCC 上游的 `Command` 类型已经在仓库里有镜像(`packages/zai-agent-core/src/opencc-internals/types/command.ts`,含 `PromptCommand` / `LocalCommand` / `LocalJSXCommand`),但 CV 后**没有任何调用方** — 既没有注册表,也没有 built-in 命令实现,更没有 user-defined 命令的 loader。

与此同时,`packages/zai/src/web/src/pages/Agent.tsx:1005-1184` 已经实现了一个 `/` 触发的 **skill autocomplete 弹层**(`useState<skills>`、`filteredSkills` fuzzy 匹配、`selectSkill` 键盘导航),但它只显示 skill,不能显示命令。Web 端 Resources 页面目前也没有 Commands CRUD 入口(只显示计数)。

本 spec 在 zai 中实现一套**对齐 OpenCC 上游心智**的内置指令 + 扩展机制:三个 hardcode 的 built-in 命令(`/clear`、`/compact`、`/status`),文件级 user-defined prompt 命令(`~/.zai/commands/*.md`),Web 端 CRUD 面板,以及统一的 `/` 弹层。

## 1. 高层架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     @zn-ai/zai (web + server)                    │
│                                                                  │
│   ┌────────────────────────────────────────────────────────┐    │
│   │  packages/zai/src/web/src/pages/Agent.tsx              │    │
│   │  handleSend:                                           │    │
│   │    input.startsWith("/") ?                             │    │
│   │      POST /api/agent/command → 结构化结果               │    │
│   │      ├─ cleared   → store.clearMessages                │    │
│   │      ├─ compacted → toast + sidebar reload             │    │
│   │      ├─ status    → 弹出现有 ConversationInfoCard     │    │
│   │      ├─ prompt    → POST /api/agent/prompt {合成的}   │    │
│   │      └─ unknown   → 走原 /agent/prompt 路径(发给 LLM)  │    │
│   └────────────────────────────────────────────────────────┘    │
│                                                                  │
│   ┌────────────────────────────────────────────────────────┐    │
│   │  packages/zai/src/server/                              │    │
│   │  routes/command.ts    POST /api/agent/command          │    │
│   │  routes/commands.ts   CRUD /api/agent/commands         │    │
│   │  routes/slash.ts      GET  /api/agent/slash            │    │
│   │  services/commands/                                    │    │
│   │    registry.ts        服务层单例 + builtin + user load │    │
│   │    builtin/clear.ts   /clear                           │    │
│   │    builtin/compact.ts /compact                         │    │
│   │    builtin/status.ts  /status                          │    │
│   │    userLoader.ts      scan ~/.zai/commands/*.md         │    │
│   └────────────────────────────────────────────────────────┘    │
│                                                                  │
│   ┌────────────────────────────────────────────────────────┐    │
│   │  packages/zai-agent-core/src/commands/  (新)           │    │
│   │  index.ts        公共 re-export                        │    │
│   │  types.ts        Command 接口(收窄:去除 local-jsx)     │    │
│   │  registry.ts     CommandRegistry(register/get/all)     │    │
│   │  promptRender.ts $ARGUMENTS / $1..$n / argNames 处理   │    │
│   │  注:不依赖 opencc-internals,避免 TUI 拽入              │    │
│   └────────────────────────────────────────────────────────┘    │
│                                                                  │
│   ┌────────────────────────────────────────────────────────┐    │
│   │  packages/zai-agent-core/src/opencc-internals/ (CV)   │    │
│   │  types/command.ts 已存在;本 spec **不引用**             │    │
│   └────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### 1.1 沿用的核心约束

- 不读 OpenCC `settings.json`,zai 独立 `~/.zai/settings.json`
- 不读 OpenCC 默认命令路径(`~/.claude/commands`),zai 用 `~/.zai/commands/`(单一来源,显式配置)
- 所有错误走 toast(`message.warning` / `message.error`)或结构化 `{kind:'error'}` 路径
- zai-agent-core 零 LLM SDK、零 npm 依赖增量

### 1.2 新增约束(本 spec 决定)

- `src/commands/` 不依赖 `src/opencc-internals/`,自己维护 `Command` 类型(收窄,去掉 `local-jsx`)
- built-in 命令用 `local` 类型,`call()` 返回结构化 `LocalCommandResult`,**不**返回 React 节点(zai 没 TUI)
- user-defined 命令走 `prompt` 类型,完全复用 OpenCC 的字段集(`$ARGUMENTS` / `$1..$n` / `argNames` / `allowedTools` / `model` / `effort` / `argumentHint` / `disableModelInvocation` / `whenToUse`)
- 未知命令 fallthrough 到 LLM(OpenCC 默认行为,前端不感知)
- MVP 不引入文件 watcher;CRUD 写完后手动 `reloadUserCommands`

## 2. 模块设计

### 2.1 `zai-agent-core/src/commands/types.ts`

```ts
export type CommandSource =
  | 'builtin' | 'bundled' | 'plugin' | 'project' | 'user' | 'mcp'

export interface CommandContext {
  cwd: string
  sessionId?: string
  model?: string
  dataDir: string
}

export interface PromptCommand {
  type: 'prompt'
  name: string
  aliases?: string[]
  description: string
  source: CommandSource
  progressMessage: string
  contentLength: number
  argumentHint?: string
  argNames?: string[]
  allowedTools?: string[]
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'max'
  disableModelInvocation?: boolean
  whenToUse?: string
  version?: string
  getPromptForCommand(args: string, context: CommandContext): Promise<ContentBlockParam[]>
}

export type LocalCommandResult =
  | { kind: 'cleared' }
  | { kind: 'compacted'; removedMessages: number; summary?: string }
  | { kind: 'status'; payload: StatusPayload }
  | { kind: 'message'; text: string }
  | { kind: 'error'; message: string }

export interface StatusPayload {
  sessionId?: string | null
  cwd: string
  cwdName: string
  branch: string
  model: string
  permissionMode?: string
  version: string
}

export interface LocalCommand {
  type: 'local'
  name: string
  aliases?: string[]
  description: string
  argumentHint?: string
  source: CommandSource
  isEnabled?: () => boolean
  call(args: string, context: CommandContext): Promise<LocalCommandResult>
}

export type Command = PromptCommand | LocalCommand
```

### 2.2 `zai-agent-core/src/commands/registry.ts`

```ts
export interface CommandRegistry {
  register(cmd: Command): void
  unregister(name: string): void
  get(name: string): Command | undefined
  all(): Command[]
  resolve(input: string): { command: Command; args: string } | null
}

let _registry: CommandRegistry | null = null
export function getCommandRegistry(): CommandRegistry
export function setCommandRegistry(r: CommandRegistry | null): void  // 测试 seam
```

`resolve` 规则:以 `/` 开头 → 截出第一段 token 作为 name,剩余作为 args。name 匹配 `primary` 或 `aliases`(大小写不敏感)。

### 2.3 `zai-agent-core/src/commands/promptRender.ts`

```ts
export interface RenderArgs {
  body: string
  args: string
  argNames?: string[]
}
export function renderPrompt({body, args, argNames}: RenderArgs): string
```

替换规则(对齐 OpenCC):

| Token | 行为 |
|---|---|
| `$ARGUMENTS` | 替换为完整 `args` 字符串 |
| `$1`, `$2`, ... | 按空白切分 `args`,按位置替换 |
| `${name}` | 若 `argNames` 含同名,按位置变量替换;否则**保留字面量** |

未匹配的位置变量(`$3` 但 args 只有 2 段)→ 替换为空字符串。`args` 为空时,所有位置变量和 `$ARGUMENTS` 替换为空字符串。

### 2.4 `zai-agent-core/src/commands/index.ts`

公共 re-export:`types`、`registry`、`promptRender`,**不**导出 built-in 命令(那些是 zai 层职责)。

### 2.5 `zai/src/server/services/commands/registry.ts`

服务层封装,init 时:

1. `getCommandRegistry()` 拿 agent-core 单例
2. `registerBuiltin()`:依次注册 `/clear`、`/compact`、`/status`
3. `loadUserCommands()`:扫 `~/.zai/commands/*.md`,把每个文件包装为 `PromptCommand`,`name` 取文件名(去掉 `.md`),`source: 'user'`,`getPromptForCommand` 闭包持有 `body`
4. **冲突策略(明确)**:若 builtin 与 user 同名 — builtin 保持 `name="<x>"` 注册;user 命令**也注册**,但 `name` 重写为 `user:<x>` 以避免覆盖。`/api/agent/slash` 列表里两条都出现,UI 用 `isBuiltIn` 标记区分;用户输入 `/<x>` 时 `resolve()` 只命中 builtin。loader 打 `console.warn` 提示冲突。

`reloadUserCommands()`:清除所有 `source==='user'` 的 Command,重新 `loadUserCommands()`。CRUD 端点写完后调。

### 2.6 built-in 命令实现

| 文件 | 类型 | call 行为 |
|---|---|---|
| `builtin/clear.ts` | `LocalCommand` | 调 `getTranscriptStore().remove(transcriptId)`(参考 `packages/zai-agent-core/src/transcript/store.ts` 已有的 `remove()` 方法);若后端判定有活跃 query(通过 `getCurrentSessionId()` + `runtime` 拿 session),先 `await abortAgentSession()`,再 remove;返回 `{kind:'cleared'}` |
| `builtin/compact.ts` | `LocalCommand` | 调 `services/compact/` 已有 compact 路径(若该路径尚未上线 → 返回 `{kind:'error', message: '/compact 暂未实现'}` — MVP 接受 stub);返回 `{kind:'compacted', removedMessages: n, summary?}` |
| `builtin/status.ts` | `LocalCommand` | 拼 `instanceContext`(cwd / cwdName / branch)+ `getCurrentSessionId()` + 当前 `model`,返回 `{kind:'status', payload: StatusPayload}`;**不**写消息 — 由前端决定怎么呈现 |

### 2.7 userLoader.ts

```ts
export async function loadUserCommands(): Promise<PromptCommand[]>
```

- 扫 `~/.zai/commands/*.md`
- frontmatter 走 zai-agent-core 现有的最小 YAML parser(避免新增依赖;参考 skill spec 2026-07-10 的 frontmatter 处理路径)
- 文件名约束:`^[a-z0-9][a-z0-9-_]*$`,不匹配跳过 + warn
- body 即 markdown 去掉 frontmatter `---` 后的部分
- 解析失败的 frontmatter → 跳过文件 + warn,不抛

## 3. API 端点

### 3.1 `POST /api/agent/command`

请求:
```json
{ "name": "compact", "args": "--force", "sessionId": "sess-abc" }
```

响应(`type: 'cleared'`):
```json
{ "type": "cleared", "payload": null }
```

响应(`type: 'compacted'`):
```json
{ "type": "compacted", "payload": { "removedMessages": 12, "summary": "..." } }
```

响应(`type: 'status'`):
```json
{ "type": "status", "payload": { "sessionId": "...", "cwd": "...", "model": "...", ... } }
```

响应(`type: 'prompt'`):
```json
{ "type": "prompt", "payload": { "rendered": "完整替换后的 prompt 文本" } }
```

响应(`type: 'unknown'`):
```json
{ "type": "unknown", "payload": { "input": "/foo" } }
```

响应(`type: 'error'`):
```json
{ "type": "error", "payload": { "message": "usage: /compact [--force]" } }
```

### 3.2 `/api/agent/commands` CRUD

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/agent/commands` | 列表:`[{name, source, description, argumentHint?, whenToUse?, version?}]` |
| GET | `/api/agent/commands/:name` | 全文:`{name, frontmatter: {...}, body: "..."}` |
| POST | `/api/agent/commands` | 写 `~/.zai/commands/<name>.md`(frontmatter + body),原子写(tmp + rename),reload |
| PUT | `/api/agent/commands/:name` | 同上(覆盖) |
| DELETE | `/api/agent/commands/:name` | `rm`,reload |

校验:name 必须匹配 `^[a-z0-9][a-z0-9-_]*$`;body 非空;frontmatter 必须是合法 YAML。失败返回 4xx,UI 显示 message。

### 3.3 `GET /api/agent/slash`

替换现有 `/api/agent/skills`(保留旧路径作 deprecation,逐步迁移)。

响应:
```json
{
  "items": [
    { "kind": "command", "name": "clear", "description": "清空当前对话",
      "argumentHint": null, "isBuiltIn": true, "whenToUse": "..." },
    { "kind": "command", "name": "compact", "description": "压缩当前对话",
      "argumentHint": "[--force]", "isBuiltIn": true, "whenToUse": "..." },
    { "kind": "command", "name": "status", "description": "查看当前状态",
      "argumentHint": null, "isBuiltIn": true, "whenToUse": "..." },
    { "kind": "command", "name": "greet", "description": "打招呼 (user)",
      "argumentHint": "[name]", "isBuiltIn": false, "whenToUse": "..." },
    { "kind": "skill", "name": "frontend-design", "description": "..." }
  ]
}
```

顺序:built-in commands → user commands → skills。前端 fuzzy 匹配只换数据源,UI 不变。

## 4. Web 端改动

### 4.1 `Agent.tsx`

`handleSend` 头部加分支。提取 `postPromptToLLM(text, blocks)` 为同一函数内 helper(`handleSend` 原 LLM 路径会搬到那里),让 slash 路径也能复用:

```tsx
const handleSend = async () => {
  const text = input.trim()
  // ...attachment 处理略

  if (text.startsWith("/")) {
    setInput("")
    const result = await api.post<CommandResponse>("/agent/command", {
      name: text.split(/\s+/)[0].slice(1),
      args: text.split(/\s+/).slice(1).join(" "),
      sessionId: sessionId || activeSessionId,
    })
    switch (result.type) {
      case "cleared":
        useAgentStore.getState().clearMessages()
        message.success("对话已清空")
        break
      case "compacted":
        message.success(`压缩完成,移除 ${result.payload.removedMessages} 条`)
        await useAgentStore.getState().loadSessions()
        break
      case "status":
        // 复用 ConversationInfoButton 触发逻辑(Agent.tsx: ConversationInfoButton 处)
        // payload 直接喂给现有 ConversationInfoCard 的渲染
        showConversationInfoCard(result.payload)
        break
      case "prompt":
        // 走与 handleSend 原 prompt 路径完全相同的代码:
        // 1) setInput("") 已做 2) 构造 userMsg 3) useAgentStore.setState({status:"streaming",messages:[...s.messages, userMsg]})
        // 4) api.post /agent/prompt {prompt: result.payload.rendered, sessionId, contentBlocks: blocks}
        // 唯一区别:把 text 换成 result.payload.rendered
        await postPromptToLLM(result.payload.rendered, blocks)
        break
      case "unknown":
        // OpenCC 默认 fallthrough:把原文本当普通 prompt 发给 LLM
        await postPromptToLLM(text, blocks)
        break
      case "error":
        message.error(result.payload.message)
        break
    }
    return
  }

  // 原 prompt 路径(extract 为 postPromptToLLM helper)
  await postPromptToLLM(text, blocks)
}
```

skill 加载从 `/api/agent/skills` 改为 `/api/agent/slash`,把 `items.filter(kind==='skill')` 作为现有 `setSkills` 的输入。`filteredSkills` 改名为 `filteredSlashItems`(可选),统一匹配 commands 和 skills。

### 4.2 `Resources.tsx`

Commands 区块现有逻辑只显示计数。本 spec 新增:

- 区块顶部 "新建" 按钮 → 弹 Modal(输入 name + 编辑 frontmatter + body)
- 每行卡片显示:`name` / `description` / `argumentHint` / 三个 icon 按钮(编辑 / 复制 / 删除)
- 编辑 Modal:复用新建 Modal 的表单,字段:name(readonly)/ description / argumentHint / argNames(逗号分隔)/ allowedTools(逗号分隔)/ model / effort / body(大 TextArea)
- 提交后调对应 API,loading 态 + 失败 toast

新建 / 编辑 / 删除成功后刷新列表(GET `/api/agent/commands`)。

## 5. 错误处理

| 场景 | 行为 | 兜底 |
|---|---|---|
| 未知命令 | fallthrough → POST `/api/agent/prompt` 原文本(OpenCC 默认) | 前端完全无感 |
| `disableModelInvocation=true` 的 prompt 命令被 LLM 误触发 | `getPromptForCommand` 入口检查,throw → 工具层返回 `disabled` | 与 OpenCC 一致 |
| `getPromptForCommand` 抛错 | `callCommand` 返回 `{kind:'error', message}` | 前端 toast |
| built-in 命令缺参 | `call` 返回 `{kind:'error', message: 'usage: /compact [--force]'}` | 前端 toast;不发起副作用 |
| user-defined `.md` frontmatter 解析失败 | loader 跳过该文件 + `console.warn` | registry 不注册,前端 `/api/agent/slash` 不返回 |
| 同名命令冲突(builtin vs user) | builtin 优先 + user 命令 name 加 `user:` 前缀展示 | 列表里两条都显示;built-in 标 isBuiltIn |
| `~/.zai/commands/` 不存在 | 视为"无 user 命令",返回空数组 | loader 不报错 |
| Web 写文件失败(权限/磁盘) | API 返回 4xx,UI 显示后端 message | CRUD 弹窗不关闭,允许重试 |
| 流式期间收到 `/clear` | 先 `abortAgentSession()`,再清,返回 `{kind:'cleared'}` | 避免和正在跑的 query 状态错乱 |

## 6. 并发与状态

- `CommandRegistry` 单例 + 进程内可变;CRUD 写完后 `registry.reloadUserCommands()`(原子切换,先 unregister 全部 source==='user' 的 Command,再 register 新一批)
- MVP 不引入文件 watcher;CRUD 路径手动 reload
- 后端启动时 `initCommands()` 一次性加载(zai server 启动阶段调用)
- CRUD 端点做简单 write-lock(`Promise` 队列),避免两个 tab 同时编辑产生竞态
- `/api/agent/slash` 结果不缓存(数据量小,实时刷新)

## 7. 安全边界

- user-defined 命令的 `body` 是纯 prompt 模板,不引入 JS 执行面;frontmatter 仅是数据,不上 Node 运行时
- 文件名约束:`^[a-z0-9][a-z0-9-_]*$`,避免路径穿越和特殊字符;CRUD 端点对 name 做正则校验
- `allowedTools` 在 LLM 端按 OpenCC 语义生效,zai 端仅透传给 `QueryEngine`(无需新代码)
- 写文件用 `tmp + rename` 原子写(参考 `packages/zai/src/server/services/fileStore.ts` 已有的原子写工具)

## 8. 测试矩阵

| 测试文件 | 关注点 |
|---|---|
| `zai-agent-core/test/commands/promptRender.test.ts` | `$ARGUMENTS` / `$1`/`$2` / `${name}` / 缺失 argNames fallback / 多余位置变量空字符串 |
| `zai-agent-core/test/commands/registry.test.ts` | `register/get/all/resolve`、aliases、大小写、unregister 后重新 register |
| `zai/test/services/commands/builtin.clear.test.ts` | 命中 /clear 时 store 被调、streaming 期间先 abort |
| `zai/test/services/commands/builtin.compact.test.ts` | 命中 /compact 时 services/compact 被调、返回值映射 |
| `zai/test/services/commands/builtin.status.test.ts` | payload 字段齐全(instanceContext / sessionId / model) |
| `zai/test/services/commands/userLoader.test.ts` | 扫目录、frontmatter 解析、bad frontmatter 跳过、name 校验、文件不存在 |
| `zai/test/routes/command.test.ts`(集成) | POST `/api/agent/command` 五种 type 路径 + unknown fallthrough |
| `zai/test/routes/commandsCrud.test.ts`(集成) | 5 个 CRUD 端点、原子写、reload 后 slash 列表更新、name 校验失败 |
| `zai/test/routes/slash.test.ts` | 返回 builtin + user + skill 的合并顺序、user 与 builtin 重名时 both 出现 |

## 9. 不做的事(YAGNI)

- ❌ 文件 watcher(单独 spec)
- ❌ LocalCommand 远程/MCP 类型(暂用 `plugin` source 字段预留位)
- ❌ 命令权限/审批流(留 `disableModelInvocation` 即可)
- ❌ `/permissions`、`/mode`(用户已剔除)
- ❌ 命令面板的搜索高亮/分组/最近使用(等用起来再加)
- ❌ CLI 端 `zai command` 入口(只走 web)

## 10. 文件清单

**新增**:

```
packages/zai-agent-core/src/commands/
  index.ts
  types.ts
  registry.ts
  promptRender.ts

packages/zai-agent-core/test/commands/
  promptRender.test.ts
  registry.test.ts

packages/zai/src/server/services/commands/
  registry.ts
  builtin/clear.ts
  builtin/compact.ts
  builtin/status.ts
  userLoader.ts

packages/zai/test/services/commands/
  builtin.clear.test.ts
  builtin.compact.test.ts
  builtin.status.test.ts
  userLoader.test.ts

packages/zai/test/routes/
  command.test.ts
  commandsCrud.test.ts
  slash.test.ts

packages/zai/src/server/routes/
  command.ts
  commands.ts
  slash.ts
```

**改动**:

```
packages/zai/src/server/routes/index.ts    (注册新路由)
packages/zai/src/server/services/agentRuntime.ts (init 时 initCommands)
packages/zai/src/web/src/pages/Agent.tsx   (handleSend 分支 + slash 数据源合并)
packages/zai/src/web/src/pages/Resources.tsx (加 Commands 区块 + CRUD 弹窗)
packages/zai/src/web/src/store/useAgentStore.ts (compact 后 reloadSessions helper)
```

## 11. 风险与决策记录

- **R1**:zai 没有 TUI,`local-jsx` 命令类型无意义 → 决定**收窄**为 `PromptCommand | LocalCommand`,与 OpenCC 同步时 `local-jsx` 在 sync script 里被剥离(单独 spec 处理)
- **R2**:`Command` 类型在 `opencc-internals/types/command.ts` 已经存在,但耦合 TUI 概念 → 决定**不复用**,在 agent-core 新建独立 `commands/` 模块,与 `runtime/skills/` 同模式
- **R3**:user-defined 命令 reload 时机 → MVP 决定**CRUD 写完后手动 reload**,不引入 watcher(后续 spec 再加)
- **R4**:未知命令行为 → 决定**fallthrough 到 LLM**(OpenCC 默认),前端不感知命令语义,简化心智
- **R5**:`/status` 命令的输出形态 → 决定**结构化 payload + 前端弹出现有 ConversationInfoCard**,不写新消息

## 12. 实现状态(2026-07-15)

实现已完成,对应 plan: `docs/superpowers/plans/2026-07-15-zai-builtin-commands.md`。

- agent-core Command 类型 / registry / renderPrompt:已实现,测试覆盖
- 三个 built-in (/clear /compact /status):已实现,compact 走 MVP stub(spec §2.6 决策)
- userLoader:已实现,frontmatter 解析复用 zai-agent-core 既有 YAML 工具,无新增依赖
- 三组 API 端点:`POST /api/agent/command` / `CRUD /api/agent/commands` / `GET /api/agent/slash` 已实现
- Web:Agent.tsx handleSend 加 `/` 分支 + slash 弹层合并 commands + skills;Resources.tsx Commands CRUD 区块已实现
- 测试:bun:test 跑过全部新增 + 已有

不在本次实现范围(spec §9 YAGNI):文件 watcher、CLI `zai command`、命令面板高级 UI。