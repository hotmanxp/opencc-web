/**
 * 主 Agent 解析(zai patch 2026-08-20)。
 *
 * Agent 两种来源:
 *   1. 内置 —— zn-agent-core `getBuiltinMainAgents()`(default + office)
 *   2. 外置用户配置 —— `~/.zai/main-agents/*.js`(CJS / ESM 均可,
 *      每文件一个 agent 或一个数组;dynamic import 加载)
 *
 * 合并规则:重名时外置覆盖内置(允许用户定制/改写内置 agent 行为)。
 * 选中的 agent name 持久化在 `~/.zai/settings.json → settings.mainAgent`。
 * 运行时 `initAgentRuntime` 把解析结果传给 `createOpenccRuntime({ mainAgent })`,
 * 三个插槽(systemPrompt / tools / mcp)替换系统默认。
 *
 * 见 docs/superpowers/specs/2026-08-20-zai-main-agent-slots-design.md。
 */
import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  getBuiltinMainAgents,
  type MainAgentConfig,
  type MainAgentLoadContext,
} from '@zn-ai/zn-agent-core'

/** 外置 agent 目录:`~/.zai/main-agents/`。 */
export function mainAgentsDir(): string {
  return join(homedir(), '.zai', 'main-agents')
}

/** 宽松的 shape 校验 —— JS 文件只需 name + description 即可纳入列表。 */
function isMainAgentConfig(value: unknown): value is MainAgentConfig {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  return typeof o.name === 'string' && typeof o.description === 'string'
}

/**
 * 构建外置 agent 文件的加载上下文。外置文件位于 ~/.zai/main-agents/,
 * 模块解析找不到 '@zn-ai/zn-agent-core' 包名 —— 所以用 createRequire
 * 从 zai 自身位置解析出 buildTool / z 后,作为 `ctx` 传给
 * `module.exports = (ctx) => config` 工厂函数(不参与 zai tsc 类型检查)。
 */
function buildLoadContext(): MainAgentLoadContext {
  const requireFromZai = createRequire(import.meta.url)
  const core = requireFromZai('@zn-ai/zn-agent-core') as {
    buildTool?: MainAgentLoadContext['buildTool']
    z?: MainAgentLoadContext['z']
  }
  return {
    buildTool: core.buildTool,
    z: core.z,
  } as MainAgentLoadContext
}

/**
 * 扫描 `~/.zai/main-agents/*.js` 并动态加载。每文件以工厂函数形式导出:
 *   - `module.exports = (ctx) => ({ name, description, systemPrompt?, tools?, mcp? })`
 *   - `module.exports = (ctx) => [{...}, {...}]`(一文件多 agent)
 *   - ESM `export default (ctx) => ({...})`
 * ctx 提供 buildTool / z,供 tools 槽创造自定义工具。
 * 直接导出对象/数组的旧格式也兼容。
 * 目录缺失 / 空 → [];单个文件加载失败只 warn,不阻断。
 * `dir` 可注入(测试用),默认 `~/.zai/main-agents`。
 */
export async function loadUserMainAgents(
  dir: string = mainAgentsDir(),
): Promise<MainAgentConfig[]> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.js'))
  } catch {
    return []
  }
  const agents: MainAgentConfig[] = []
  const ctx = buildLoadContext()
  for (const file of files) {
    try {
      const url = pathToFileURL(join(dir, file)).href
      const mod = (await import(url)) as Record<string, unknown>
      const raw = mod.default ?? mod
      const config =
        typeof raw === 'function'
          ? await (raw as (c: MainAgentLoadContext) => unknown)(ctx)
          : raw
      if (Array.isArray(config)) {
        for (const item of config) {
          if (isMainAgentConfig(item)) agents.push(item)
          else console.warn(`[mainAgents] 跳过 ${file}: 数组项缺少 name/description`)
        }
      } else if (isMainAgentConfig(config)) {
        agents.push(config)
      } else {
        console.warn(`[mainAgents] 跳过 ${file}: 导出格式不符合 MainAgentConfig`)
      }
    } catch (err) {
      console.warn(`[mainAgents] 加载失败 ${file}:`, err)
    }
  }
  return agents
}

/** 内置 + 外置合并,重名时外置覆盖内置。 */
export function mergeMainAgents(
  builtin: MainAgentConfig[],
  user: MainAgentConfig[],
): MainAgentConfig[] {
  const merged = new Map<string, MainAgentConfig>()
  for (const a of builtin) merged.set(a.name, a)
  for (const a of user) merged.set(a.name, a)
  return Array.from(merged.values())
}

/**
 * 解析当前生效的主 Agent:
 *   - 加载内置 + 外置并合并
 *   - `name` 未传 / 未知名 → 回退 default(内置第一个兜底)
 * 返回 `{ agent, agents }` —— agents 供设置 UI 列表展示。
 */
export async function resolveMainAgent(
  name: string | undefined,
  dir?: string,
): Promise<{ agent: MainAgentConfig; agents: MainAgentConfig[] }> {
  const merged = mergeMainAgents(
    getBuiltinMainAgents(),
    await loadUserMainAgents(dir),
  )
  const agent =
    merged.find((a) => a.name === (name ?? 'default')) ?? merged[0]
  return { agent, agents: merged }
}
