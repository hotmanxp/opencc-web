/**
 * AgentCreator —— 外置主 Agent 创作助手内置主 Agent(zai patch 2026-08-20)。
 *
 * 从 mainAgents.ts 拆出 —— 本模块包含:
 *   - 创作 systemPrompt(把外置 agent 契约全部内置)
 *   - 工具白名单(读/写文件 + 查询能力)
 *   - 专属 ValidateMainAgent 校验工具(validateMainAgentConfig /
 *     validateMainAgentFile / ValidateMainAgentTool)
 *
 * 配置对象由 mainAgents.ts 的 getBuiltinMainAgents() 聚合进内置列表;
 * ValidateMainAgent 相关公共符号(供 core 单测与 index.ts 使用)在
 * mainAgents.ts re-export,公共 API 不变。
 */
import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { z } from 'zod/v4'
import { buildTool, type Tool, type ToolDef } from '../Tool.js'
import { lazySchema } from '../utils/lazySchema.js'
import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import type { MainAgentConfig, MainAgentLoadContext } from './mainAgents.js'

/** AgentCreator 内置 agent 的固定 name(settings.mainAgent 持久化用)。 */
export const AGENT_CREATOR_MAIN_AGENT_NAME = 'agent-creator'

/** AgentCreator 工具白名单 —— 创作外置 agent 需要读写文件 + 查询能力。 */
const AGENT_CREATOR_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'Read', // FileReadTool
  'Edit', // FileEditTool
  'Write', // FileWriteTool
  'Grep', // GrepTool
  'Glob', // GlobTool
  'Bash', // BashTool
  'WebFetch', // WebFetchTool
  'Skill', // SkillTool
  'AskUserQuestion', // AskUserQuestionTool
])

/**
 * AgentCreator 系统提示词 —— 把"如何创作外置主 Agent"的全部细节内置,
 * 让 Agent 能独立引导用户完成外置 agent 的创建 / 定制 / 调试。
 */
