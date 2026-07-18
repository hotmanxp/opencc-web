# zai-agent-core: SKILL 读取与 Skill 工具 — 设计规格

> 文档版本: 1.0 · 2026-07-10 · 状态: 设计已敲定, 待用户 review

## 0. 背景

`@zn-ai/zai-agent-core` 当前 `RuntimeConfig.enabledSkills?: string[]` 字段已声明但**完全没读**；`src/opencc-internals/skills/` 下的 CV 自 OpenCC 的 skill 源码（`loadSkillsDir.ts` / `bundledSkills.ts` / `mcpSkillBuilders.ts` / `mcpSkills.ts`）未被 runtime 调用；`runtime/index.ts` 没有导出任何 skill 相关 API；`src/tools/` 下没有 `SkillTool`。

`queryLoop.buildSystemPrompt()` 只拼接 `systemPrompt + AGENTS.md`，没有 skill 段；`resolveToolPool()` 没把 skill 派生出的工具纳入工具池。

要让 zai 的 main agent 能像 OpenCC 一样看到「可用 skill 列表」并通过 `Skill` 工具触发 skill prompt 注入，必须在 `runtime/skills/` 下新增独立 loader，并在 `tools/SkillTool/` 下新增 Skill 工具。本 spec 决定如何接入。

## 1. 高层架构

```
┌──────────────────────────────────────────────────────────────┐
│                  @zn-ai/zai-agent-core                        │
│                                                              │
│   ┌────────────────────────────────────────────────────┐    │
│   │  src/runtime/  (facade + 最小 query loop)            │    │
│   │  query() / abortSession() / DefaultAgentRuntime     │    │
│   │  queryLoop.ts (zai 自写 loop, 本 spec 改动)         │    │
│   │  toolExecution.ts / subagent.ts / canUseTool.ts     │    │
│   │                                                    │    │
│   │  + src/runtime/skills/    (本 spec 新建)             │    │
│   │    frontmatter.ts    (zai-only YAML 最小解析)        │    │
│   │    loader.ts         (扫 SKILL.md, realpath 去重)     │    │
│   │    promptBuilder.ts  (生成 <skills> XML 段)          │    │
│   │    index.ts          (公共 re-export)                │    │
│   └────────────────────┬─────────────────────────────────┘    │
│   ┌────────────────────▼─────────────────────────────────┐    │
│   │  src/tools/  (zai 真实实现, 本 spec 新增 SkillTool)  │    │
│   │  BashTool / AgentTool / FileRead / FileEdit / ...   │    │
│   │  + SkillTool/                                       │    │
│   │    SkillTool.ts    (把 skill body 注入同会话)        │    │
│   │    prompt.ts       (tool description)               │    │
│   │    schema.ts       (zod input schema)               │    │
│   └─────────────────────────────────────────────────────┘    │
│   ┌─────────────────────────────────────────────────────┐    │
│   │  src/opencc-internals/  (CV 镜像, 仍只读)            │    │
│   │  skills/*             本 spec **不引用**              │    │
│   │  settings/*           本 spec **不引用**              │    │
│   │  其他                 仍只读                          │    │
│   └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### 1.1 沿用的核心约束

- 不读 OpenCC `settings.json`，zai 独立 `~/.zai/settings.json`
- 不读 OpenCC 默认 skill 路径（`~/.agents/skills`、`~/.claude/skills`），zai 用 `RuntimeConfig.skillsDirs` 显式配置
- 所有错误走 `RuntimeErrorEvent` 流式事件
- zai-agent-core 零 LLM SDK、零沙箱、零 npm 依赖增量（不引入 lodash-es / ignore / yaml）

### 1.2 新增约束（本 spec 决定）

- `src/runtime/skills/` 不依赖 `src/opencc-internals/`（避免拽入 OpenCC settings、frontmatterParser、markdownConfigLoader、analytics 等十几模块）
- frontmatter 用自写最小 YAML parser（只支持 skill 用到的字段）
- 暂不实现 managed / plugin / MCP skill 三类 source；预留 source-tagged 数据结构，将来扩展时无需改 loader 主路径
- 暂不执行 skill frontmatter 中声明的副作用字段（hooks、shell、conditional paths）；先解析 + 暴露 metadata，预留 hook

## 2. 配置与字段

### 2.1 `RuntimeConfig` 扩展

```ts
// src/runtime/types.ts
export type RuntimeConfig = {
  // ...existing fields...
  /** 显式配置的 skill 目录白名单。空数组或不传 = 不加载 skill。 */
  skillsDirs?: string[]
  /** 是否向 tool pool 注册 SkillTool。默认 true 当 skillsDirs 非空。 */
  enableSkillTool?: boolean
}
```

> 旧的 `enabledSkills?: string[]`（skill 名白名单语义）由本 spec 替换为 `skillsDirs`（目录路径白名单，语义见 1.1）。如有外部调用方在使用旧字段，需同步迁移。

### 2.2 `QueryOptions` 扩展

```ts
// src/runtime/types.ts
export type QueryOptions = {
  // ...existing fields...
  /** 单次请求级 skillsDirs 覆盖，优先级高于 RuntimeConfig.skillsDirs */
  skillsDirs?: string[]
}
```

### 2.3 `SkillFrontmatter`（zai 自有类型）

```ts
// src/runtime/skills/types.ts
export type SkillFrontmatter = {
  name?: string                       // 显示名，默认用目录名
  description?: string                 // 可选: 缺失时由 loader 从 markdown body 第一段提取（与 OpenCC 一致）
  when_to_use?: string
  version?: string
  model?: string
  'disable-model-invocation'?: boolean
  'user-invocable'?: boolean
  'allowed-tools'?: string[]
  'argument-hint'?: string
  arguments?: string | string[]
  context?: 'fork'
  agent?: string
  effort?: string | number
  shell?: string
  hooks?: Record<string, unknown>
  paths?: string | string[]
  [k: string]: unknown                // 未声明字段保留原始值
}
```

第一版实现 = **解析 + 暴露**全部字段，但不实现 execution 副作用：
- `hooks` — 存为 metadata，未挂载事件
- `shell` — 存为 metadata，未在 prompt body 执行 `!`...` 内联 shell
- `paths` — 存为 metadata，未实现 conditional activation（运行时无条件加载）
- `user-invocable` / `context` / `agent` / `effort` — 存为 metadata，zai 当前不读
- `allowed-tools` — 存为 metadata，本版 SkillTool 不做工具可见性过滤（避免与 canUseTool 双层策略冲突）

