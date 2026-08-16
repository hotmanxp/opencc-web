# zai web 端 /handoff 指令对齐 OpenCC vendor — 设计规格

> 文档版本: 1.0 · 2026-08-16 · 状态: 设计已敲定, 待用户 review

## 0. 背景

OpenCC vendor(`packages/zn-agent-core/opencc-src/commands/handoff/index.ts`)定义了一个 `type: 'prompt'` 的内置 `/handoff` 指令,行为分两支:

- **PICKUP**(`assistant 消息数 ≤ 4`):扫描 `.agent_working_dir/handoff/*.md`,让用户挑选一个已有交接文档,据此继续对话;支持 `--pick <filename>` 强制指定
- **GENERATE**(`> 4`):把当前 TaskList 塞进 prompt,让 LLM 用 `Write` 工具写一个新交接文档到 `.agent_working_dir/handoff/<task>-<YYYY-MM-DD>.md`

该 vendor handoff **当前不在 `REMOTE_SAFE_COMMANDS` 也不在 `BRIDGE_SAFE_COMMANDS`** — 移动端 / web 端通过 opencc bridge 调用是被排除的。

zai 当前内置 3 个 slash 命令(`/clear` / `/compact` / `/status`,都是 `type: 'local'`),完全没有 handoff。用户从 opencc CLI 写的 handoff,无法在 zai web 端被读取或继续。

zai 体系已经原生支持 `type: 'prompt'` 命令(`packages/zn-agent-core/src/compat/commands/types.ts:19-36`,所有 user commands 都走 prompt 路径),前端 `AgentInputBox.tsx:575-583` 也已经正确处理 `{type:'prompt', payload:{rendered}}` 响应(`pushUserMsg` 显示原文 + `submitPrompt` 转发 rendered)。**唯一的缺位是 zai 侧没有 handoff 的命令注册**。

本 spec 在 zai 实现 `/handoff`,行为对齐 vendor:
- handler 在 zai 服务端完成确定性的 PICKUP/GENERATE 分支判定 + 文件列表组装
- 复用 vendor 的纯 fs 工具(`listHandoffs` / `getLatestHandoff` / `buildHandoffPath`)
- 实际写文件 / 读文件 / 问用户交给 zai 的 LLM,通过 zai 现有工具体系(`Write` / `Read` / `AskUserQuestion`)完成

## 1. 高层架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    @zn-ai/zai  (web + /m + server)               │
│                                                                  │
│   packages/zai/src/server/services/commands/                    │
│     builtin/handoffCommand.ts          ← 本 spec 新增           │
│       parseArgs() / resolveCwd() / countAssistantMessages()     │
│       readTaskListText()                ← 确定性 PICKUP/GENERATE │
│       getPromptForCommand(args, ctx)    ← 注册为 PromptCommand  │
│     builtin/handoff/prompts/                                   │
│       generate.ts         ← 中文 generate 模板(纯函数)         │
│       pickup.ts           ← 中文 pickup 模板(纯函数)           │
│     registry.ts            reg.register(handoffCommand) ← 改 1 行 │
│     routes/command.ts      prompt 分支包 try/catch  ← 段 4 改造 │
│     routes/slash.ts        GET /api/slash 自动包含 handoff       │
│                                                                  │
│   packages/zai/src/web/src/components/                          │
│     AgentInputBox.tsx      /handoff 触发 → POST /agent/command  │
│                            575-583 行:pushUserMsg + submitPrompt │
│     AgentInputBox.test.tsx mock /api/slash 多含一项 handoff      │
│                                                                  │
│   packages/zai/src/web/src/pages/MobileAgent.tsx                │
│     复用 SlashItem 下拉,零改动                                  │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                @zn-ai/zn-agent-core  (复用 vendor fs 工具)       │
│                                                                  │
│   opencc-src/commands/handoff/handoff.ts                        │
│     listHandoffs(root)        ← vendor 已有,直接 import         │
│     getLatestHandoff(root)    ← vendor 已有                      │
│     buildHandoffPath(...)     ← vendor 已有                      │
│   compat/commands/types.ts    PromptCommand 已支持 type:'prompt' │
│                                                                  │
│   ↑ 复用,不修改 vendor 源码                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 1.1 沿用的核心约束