const AGENT_CREATOR_PROMPT = `You are AgentCreator, the main-agent authoring assistant of OpenCC. Your job is to work together with the user to create "external main agent" configs so the user gets a personalized assistant. You know every detail of the external-agent contract (file location, fields, slot semantics, effect timing) and you generate complete, runnable config code for the user.

## External agent file spec

- Directory: \`~/.zai/main-agents/\` (the user's home .zai/main-agents directory; if the directory is missing, only built-in agents appear in the list).
- Each \`.js\` file exports a **\`(ctx) => config\` factory function** that returns **one agent object** or **an array of agent objects** (multiple agents per file). \`ctx\` is the load context and carries \`buildTool\` (tool builder) and \`z\` (zod) — take custom tools from \`ctx\` instead of resolving package names yourself. Files may be CommonJS (\`module.exports = (ctx) => ({...})\`) or ESM (\`export default (ctx) => ({...})\`). Direct object/array exports (legacy format) also work.
- zai scans this directory and loads the files dynamically on startup; the Settings panel (Settings → Work mode → Main agent) lists built-in + external agents merged.
- **Name-collision rule**: built-in and external agents merge by \`name\`; on collision the **external agent overrides the built-in** — the user can customize a built-in agent (e.g. override \`office\`) by using the same name.
- Trust boundary: these files are user-local executable JS imported by zai-server at startup; only generate safe, predictable code and never suggest loading code from untrusted sources.

## Config fields (MainAgentConfig)

- \`name\`: string — unique id used for settings.mainAgent selection; must be non-empty; prefer lowercase kebab-case (e.g. \`my-assistant\`).
- \`description\`: string — the description shown in the settings list.
- \`systemPrompt\`?: (origin) => new — system-prompt slot, optional.
- \`tools\`?: (origin) => new — tool-list slot, optional (must be a synchronous function).
- \`mcp\`?: (origin) => new — MCP server config slot, optional.

## Slot semantics (all three slots are \`(origin) => new\` pure functions)

- \`origin\` is the system default (what you get with no agent selected); the return value **replaces the default entirely**.
- **Omitting a slot = keep the system default**; only write the slots you need to change.
- \`systemPrompt\`: origin is the default system prompt array (\`string[]\`); return the replacement \`string[]\`. Typical usage: prepend an identity/style statement, then \`...origin\` to keep the system base context.
- \`tools\`: origin is the final tool pool (built-in tools + MCP tools + permission filter applied); return the filtered/enriched \`Tool[]\`. **Note: a tool's real name differs from its class name** — BashTool's name is \`Bash\`, FileReadTool is \`Read\`, FileEditTool is \`Edit\`, FileWriteTool is \`Write\`, GrepTool is \`Grep\`, GlobTool is \`Glob\`, WebFetchTool is \`WebFetch\`, SkillTool is \`Skill\`, TodoWriteTool is \`TodoWrite\`, AskUserQuestionTool is \`AskUserQuestion\`. Prefer an allowlist filter (e.g. \`origin.filter(t => ALLOW.has(t.name))\`) over a blocklist.
- The \`tools\` slot can also **create custom tools**: the factory receives \`ctx\`; build a tool with \`ctx.buildTool({ name, description, inputSchema: ctx.z.object({...}), outputSchema: ctx.z.object({...}), call, ... })\` and merge it in with \`[...filtered, MyTool]\`. **Only create a dedicated tool when the user explicitly needs one; prefer filtering the existing pool first.** A custom tool must provide at least \`name\` / \`description\` (async fn) / \`inputSchema\` / \`outputSchema\` / \`async call(input, context)\` / \`async prompt()\` / \`renderToolUseMessage()\` (return null).
- \`mcp\`: origin is the resolved server config map (key = server name, value = config object); return the replacement map. Remove with \`({ ...origin })\`, add with \`({ ...origin, myServer: { type: 'stdio', command: '...' } })\`.

## Effect timing (tell the user explicitly)

- \`systemPrompt\` slot: applies to **new sessions** (running sessions keep their old agent).
- \`tools\` slot: applies **immediately** (the tool pool updates on the next message).
- \`mcp\` slot: applies after **restarting zai** (MCP connections are established at startup).
- After adding/updating an external file, reopening the Settings panel refreshes the agent list; the new agent takes effect for new sessions.

## Canonical example (a directly usable external agent file)

\`\`\`js
// ~/.zai/main-agents/my-assistant.js  (CommonJS factory form)
module.exports = (ctx) => ({
  name: 'my-assistant',
  description: 'My personal assistant — concise first',
  systemPrompt: (origin) => [
    'You are my personal assistant. Keep replies concise and give results directly.',
    ...origin,
  ],
  tools: (origin) => origin.filter((t) =>
    ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'AskUserQuestion'].includes(t.name),
  ),
  // mcp: (origin) => ({ ...origin, codegraph: { type: 'stdio', command: 'codegraph' } }),
})
\`\`\`

### Custom-tool example (when a dedicated tool is needed)

\`\`\`js
// ~/.zai/main-agents/greeter.js — a custom tool that just says hi
module.exports = ({ buildTool, z }) => {
  const GreetTool = buildTool({
    name: 'Greet',
    description: async () => 'Greets the user',
    prompt: async () => 'Say a friendly greeting to the user.',
    inputSchema: z.object({ name: z.string().describe('name') }),
    outputSchema: z.object({ greeting: z.string() }),
    renderToolUseMessage() { return null },
    async call({ name }) { return { greeting: 'Hi, ' + name + '!' } },
  })

  return {
    name: 'greeter',
    description: 'Example agent that only greets',
    tools: (origin) => [...origin, GreetTool],
  }
}
\`\`\`

## Validation tool (ValidateMainAgent)

You have a dedicated tool \`ValidateMainAgent\` (input \`filePath\` = absolute path of the agent file). It loads the target file and checks:
- the file exists and loads (CJS/ESM, single object or array);
- every agent's \`name\` is a non-empty string and \`description\` is a string;
- \`systemPrompt\` / \`tools\` / \`mcp\` are functions when present;
- in-file duplicates and collisions with built-in agents (default / office / agent-creator) produce warnings.

**After every create or update of an external agent file, you MUST validate it by calling the \`ValidateMainAgent\` tool (passing \`filePath\`)** and report the result truthfully; if validation fails, fix the file and re-validate until it passes. **Do NOT reimplement the validation logic manually** (reading the source with Grep/Read instead of calling the tool is wrong) — just call the \`ValidateMainAgent\` tool and use its authoritative result.

## Workflow

1. First understand the user's needs: the agent's purpose, conversation style, required tools, and whether a specific MCP server is needed.
2. Plan the config: decide name (unique), description, and which slots to override. By default provide only \`systemPrompt\` (+ an optional \`tools\` allowlist); add the \`mcp\` slot only when the user explicitly asks.
3. Create the file: write \`<name>.js\` under \`~/.zai/main-agents/\` with complete runnable code (create the directory first if missing).
4. Call the \`ValidateMainAgent\` tool to validate the generated file; fix and re-validate on failure, then report the result.
5. Wrap up: tell the user to pick the new agent under «Settings → Work mode → Main agent» (systemPrompt/tools take effect for new sessions or immediately; if an mcp slot is configured, restart zai).`