## 3. Loader 实现

### 3.1 文件位置与公开 API

```
src/runtime/skills/
├── types.ts              SkillFrontmatter, LoadedSkill
├── frontmatter.ts        parseSkillFrontmatter(raw: string): { frontmatter, body }
├── loader.ts             loadSkillsFromDirs(dirs, opts?): Promise<LoadedSkill[]>
├── promptBuilder.ts      buildSkillsSystemPrompt(skills): string | null
└── index.ts              公共 re-export
```

### 3.2 `LoadedSkill`

```ts
export type LoadedSkill = {
  /** 唯一名：相对 dirs[i] 的路径, 用 ':' 分隔命名空间 */
  name: string
  /** skill 所在绝对目录, 用于 ${CLAUDE_SKILL_DIR} 替换 */
  baseDir: string
  /** SKILL.md 绝对路径 */
  filePath: string
  /** 解析后的 frontmatter（description 已 fallback 到 markdown body 提取值）*/
  frontmatter: SkillFrontmatter
  /** markdown body (去掉 frontmatter) */
  markdown: string
  /** 来源目录索引 (用于追溯) */
  sourceIndex: number
}
```

### 3.3 `loadSkillsFromDirs`

```ts
export async function loadSkillsFromDirs(
  dirs: string[],
  opts?: { cwd?: string; homedirOverride?: string }
): Promise<LoadedSkill[]>
```