- zai 不读 opencc `settings.json`,独立配置;本 spec 不新增 zai 配置
- 错误统一走 zai `{type:'error', payload:{message}}` 结构(前端已渲染 toast)
- mobile `/m` 与 web `/agent` 共享同一个后端命令注册,SlashItem 由 `/api/slash` 同一来源
- LLM 工具调用(Write / Read / AskUserQuestion)由 zai 现有体系承担,handler 不直接调 LLM

### 1.2 新增约束(本 spec 决定)

- handoff 文件目录固定 `.agent_working_dir/handoff/`(对齐 vendor,跨工具可读)
- 分支阈值固定 `assistantCount ≤ 4` → PICKUP(对齐 vendor,不动)
- `--pick <filename>` 强制 PICKUP(对齐 vendor 显式意图覆盖)
- 服务端只产出 prompt 文本,**不**直接调 LLM;实际落盘 / 读取 / 询问由 zai LLM 用 zai 工具完成
- vendor 的 `getPromptForCommand(args, ToolUseContext)` 因 context 不可用**不**直接迁移;zai 重写 handler 但保留 prompt 模板的章节结构对齐
- 不引入新错误码,复用现有 `error` 分支

## 2. 模块设计

### 2.1 `packages/zai/src/server/services/commands/builtin/handoffCommand.ts`(新增)

```ts
import path from 'node:path'
import type { PromptCommand, CommandContext } from '@zn-ai/zn-agent-core'
import {
  listHandoffs,
  getLatestHandoff,
  buildHandoffPath,
} from '@zn-ai/zn-agent-core'  // 由 compat 层 re-export(见 2.4)

import { buildGeneratePrompt } from './handoff/prompts/generate'
import { buildPickupPrompt } from './handoff/prompts/pickup'

const PICKUP_THRESHOLD = 4  // 对齐 vendor
const HANDOFF_SUBDIR = path.join('.agent_working_dir', 'handoff')

export class HandoffArgsError extends Error {}
export class HandoffCwdError extends Error {}

interface ParsedArgs {
  pickFile?: string
}

function parseArgs(args: string): ParsedArgs {
  const trimmed = args.trim()
  if (!trimmed) return {}
  // 只识别 `--pick <filename>`,其他 token 抛错
  const tokens = trimmed.split(/\s+/)
  const out: ParsedArgs = {}
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--pick') {
      const v = tokens[++i]
      if (!v || v.startsWith('--')) {
        throw new HandoffArgsError('用法:/handoff [--pick <filename>]')
      }
      out.pickFile = v
    } else {
      throw new HandoffArgsError(`未知参数:${t};用法:/handoff [--pick <filename>]`)
    }
  }
  return out
}

function resolveCwd(context: CommandContext): string {
  // context.cwd 在 zai 命令上下文中由调用方注入;兜底 process.cwd()
  const cwd = (context as { cwd?: string }).cwd ?? process.cwd()
  if (!cwd) throw new HandoffCwdError('无法解析当前工作目录')
  return cwd
}

async function countAssistantMessages(context: CommandContext): Promise<number> {
  // 优先从 context 注入字段取(实现阶段由调用方 routes/command.ts 注入);
  // 兜底返回 +Infinity → 强制走 GENERATE(优于 PICKUP,新会话默认行为更安全,
  // 因为空 cwd 上 PICKUP 总是返回 0 文件,提示用户用 vendor CLI 反而打断流程)。
  const injected = (context as { assistantMessageCount?: number }).assistantMessageCount
  if (typeof injected === 'number') return injected
  return Number.POSITIVE_INFINITY
}

async function readTaskListText(context: CommandContext): Promise<string | null> {
  // 优先从 context 注入字段取(实现阶段由调用方注入);
  // 不可用时返回 null → generate prompt 内嵌"(未提供)"占位,
  // LLM 据对话上文推断当前任务列表。
  const injected = (context as { taskListText?: string | null }).taskListText
  if (typeof injected === 'string') return injected
  return null
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export const handoffCommand: PromptCommand = {
  type: 'prompt',
  name: 'handoff',
  description: '交接当前会话:消息多时生成交接文档,消息少时恢复最近的交接',
  argumentHint: '[--pick <filename>]',
  source: 'builtin',
  progressMessage: 'preparing handoff',
  contentLength: 0,
  isEnabled: () => true,

  async getPromptForCommand(args, context) {
    const parsed = parseArgs(args)
    const cwd = resolveCwd(context)
    const root = path.join(cwd, HANDOFF_SUBDIR)
    const date = todayISO()
    const assistantCount = await countAssistantMessages(context)
    const taskListText = await readTaskListText(context)

    // --pick 强制 PICKUP;否则按消息数分支
    const isPickup = parsed.pickFile !== undefined || assistantCount <= PICKUP_THRESHOLD

    if (isPickup) {
      const files = await listHandoffs(root)
      const text = buildPickupPrompt({
        cwd,
        root,
        date,
        files,                  // 已按 mtime 倒序的 [{path, mtimeMs}]
        pickFile: parsed.pickFile,
      })
      return [{ type: 'text', text }]
    }

    const text = buildGeneratePrompt({
      cwd,
      root,
      date,
      taskListText,            // 可为 null → prompt 嵌入"未提供"占位
    })
    return [{ type: 'text', text }]
  },
}
```