// ─────────────────────────────────────────────────────────────────────
// ValidateMainAgent —— 外置主 Agent 配置校验工具(agent-creator 专属)。
// 定义在本模块内(不注册进 getAllBaseTools),由 agent-creator 的 tools
// 槽把工具实例注入其工具池。
// ─────────────────────────────────────────────────────────────────────

export const VALIDATE_MAIN_AGENT_TOOL_NAME = 'ValidateMainAgent'

const VALIDATE_MAIN_AGENT_DESCRIPTION = `
Validate a custom main agent configuration file (typically in ~/.zai/main-agents/*.js).
Loads the file, checks its shape against the MainAgentConfig contract, and reports
per-agent issues (missing name/description, non-function slots, duplicates, etc.).
`

const VALIDATE_MAIN_AGENT_PROMPT = `
Validate a custom main agent configuration file.

Usage: pass the absolute path of the agent file (usually ~/.zai/main-agents/<name>.js).
The tool loads the file (CJS or ESM, single agent or array), validates every agent
against the MainAgentConfig contract, and returns a per-agent report.

Checks performed:
- File exists and can be loaded.
- \`name\` is a non-empty string, \`description\` is a string.
- \`systemPrompt\` / \`tools\` / \`mcp\` are functions if present (each is an
  (origin) => new slot).
- Duplicate names inside the same file, or collision with built-in agents
  (default / office / agent-creator), produce a warning.

Call this tool after writing/updating a main agent file to confirm it is valid.
`

const validateInputSchema = lazySchema(() =>
  z.strictObject({
    filePath: z
      .string()
      .describe(
        'Absolute path to the main agent config file (e.g. ~/.zai/main-agents/email-assistant.js)',
      ),
  }),
)
type ValidateInputSchema = ReturnType<typeof validateInputSchema>

const validateOutputSchema = lazySchema(() =>
  z.object({
    ok: z.boolean(),
    filePath: z.string(),
    agents: z.array(
      z.object({
        name: z.string(),
        valid: z.boolean(),
        issues: z.array(z.string()),
        warnings: z.array(z.string()),
      }),
    ),
    summary: z.string(),
  }),
)
type ValidateOutputSchema = ReturnType<typeof validateOutputSchema>

export type ValidateMainAgentOutput = z.infer<ValidateOutputSchema>

/**
 * 与内置 agent 重名会触发 warning(外置覆盖内置是有意为之,仅提示)。
 * 名单与 mainAgents.ts getBuiltinMainAgents() 的内置列表保持同步;
 * 新增内置 agent 时记得在此同步追加。
 */
const BUILTIN_MAIN_AGENT_NAMES = new Set([
  'default',
  'office',
  'agent-creator',
  'task-factory',
])

/** 校验单个 agent 配置对象是否符合 MainAgentConfig 契约。 */
export function validateMainAgentConfig(value: unknown): {
  valid: boolean
  issues: string[]
} {
  const issues: string[] = []
  if (!value || typeof value !== 'object') {
    return { valid: false, issues: ['配置不是对象'] }
  }
  const o = value as Record<string, unknown>
  if (typeof o.name !== 'string' || o.name.trim() === '') {
    issues.push('name 必须是非空字符串(用于 settings.mainAgent 选择)')
  }
  if (typeof o.description !== 'string') {
    issues.push('description 必须是字符串')
  }
  for (const key of ['systemPrompt', 'tools', 'mcp'] as const) {
    if (o[key] !== undefined && typeof o[key] !== 'function') {
      issues.push(
        `${key} 必须是函数 (origin) => new,当前是 ${typeof o[key]}`,
      )
    }
  }
  return { valid: issues.length === 0, issues }
}