**扫描规则：**
- 对每个 `dirs[i]`，递归查找 `**/SKILL.md`（大小写不敏感，文件名匹配 `/^skill\.md$/i`）
- 跳过根目录直接放置的 `SKILL.md`（与 OpenCC 一致，要求目录格式 `<skill-name>/SKILL.md`）
- `name` = `<dirs[i]/<relative path from dirs[i]>>`，多级目录用 `:` 拼接命名空间
  - 例：`/skills/pdf/SKILL.md` 在 `/skills` 下 → `name = 'pdf'`
  - 例：`/skills/code-review/go/SKILL.md` → `name = 'code-review:go'`
- 跨目录去重：同一 SKILL.md 通过符号链接或重叠父目录出现时，用 `realpath` 去重，**保留第一次出现**（first-wins）
- 单文件解析失败 → `console.warn` + 跳过，不阻断其他 skill
- 不存在的目录 → 静默跳过（与 `loadAgentsMd` 行为一致）

**description 提取：**
- 若 frontmatter 含 `description` → 用 frontmatter 值
- 若 frontmatter 不含 → 从 markdown body 提取第一段非空文本作为 description（与 OpenCC `extractDescriptionFromMarkdown` 行为一致）
- 若 body 也无 → 抛错 warn-skip 该 skill

**实现要点：**
- 使用 `node:fs/promises` 的 `readdir`（withFileTypes: true）+ 递归 walk
- 不引入 `ignore` 库做 conditional 过滤（本 spec 不实现 conditional paths）
- 不引入 `lodash-es/memoize` 做缓存（每次 query 重新加载，简单可测；将来按需加 LRU 缓存）

### 3.4 `frontmatter.ts` 自写最小 YAML 解析

```ts
export function parseSkillFrontmatter(
  raw: string,
  filename?: string,         // 仅用于错误信息
): { frontmatter: SkillFrontmatter; body: string }
```

**支持语法（最小集）：**
- `key: value` 标量（value 自动 trim）
- `key: 'string with spaces'` 单引号字符串
- `key: "string with spaces"` 双引号字符串
- `key:`（空值 → `undefined`）
- `key:` 紧接多行缩进列表（`- item` / `- 'quoted item'` / `- "quoted item"`）→ `string[]`
- 布尔：`true` / `false` / `'true'` / `'false'`
- 注释：`# comment` 行（自 YAML 1.1 起 YAML 支持但 OpenCC frontmatter 不常用，本版**不支持**，避免解析歧义）
- 多行字符串：用 `|` / `>` 折叠（**不支持**，仅支持单行 string 字段）
- 嵌套对象：仅 `hooks` 字段为对象，本版**作为 `Record<string, unknown>` 整体保留原文**，不展开

**分隔符规则：** 与 OpenCC 一致，行首 `^---\n` 开始，行内 `\n---\n` / 末尾 `\n---$` 结束。

**错误处理：** 解析失败 → 抛 `Error` 含文件名 + 行号，由 `loader.ts` 捕获并 warn-skip。

### 3.5 `promptBuilder.ts`

```ts
export function buildSkillsSystemPrompt(skills: LoadedSkill[]): string | null
```

**输出格式：**

```
The following skills are available for use with the Skill tool:

<skills>
<skill>
<name>pdf</name>
<description>Read, annotate, and extract text from PDF files.</description>
<when_to_use>When the user provides a PDF or asks to extract its content.</when_to_use>
</skill>
<skill>
<name>code-review:go</name>
<description>...</description>
</skill>
</skills>

When a skill matches the user's intent, invoke it via the Skill tool with the skill name as the `name` argument. Only the frontmatter (name/description) is shown above; the full skill body is injected on invocation.
```

- 空数组 → 返回 `null`（与 `buildAgentsMdSystemPrompt` 一致）
- 只暴露 frontmatter `name` / `description` / `when_to_use` 三个字段，**不暴露 markdown body**（节省 token）
- 在 `queryLoop.buildSystemPrompt()` 中拼到 AGENTS.md 段之后