### 2.2 `packages/zai/src/server/services/commands/builtin/handoff/prompts/generate.ts`(新增)

```ts
interface GenerateParams {
  cwd: string
  root: string          // 绝对路径 .agent_working_dir/handoff
  date: string          // YYYY-MM-DD
  taskListText: string | null
}

export function buildGeneratePrompt(p: GenerateParams): string {
  const taskSection = p.taskListText
    ? p.taskListText
    : '(未提供 — 请从对话上文推断当前任务列表)'

  return `# /handoff — 生成交接文档

请根据当前会话生成交接文档,写入磁盘,然后回执给用户。

## 目标路径

\`${p.root}/<task-slug>-${p.date}.md\`

- \`<task-slug>\` 用 kebab-case 英文短语概括本次会话主题(例如 \`refactor-auth-middleware\`)
- 日期已确定为 \`${p.date}\`

## 文档章节(必须全部填写)

按以下小节顺序输出完整 markdown:

### Task title
一句话标题。

### Original Request
用户最初的原始请求,逐字摘抄。

### Goal
本次会话要达成的目标。

### Artifacts
已产出的文件 / 决策 / 改动(绝对路径 + 简短说明)。

### Key Findings
过程中发现的关键事实、调研结论、设计取舍。

### Pitfalls
踩过的坑、失败尝试、注意事项(供后续接手人避坑)。

### Current TaskList
\`\`\`
${taskSection}
\`\`\`

### Next Steps
下一步该做的事,按优先级排序。

### Skills Used
本次会话用到的主要技能 / 命令(可选)。

## 落盘要求

1. 用 \`Write\` 工具把上面文档写入 \`${p.root}/<task-slug>-${p.date}.md\`
2. 写入成功后,纯文本回执一行:
   \`✅ Handoff document written: <绝对路径>\`
3. 若 \`Write\` 工具不可用(权限/路径限制),把整篇 markdown 用 plain text 输出给用户,提示复制保存到上述路径

## 当前会话上下文

- cwd: \`${p.cwd}\`
- handoff 根目录: \`${p.root}\`
- 日期: \`${p.date}\`
`
}
```

### 2.3 `packages/zai/src/server/services/commands/builtin/handoff/prompts/pickup.ts`(新增)

```ts
interface HandoffFile {
  path: string        // 绝对路径
  mtimeMs: number
}

interface PickupParams {
  cwd: string
  root: string
  date: string
  files: HandoffFile[]              // 已按 mtime 倒序
  pickFile?: string                  // 用户指定
}