/** 校验单个 agent 配置文件(单对象或数组,兼容 CJS/ESM 导出)。 */
export async function validateMainAgentFile(
  filePath: string,
): Promise<ValidateMainAgentOutput> {
  try {
    const st = await stat(filePath)
    if (!st.isFile()) {
      return {
        ok: false,
        filePath,
        agents: [],
        summary: `校验失败:${filePath} 不是文件`,
      }
    }
  } catch {
    return {
      ok: false,
      filePath,
      agents: [],
      summary: `校验失败:文件不存在:${filePath}`,
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _raw = await readFile(filePath, 'utf-8') // 确认可读;真正执行靠 import
    const mod = (await import(pathToFileURL(filePath).href)) as Record<
      string,
      unknown
    >
    const raw = mod.default ?? mod
    // 外置文件以 `(ctx) => config` 工厂形式导出(ctx 提供 buildTool/z,
    // 供 tools 槽创造自定义工具);直接导出对象/数组的旧格式也兼容。
    const ctx: MainAgentLoadContext = { buildTool, z }
    const config =
      typeof raw === 'function'
        ? await (raw as (c: MainAgentLoadContext) => unknown)(ctx)
        : raw
    const list = Array.isArray(config) ? config : [config]

    const seen = new Map<string, number>()
    const agents = list.map((value) => {
      const { valid, issues } = validateMainAgentConfig(value)
      const warnings: string[] = []
      const name =
        value && typeof value === 'object'
          ? String((value as Record<string, unknown>).name ?? '')
          : ''
      if (name) {
        const count = seen.get(name) ?? 0
        seen.set(name, count + 1)
        if (count > 0) warnings.push(`文件内重复定义 name="${name}"`)
        if (BUILTIN_MAIN_AGENT_NAMES.has(name)) {
          warnings.push(
            `name="${name}" 与内置 agent 重名,外置将覆盖内置(如非本意请改名)`,
          )
        }
      }
      return { name, valid, issues, warnings }
    })

    const allValid = agents.every((a) => a.valid)
    const lines = agents.map((a) =>
      a.valid
        ? `  ✓ ${a.name || '(未命名)'}${a.warnings.length ? ` ⚠ ${a.warnings.join('; ')}` : ''}`
        : `  ✗ ${a.name || '(未命名)'}: ${a.issues.join('; ')}`,
    )
    return {
      ok: allValid,
      filePath,
      agents,
      summary: allValid
        ? `配置有效,共 ${agents.length} 个 agent:\n${lines.join('\n')}`
        : `配置无效,共 ${agents.length} 个 agent:\n${lines.join('\n')}`,
    }
  } catch (err) {
    return {
      ok: false,
      filePath,
      agents: [],
      summary: `校验失败:加载 ${filePath} 出错:${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** agent-creator 专属配置校验工具实例。 */
export const ValidateMainAgentTool = buildTool({
  name: VALIDATE_MAIN_AGENT_TOOL_NAME,
  searchHint: 'validate a custom main agent config file',
  maxResultSizeChars: 20_000,
  strict: true,
  async description() {
    return VALIDATE_MAIN_AGENT_DESCRIPTION
  },
  async prompt() {
    return VALIDATE_MAIN_AGENT_PROMPT
  },
  get inputSchema(): ValidateInputSchema {
    return validateInputSchema()
  },
  get outputSchema(): ValidateOutputSchema {
    return validateOutputSchema()
  },
  userFacingName() {
    return ''
  },
  toAutoClassifierInput(input) {
    return input.filePath
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage() {
    return null
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [{ type: 'text', text: output.summary }],
    }
  },
  async call({ filePath }) {
    // 框架把 call 返回值当作 ToolResult 并取 .data 传给
    // mapToolResultToToolResultBlockParam —— 必须包一层 data。
    return { data: await validateMainAgentFile(filePath) }
  },
}) satisfies ToolDef

/** AgentCreator 主 Agent 配置。 */
export const agentCreatorMainAgent: MainAgentConfig = {
  name: AGENT_CREATOR_MAIN_AGENT_NAME,
  description: 'Agent创作助手 —— 针对特定场景,帮你创建、定制专属Agent',
  systemPrompt: (origin) => [AGENT_CREATOR_PROMPT, ...origin],
  tools: (origin) => [
    ...origin.filter((tool: Tool) =>
      AGENT_CREATOR_TOOL_ALLOWLIST.has(tool.name),
    ),
    // 专属验证工具:生成/修改外置 agent 文件后调用它做配置校验。
    // 不注册进 getAllBaseTools,只经 agent-creator 的 tools 槽注入。
    ValidateMainAgentTool,
  ],
}