## 4. SkillTool 设计

### 4.1 文件位置

```
src/tools/SkillTool/
├── SkillTool.ts       (主体)
├── prompt.ts          (description 文本)
└── schema.ts          (zod input schema)
```

### 4.2 Schema

```ts
// src/tools/SkillTool/schema.ts
import { z } from 'zod'

export const SkillInputSchema = z.object({
  name: z.string().min(1).describe('The skill name to invoke (e.g. "pdf", "code-review")'),
  args: z.string().optional().describe('Arguments to substitute into the skill body via $ARGUMENTS / $1..$N'),
})
```

### 4.3 主体

```ts
// src/tools/SkillTool/SkillTool.ts
import { z } from 'zod'
import type { Tool, ToolContext } from '../Tool.js'
import { renderPrompt } from './prompt.js'
import { SkillInputSchema } from './schema.js'
import type { LoadedSkill } from '../../runtime/skills/index.js'

type SkillInput = z.infer<typeof SkillInputSchema>

export const SkillTool: Tool<typeof SkillInputSchema, string> = {
  name: 'Skill',
  description: renderPrompt(),
  inputSchema: SkillInputSchema,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,

  async call(rawInput, ctx) {
    const { name, args } = rawInput as SkillInput
    const skills: LoadedSkill[] = (ctx.state.__zaiSkills as LoadedSkill[] | undefined) ?? []
    const skill = skills.find(s => s.name === name)
    if (!skill) {
      return {
        output: `Skill '${name}' not found. Available skills: ${skills.map(s => s.name).join(', ') || '(none)'}`,
        isError: true,
      }
    }

    // 1. 参数替换: ${CLAUDE_SKILL_DIR} / ${CLAUDE_SESSION_ID} / $ARGUMENTS / $1..$N
    let body = skill.markdown
    if (skill.baseDir) {
      const skillDir = process.platform === 'win32'
        ? skill.baseDir.replace(/\\/g, '/')
        : skill.baseDir
      body = body.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
    }
    body = body.replace(/\$\{CLAUDE_SESSION_ID\}/g, ctx.parentSessionId ?? 'sess-unknown')
    if (args !== undefined) {
      const argNames = Array.isArray(skill.frontmatter.arguments)
        ? skill.frontmatter.arguments
        : typeof skill.frontmatter.arguments === 'string'
          ? [skill.frontmatter.arguments]
          : []
      body = substituteArguments(body, args, true, argNames)
    }

    // 2. 标记注入: queryLoop 在 tool 结果写入 messages 之后追加一次 user 消息
    ctx.state.__pendingSkillInjection = {
      skillName: skill.name,
      content: body,
    }

    // 3. 返回 tool result content (model 看到 skill body)
    return {
      output: `<skill_invocation name="${skill.name}">\n${body}\n</skill_invocation>`,
      isError: false,
    }
  },
}
```

**`substituteArguments` 行为（与 OpenCC 对齐）：**
- `$ARGUMENTS` → 整个 args 字符串
- `$1` / `$2` ... → args 按空格分割后的第 N 个
- `$NAME`（在 frontmatter `arguments` 列表里声明）→ args 整体
- 多行 args：`$@` 同样整体替换

### 4.4 Tool 提示文本 `prompt.ts`

```ts
export function renderPrompt(): string {
  return `Invoke a skill by name. The skill body is injected as a user message for the current session.

Args:
  - name: The skill name as listed in the <skills> block of the system prompt
  - args: Optional argument string to substitute into the skill body

The skill's full markdown body becomes available to you after invocation. Invoke a skill only when its description matches the user's request.`
}
```

### 4.5 决策要点