function formatFileList(files: HandoffFile[]): string {
  if (files.length === 0) {
    return '(空 — 未找到任何交接文档)'
  }
  return files
    .map((f, i) => {
      const dt = new Date(f.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')
      const name = path.basename(f.path)
      return `${i + 1}. \`${name}\`  (${dt})  \`${f.path}\``
    })
    .join('\n')
}

export function buildPickupPrompt(p: PickupParams): string {
  if (p.files.length === 0) {
    return `# /handoff — 接管现有交接

未找到 \`${p.root}\` 下的交接文档。

建议:
- 用户先用 OpenCC CLI 跑一次 \`/handoff\` 生成首份交接
- 或在当前对话中描述要交接的内容,LLM 据此手动起草并保存到 \`${p.root}/<task-slug>-${p.date}.md\`
`
  }

  if (p.pickFile) {
    const target = p.files.find((f) => path.basename(f.path) === p.pickFile)
      ?? p.files.find((f) => f.path.endsWith(p.pickFile!))
    if (!target) {
      throw new HandoffArgsError(
        `--pick 指定的文件不存在:${p.pickFile}\n可选:${p.files.map(f => path.basename(f.path)).join(', ')}`,
      )
    }
    return `# /handoff — 接管指定交接

请用 \`Read\` 工具读取以下交接文档,据此继续当前会话:

- 路径: \`${target.path}\`

读取后请向用户简短确认你已接手,然后继续工作。
`
  }

  // 多文件无指定:让 LLM 用 AskUserQuestion 工具问用户挑
  return `# /handoff — 接管现有交接

\`${p.root}\` 下找到 ${p.files.length} 份历史交接文档(按 mtime 倒序):

${formatFileList(p.files)}

## 操作要求

1. 用 \`AskUserQuestion\` 工具(已在 zai 启用)向用户提问:
   - Question: "请选择要接管的交接文档"
   - Options: 用上面列表前 5 个文件作为选项(label 用文件名,description 用日期 + 路径)
   - header: "Pick handoff"

2. 用户选择后,用 \`Read\` 工具读取对应文件路径,据此继续当前会话。

3. 若用户选择"None of the above"或取消,询问用户希望新建交接还是结束当前会话。
`
}
```

### 2.4 vendor fs 工具的 zai 复用路径

vendor 的 `listHandoffs` / `getLatestHandoff` / `buildHandoffPath` 在 `packages/zn-agent-core/src/opencc-src/commands/handoff/handoff.ts`,签名只接 `root: string` / `root + task + date`,**无 context 依赖**,可直接复用。

实现阶段需要做一件**小改造**(不修改 vendor 源码,只新增 re-export):

| 选项 | 说明 | 推荐 |
|------|------|------|
| A. 在 `packages/zn-agent-core/src/compat/commands/handoffFs.ts` 加 re-export 文件 | 最直接;`compat/` 是 zai 专属别名载体,符合 AGENTS.md 约束 | ✅ |
| B. 让 zai 直接用相对路径 import | 跨 workspace 不行,会被 TS path 解析挡住 | ❌ |
| C. 把 fs 工具搬到 zai 自身 | 失去跨工具可读;vendor CLI 也用不到 | ❌ |

选 A。具体加 `packages/zn-agent-core/src/compat/commands/handoffFs.ts`:

```ts
export {
  listHandoffs,
  getLatestHandoff,
  buildHandoffPath,
} from '../../opencc-src/commands/handoff/handoff'
```

zai 端 import:
```ts
import { listHandoffs, getLatestHandoff, buildHandoffPath } from '@zn-ai/zn-agent-core'
// 上面的 import 路径由 zn-agent-core 的 index.ts 暴露(实现阶段核对 surface)
```

如果 `@zn-ai/zn-agent-core` 顶层未暴露,实现时改用子路径 import:`@zn-ai/zn-agent-core/compat/commands/handoffFs`(参照 AGENTS.md 的子路径 dist 约定)。

## 3. 数据流

```
[用户] 在 web /agent 或 mobile /m composer 输 "/handoff [--pick foo]"
   │
   ▼
[前端 AgentInputBox / MobileAgent]
   │  mount 时:fetch('/api/slash') → 拿到 handoff 项
   │  用户输 /:从缓存项选中
   │  POST /agent/command {name:'handoff', args:'', sessionId}
   ▼
[后端 routes/command.ts:55-62]
   │  try {
   │    const blocks = await cmd.getPromptForCommand(args, context)
   │    const text = blocks.map(b => b.type==='text' ? b.text : '').filter(Boolean).join('\n')
   │    return res.json({ type:'prompt', payload:{ rendered: text } })
   │  } catch (err) {
   │    console.error('[handoff] handler failed:', err)
   │    return res.json({ type:'error', payload:{ message: err.message } })
   │  }
   ▼
[handler handoffCommand.ts]
   │  parseArgs(args)         → {pickFile?: string}
   │  resolveCwd(context)     → '/Users/x/project'
   │  root = cwd + '.agent_working_dir/handoff'
   │  assistantCount = await countAssistantMessages(context)
   │  taskListText = await readTaskListText(context)
   │  isPickup = pickFile !== undefined || assistantCount <= 4
   │  ┌─ isPickup ─────────────────────────────────────┐
   │  │ files = await listHandoffs(root)               │
   │  │ text = buildPickupPrompt({cwd, root, date, files, pickFile}) │
   │  └────────────────────────────────────────────────┘
   │  ┌─ !isPickup ────────────────────────────────────┐
   │  │ text = buildGeneratePrompt({cwd, root, date, taskListText}) │
   │  └────────────────────────────────────────────────┘
   │  return [{type:'text', text}]
   ▼
[后端] 提纯 text → {type:'prompt', payload:{rendered}}
   ▼ JSON
[前端 AgentInputBox.tsx:575-583]
   │  pushUserMsg('/handoff', false)         ← 显示给用户
   │  submitPrompt(rendered, {skipPushUserMsg: true})  ← 作为模型输入
   ▼
[LLM(zai 当前对话)] 用 zai 工具体系执行:
   │  PICKUP 模式:
   │    ├─ 1 文件:Read 该文件 → 据此继续
   │    ├─ 多文件:AskUserQuestion 让用户挑 → Read 选中的文件
   │    └─ 0 文件:prompt 已说明无历史,LLM 跟用户解释
   │  GENERATE 模式:
   │    Write '<root>/<task-slug>-<date>.md' → 回执 '✅ Handoff document written: ...'
   ▼
[磁盘] <cwd>/.agent_working_dir/handoff/<task-slug>-2026-08-16.md
       (跨工具可读:opencc CLI 也能扫到)
```

### 3.1 关键数据形状

| 阶段 | 形状 |
|------|------|
| SlashItem 列表项 | `{name:'handoff', description:'...', argumentHint:'[--pick <filename>]', type:'prompt', kind:'command', source:'builtin', isBuiltIn:true}` |
| Command 请求 | `{name:'handoff', args:'', sessionId?}` |
| Command 响应 | `{type:'prompt', payload:{rendered: string}}` 或 `{type:'error', payload:{message}}` |
| Handler 内部 | `{cwd, root, assistantCount, taskListText, files: {path, mtimeMs}[], pickFile?, date}` |
| 提示词文本 | 多行 markdown,章节化 |

## 4. 错误处理

8 类失败场景全覆盖:

| # | 场景 | 检测 | 处理 |
|---|------|------|------|
| 1 | args 解析失败(`--pick` 无值/未知 flag) | `parseArgs()` 抛 `HandoffArgsError` | 顶层 try/catch → `{type:'error', payload:{message:'用法:/handoff [--pick <filename>]'}}` |
| 2 | cwd 不可用(`context.cwd` 空,`process.cwd()` 抛) | `resolveCwd()` 兜底链断 | 抛 `HandoffCwdError`,顶层 try/catch 兜住 |
| 3 | `.agent_working_dir/handoff/` 不存在 | `listHandoffs()` 已 `try/catch` 返回 `[]` | 自然走"PICKUP 0 文件"分支 |
| 4 | PICKUP 0 文件(首次运行/换新 cwd) | `files.length === 0` | pickup prompt 提示用户;不阻断 |
| 5 | GENERATE 时 TaskList 不可用 | `readTaskListText()` 抛 / 返回 null | generate prompt 内嵌"(未提供)"占位,LLM 从对话上文推断 |
| 6 | fs 操作超时 | `listHandoffs` / `readTaskListText` 5s timeout | 超时降级到空结果,`console.warn`,不阻断 |
| 7 | LLM 写文件失败(Write 工具权限/路径限制) | 不在 handler 责任内 | generate prompt 内给 LLM 兜底指引(plain text 输出让用户手动保存) |
| 8 | handler 内部抛未捕获异常 | routes/command.ts prompt 分支无 try/catch | **本 spec 改造点**:prompt 分支外包 try/catch(见代码块) |

### 4.1 `routes/command.ts` 的具体改造

**当前**(lines 55-62):

```ts
const blocks = await cmd.getPromptForCommand(args, context)
const text = blocks.map((b: any) => b.type === 'text' ? b.text : '').filter(Boolean).join('\n')
return res.json({ type: 'prompt', payload: { rendered: text } })
```

**改后**:

```ts
try {
  const blocks = await cmd.getPromptForCommand(args, context)
  const text = blocks
    .map((b: any) => (b.type === 'text' ? (b as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n')
  return res.json({ type: 'prompt', payload: { rendered: text } })
} catch (err) {
  console.error('[handoff] handler failed:', err)
  return res.json({
    type: 'error',
    payload: {
      message: `生成交接提示失败:${err instanceof Error ? err.message : String(err)}`,
    },
  })
}
```

**作用域最小化**:只包 `getPromptForCommand` 调用,不包后面的 `res.json`(错误路径已 return);不改动 local 命令分支(避免影响 `/clear` / `/compact` / `/status`)。改动影响范围 ≤ 10 行。

**为什么不用 HTTP 500**:zai 前端 `dispatchCommand` 已按 `result.type` 分发,error 分支会渲染 toast;500 落到 `fetch` reject 路径体验更差。

## 5. 测试

按 AGENTS.md "功能改动后只跑相关单元测试"规则:

### 5.1 新增单测

**`packages/zai/src/server/services/commands/builtin/handoffCommand.test.ts`**:

| 测试块 | 用例 |
|--------|------|
| `parseArgs` | 空 args → `{}` / `--pick foo` → `{pickFile:'foo'}` / `--pick foo --pick bar` 后者覆盖 / `--pick`(无值抛 `HandoffArgsError`)/ 未知 flag 抛 / 多余 token 抛 |
| `resolveCwd` | context.cwd 提供 → 返回 / 不提供 → fallback process.cwd / 全部不可用抛 `HandoffCwdError` |
| `buildGeneratePrompt` | 输出包含关键章节标识(`Task title` / `Original Request` / `Goal` / `Artifacts` / `Key Findings` / `Pitfalls` / `Current TaskList` / `Next Steps` / `Skills Used`)/ 嵌入 cwd / date / taskListText 占位 |
| `buildPickupPrompt` | 0 文件(友好提示文案)/ 1 文件(pick 路径)/ 2+ 文件(列表 + AskUserQuestion 指令)/ `--pick` 指定(跳过列表)/ `--pick` 指定但文件不存在抛 `HandoffArgsError` |
| `listHandoffs` 集成 | tmpdir + 真实 fs 创建 2 个 `.md` 验证 mtime 倒序 / 不存在目录返回 `[]` / 非 .md 文件被过滤 |
| `handoffCommand.getPromptForCommand` 端到端 | mock context(assistantCount=2 → PICKUP 分支)/ mock context(assistantCount=10 → GENERATE 分支)/ `--pick foo` → 强制 PICKUP / GENERATE + taskListText=null → 走占位 |

### 5.2 改动的现有测试

**`packages/zai/src/web/src/components/AgentInputBox.test.tsx`**:
- 在 `vi.stubGlobal('fetch', ...)` 的 `/api/slash` mock 数据 items 数组里加入 handoff 项(1 行)
- 加 1 个断言:列表渲染包含 "handoff"

**`packages/zai/src/server/services/commands/registry.test.ts`**(若不存在则新增):
- `getCommandRegistry().list()` 包含 handoff,字段对齐

**`packages/zai/test/server/routes/command.test.ts`**(若不存在则新增):
- POST `/agent/command {name:'handoff', args:''}` → 200 + `{type:'prompt', payload:{rendered: 非空 string}}`
- 触发 handler 抛错 → 返回 `{type:'error', payload:{message}}`(验证段 4.1 的 try/catch)

### 5.3 真实浏览器验收(强制,AGENTS.md)

按 AGENTS.md 强制项,完成实现后必须用 `/ego-browser` 走真实路径:

1. `pnpm run build:core`(改 compat 暴露后必跑)
2. 启动独立 zai 实例(避开 920x 正式端口,显式 `--port 8101`)
3. `/ego-browser` 验证:
   - 访问 `http://localhost:8101/agent`,在 composer 输 `/`,下拉里能看到 **handoff** 项
   - 输 `/handoff`,发送,确认前端显示 `/handoff` 作为 user msg,且对话里出现 prompt 渲染结果(`preparing handoff` 进度 + 渲染文本作为模型输入)
   - 切到 `http://localhost:8101/m`,重复同样两步验证
   - 让 LLM 实际生成一份 handoff,`ls <cwd>/.agent_working_dir/handoff/` 确认文件落盘
   - 反向:用 opencc CLI 在同 cwd 写一份 handoff,回到 zai web 端 `/handoff` 触发 PICKUP,确认列表里能看到该文件

### 5.4 不写的测试(YAGNI)

- 不写 prompt 文本**精确字符串**断言(章节名稳定即可,模板措辞可能微调)
- 不写 LLM 写文件后的端到端断言(由浏览器验收覆盖)
- 不为 `/clear` / `/compact` / `/status` 加改动回归测试(本 spec 不动它们)

### 5.5 跑测命令(改动后)

```bash
# 直接受影响
pnpm --filter @zn-ai/zai test \
  src/server/services/commands/builtin/handoffCommand.test.ts \
  src/web/src/components/AgentInputBox.test.tsx \
  test/server/routes/command.test.ts

# build 验证(改 core 后必跑)
pnpm run build:core
pnpm -r exec tsc --noEmit

# 真实浏览器验收
/ego-browser
```

## 6. 设计自审

- [x] 没有 placeholder / TBD:`countAssistantMessages` / `readTaskListText` 都有显式 fallback(`+Infinity` / `null`),spec 段 4 错误处理 #5、#2 已对齐;vendoring re-export 文件路径也已收口到选项 A
- [x] 内部一致:组件接口 / 数据流 / 错误处理 / 测试 各段对齐(`pickFile` 强制 PICKUP / `assistantCount ≤ 4` / `root = .agent_working_dir/handoff` / 中文 prompt 模板在 generate.ts 和 pickup.ts 内对齐 vendor 章节结构)
- [x] 范围聚焦:只加 handoff 一个命令 + 一次 routes/command.ts try/catch 改造 + compat 层一个 re-export 文件,无无关 refactor
- [x] 歧义消解:`--pick` 强制 PICKUP / cwd fallback 链 / TaskList 缺失降级 / `Write` 工具不可用兜底 / LLM 写失败回退 plain text / 错误统一 error 分支 / mobile 与 web 共享同一来源
- [x] AGENTS.md 强制项覆盖:`build:core` + 真实浏览器验收 + 不全量跑测试
- [x] vendor 兼容性:复用 fs 工具 + prompt 章节结构对齐 + 文件路径 `.agent_working_dir/handoff/`
- [x] 移动端:`/m` 通过 `/api/slash` 同一来源自动支持,前端 SlashItem 已 handle prompt 响应

## 7. 不在本 spec 范围

- 不实现 vendor 的 `local-jsx` 形态(无 vendor UI 在 web 端)
- 不把 handoff 加进 `BRIDGE_SAFE_COMMANDS`(那是 opencc CLI 内部白名单,不在 zai 范围)
- 不在 zai 新增 LLM 调用通道(handler 不直接调 LLM)
- 不实现跨 session 的 handoff 索引(每次按 cwd 扫本地目录)
- 不做 handoff 文档的语法/lint 校验(LLM 自行负责)