- **不 fork 子会话**（与 OpenCC skill 行为一致；用户决策「同会话 prompt 注入」）
- **不执行 skill body 中的内联 shell**（`!`...`` / ` ```! ... ``` ` 块），本版不解析（OpenCC 的 `executeShellCommandsInPrompt` 留给后续 spec）
- **不实现 hooks 触发**（`PreToolUse` / `PostToolUse` / `Stop` 等）
- **`isReadOnly` 返回 false**：保守策略；实际副作用取决于 skill body，zai 当前没有静态分析能力
- **tool pool 注册条件**：`skills.length > 0 && config.enableSkillTool !== false`

## 5. queryLoop 接入

### 5.1 改动点 1: tool pool

```ts
// queryLoop.ts (resolveToolPool)
const { getZaiRuntimeTools } = await import('../tools/index.js')
const { SkillTool } = await import('../tools/SkillTool/SkillTool.js')

function resolveToolPool(
  options: QueryOptions,
  config: RuntimeConfig,
  base: Tool[],
  skills: LoadedSkill[],
): Tool[] {
  const preset = options.toolsOverride ?? 'base+subagent'
  const skillToolEnabled = skills.length > 0 && (config.enableSkillTool ?? true)
  const skillTool = skillToolEnabled ? [SkillTool] : []
  if (preset === 'none') {
    return [...(options.additionalTools ?? []), ...skillTool]
  }
  return [...base, ...skillTool, ...(options.additionalTools ?? [])]
}
```

### 5.2 改动点 2: skill 加载 + 注入到 ToolContext

```ts
// queryLoop.ts (主循环前)
const skillsDirs = options.skillsDirs ?? config.skillsDirs ?? []
const skills = skillsDirs.length > 0 ? await loadSkillsFromDirs(skillsDirs, { cwd: options.cwd }) : []
const tools = resolveToolPool(options, config, getZaiRuntimeTools(), skills)
```

```ts
// makeToolContext
function makeToolContext(
  options: QueryOptions,
  config: RuntimeConfig,
  _sessionId: string,
  abortController: AbortController,
): ToolContext {
  const baseSandbox = config.sandbox ?? { executor: 'child_process' as const, workdir: options.cwd }
  const sandbox: SandboxConfig = { ...baseSandbox, workdir: options.cwd || baseSandbox.workdir }
  return {
    cwd: options.cwd,
    env: process.env as Record<string, string>,
    abortSignal: abortController.signal,
    dataDir: config.dataDir,
    canUseTool: defaultCanUseToolFactory(sandbox),
    emitEvent: () => { /* events already yielded */ },
    state: { __zaiSkills: skills },          // ↓ skills 放到 state 下，与 __lastToolResults / __pendingSkillInjection 同层
    __runtimeConfig: { ...config, sandbox },
    __defaultModel: options.model ?? config.defaultModel ?? 'default',
    __maxTurns: options.maxTurns ?? config.defaultMaxTurns ?? DEFAULT_MAX_TURNS,
    parentSessionId: options.parentSessionId,
  }
}
```

> `ToolContext.state.__zaiSkills` 是内部字段，不进入公开类型；SkillTool 通过 `ctx.state.__zaiSkills` 读取（与第 4.3 节一致）。

### 5.3 改动点 3: system prompt 拼接

```ts
// buildSystemPrompt
async function buildSystemPrompt(options: QueryOptions, skills: LoadedSkill[]): Promise<string> {
  const parts: string[] = []
  if (options.systemPrompt) {
    parts.push(typeof options.systemPrompt === 'string'
      ? options.systemPrompt
      : options.systemPrompt.map(b => JSON.stringify(b)).join('\n'))
  }
  if (options.enableAgentsMd !== false) {
    try {
      const agentsMd = await loadAgentsMd(options.cwd)
      parts.push(buildAgentsMdSystemPrompt(agentsMd) ?? '')
    } catch { /* AGENTS.md 缺失, 静默降级 */ }
  }
  // ↓ 新增 skill 段
  const skillsPrompt = buildSkillsSystemPrompt(skills)
  if (skillsPrompt) parts.push(skillsPrompt)
  return parts.filter(Boolean).join('\n\n')
}
```

### 5.4 改动点 4: skill 注入到 messages

```ts
// queryLoop.ts (tool result 写入 messages 之后, 下一轮 model 调用之前)
messages.push({ role: 'user', content: toolUseBlocks.map((t, i) => ({
  type: 'tool_result',
  tool_use_id: t.id,
  content: lastResults[i]?.content ?? '',
  is_error: lastResults[i]?.isError ?? false,
})) })

// ↓ 新增: 处理 SkillTool 触发的 body 注入
const pending = toolCtx.state.__pendingSkillInjection as
  | { skillName: string; content: string }
  | undefined
if (pending) {
  messages.push({ role: 'user', content: pending.content })
  await appendUserMessage(store, sessionId, pending.content, turn)
  toolCtx.state.__pendingSkillInjection = undefined
}
```

**关键不变量：**
- transcript 落盘包含 skill body（用户复盘能看到完整 skill 注入历史）
- messages 顺序：tool_use → tool_result → user(含 skill body) → model 接续（与 OpenCC 一致）
- `__pendingSkillInjection` 在每次消费后清空，避免下一轮误用

### 5.5 `getZaiRuntimeTools()` 不改

SkillTool 不进 `getZaiRuntimeTools()`，由 `resolveToolPool` 按 skills 数量动态注入。这样保证没配 skillsDirs 的用户看不到 Skill 工具，避免无意义的 tool 占用 token。

### 5.6 `enabledSkills` 字段迁移

```ts
// src/runtime/types.ts (迁移期保留旧字段做 alias, 打印 deprecation warn)
export type RuntimeConfig = {
  // ...
  /** @deprecated use skillsDirs (path whitelist) instead */
  enabledSkills?: string[]
  skillsDirs?: string[]
}
```

如检测到 `enabledSkills` 存在但 `skillsDirs` 不存在，zai-server 启动时打印 warn（zai-agent-core 本身不读旧字段，迁移责任在调用方）。本 spec **不实现自动迁移逻辑**，仅在 type 层保留字段以减小 breaking change 面积。

## 6. 测试策略

### 6.1 单元测试

| 文件 | 覆盖 |
|------|------|
| `test/skills/frontmatter.test.ts` | 空 frontmatter、单字段、列表字段、字符串转义、缺失闭合 `---`、未知字段保留 |
| `test/skills/loader.test.ts` | 空目录、不存在目录、单层 SKILL.md、嵌套 SKILL.md、命名冲突、realpath 去重、单文件解析失败跳过 |
| `test/skills/promptBuilder.test.ts` | 空数组 → null；单/多 skill 格式；不暴露 markdown body |

### 6.2 集成测试（`test/runtime/queryLoop.test.ts` 新增）

```ts
test('skillsDirs 非空 → SkillTool 出现在 tool pool', async () => {
  // 准备 tmpDir/skills/pdf/SKILL.md
  // queryLoop 调用, mock modelCaller 返回 Skill(name='pdf') tool_use
  // 验证 messages 含 skill body
})

test('SkillTool 调不存在的 skill → tool_result isError=true', async () => {
  // modelCaller 返回 Skill(name='nope') tool_use
  // 验证 tool_result 含 'not found', isError=true
})

test('SkillTool 注入: tool_result 后追加 user message 含 skill body', async () => {
  // modelCaller 返回 Skill(name='pdf') tool_use
  // 验证 messages 顺序: assistant(tool_use) → user(tool_result) → user(skill body)
  // 验证 transcript 落盘也含 skill body
})

test('skillsDirs 空 → SkillTool 不注册, system prompt 无 <skills> 段', async () => {
  // config.skillsDirs = []
  // 验证 tools 列表不含 Skill
  // 验证 systemPrompt 不含 '<skills>'
})

test('frontmatter 解析失败的 SKILL.md → loader 跳过该文件, 不阻断其他 skill', async () => {
  // 准备两个 skill, 其中一个 frontmatter 不闭合
  // 验证只加载一个, 另一个的 warn 出现
})
```

### 6.3 E2E（手动，zai-server 端）

- 真 LLM 跑「读 PDF」任务，配置 `skillsDirs: ['./fixtures/skills']`，SkillTool 触发后 transcript 能看到完整 skill body 注入
- 真 LLM 跑「code review」任务，使用嵌套 skill（`code-review:go`），验证命名空间正确

### 6.4 不在测试范围

- conditional paths（paths frontmatter）激活逻辑
- hooks 触发
- skill body 内联 shell 执行
- MCP / plugin / bundled skill

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| **frontmatter 解析器与 OpenCC 行为不一致** | 测试覆盖与 opencc-internals/skills/loadSkillsDir.ts 中 `parseSkillFrontmatterFields` 行为对齐；不实现的功能明确标注（注释/嵌套/多行字符串） |
| **skill body 注入消耗 token** | transcript 与 messages 都含 body，模型上下文 = transcript messages（与现有 queryLoop 一致）；不在 system prompt 暴露 body（节省 token） |
| **skill 无限递归**（skill body 调用 SkillTool）| 与 OpenCC 一致，无显式深度限制；zai-server 端可加 `maxSubagentDepth` 软限制（不在本 spec） |
| **`enabledSkills` 旧字段误用** | type 层保留为 deprecated，README 注明；zai-server 启动时检测并 warn |
| **YAML 解析器对 hooks/shell 字段语义不完整** | 这两个字段本版只存 metadata 不执行，解析失败仅 warn；README 注明不支持 `\|` / `>` / 嵌套 map |
| **tool pool 增长影响模型决策** | SkillTool description 与 system prompt 的 `<skills>` 块互相印证，模型能正确决策是否调用 |

## 8. 验收标准

- [ ] `pnpm test` 全部通过，包含新增的 5 个集成测试 + 3 个单元测试文件
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过，dist 产物含 `runtime/skills/*` 和 `tools/SkillTool/*`
- [ ] `RuntimeConfig.skillsDirs` 配置生效，SkillTool 出现在 tool pool
- [ ] 不配 `skillsDirs` 时，SkillTool 不注册，system prompt 无 `<skills>` 段（与现有 queryLoop 行为兼容）
- [ ] SkillTool 调用后，transcript 落盘含完整 skill body
- [ ] frontmatter 解析失败的 SKILL.md 不阻断其他 skill 加载
- [ ] `src/opencc-internals/` 镜像文件 0 修改（git diff 干净）
- [ ] 不新增 npm 依赖（`package.json` dependencies 列表不变）

## 9. 关键决策汇总

| 维度 | 选择 |
|------|------|
| 范围 | file-based skills（frontmatter 全字段解析 + 暴露）+ SkillTool + system prompt 注入 |
| Skill 来源 | 仅 `RuntimeConfig.skillsDirs` 路径白名单 |
| Frontmatter | 自写最小 YAML 解析（不引依赖） |
| SkillTool 执行模型 | 同会话 prompt 注入（写 `ctx.state.__pendingSkillInjection`） |
| SkillTool 是否进 base tool pool | 否，由 `resolveToolPool` 按 `skills.length > 0` 动态注入 |
| OpenCC 镜像 | 完全不动，不引用 |
| 暂不实现 | hooks / shell 内联 / conditional paths / MCP / plugin / bundled skills |

## 10. 未来扩展（本 spec 不实现，留 hook）

- `RuntimeConfig.hooksConfig` 触发 skill frontmatter 中的 PreToolUse / PostToolUse
- skill body 内联 shell 执行（`executeShellCommandsInPrompt` 的 zai 版）
- conditional paths 激活（前端需要时再加 `ignore` 依赖）
- MCP skill（zai MCP servers 配置触发）
- plugin skill（zai plugins/ 目录）
- bundled skill（随包内置）
- Skill 加载缓存（per-session memoize，减少每次 query 的 disk I/O）
- `enabledSkills` 旧字段彻底删除