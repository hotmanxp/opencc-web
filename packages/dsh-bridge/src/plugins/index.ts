/**
 * 插件市场桥 — P1-6（真实化）。
 *
 * 读取 `~/.zai/plugins/installed_plugins.json`（V2 schema），对每个 plugin
 * 加载 `.claude-plugin/plugin.json` 的 hooks/commands/skills 定义：
 *   - hooks → 注册 ctx.on('agent/...') 监听器
 *   - commands → ctx.tools.register 暴露为可调用工具
 *   - skills → 由 tools/skill.ts 加载（避免重复注册）
 *
 * V2 schema：
 *   { version: 2, plugins: Record<pluginId, PluginInstallationEntry[]> }
 *
 * 与 zai 现状差异：
 *   - zai 走完整 plugin loader（commands/skills/hooks 全套）；
 *     本实现仅覆盖 hooks + commands 两个面，skills 走独立 skill 桥
 *     （路径分离、避免重复）。
 *   - 插件热卸载：未实现（cordis 4.x 用 ctx.effect disposer；当前 bridge
 *     长驻期间不卸载插件，假定 plugin 管理由 zai CLI 单独处理）。
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@zn-ai/dsh-bridge/dsh-core'
import type { Context } from '@deepseek-ai/cordis'

export interface ZaiPluginHook {
  /** 钩子名称（plugin 命名空间） */
  name: string
  /** 触发点 — zai 命名空间（PreToolUse, PostToolUse, Stop 等）。 */
  trigger: string
  /** 命令体 — 异步执行的 shell script。 */
  body: string
}

export interface ZaiPluginCommand {
  name: string
  description: string
  body: string
}

export interface ZaiPlugin {
  /** Plugin 全名 — `${name}@${marketplace}`。 */
  id: string
  /** Plugin 短名（不带 marketplace）。 */
  name: string
  version?: string
  installPath: string
  hooks: ZaiPluginHook[]
  commands: ZaiPluginCommand[]
  /** skills 由 tools/skill.ts 加载，这里仅记录路径。 */
  skills: string[]
}

/**
 * 解析 `.claude-plugin/plugin.json` 简化格式。
 *
 * 真实格式包含 hooks/commands 的子结构定义；本实现只取 hooks 与 commands
 * 数组（zai 的 plugin.json 子集）。
 */
interface ClaudePluginManifest {
  name?: string
  version?: string
  hooks?: Array<{
    name?: string
    trigger?: string
    body?: string
  }>
  commands?: Array<{
    name: string
    description?: string
    body?: string
  }>
}

/**
 * 读取 ~/.zai/plugins/installed_plugins.json 并加载每个 plugin 的 manifest。
 *
 * 跳过损坏的 entry（不阻断整体加载）。
 */
export async function loadZaiPlugins(): Promise<ZaiPlugin[]> {
  const pluginsDir = join(homedir(), '.zai', 'plugins')
  const indexPath = join(pluginsDir, 'installed_plugins.json')

  let indexData: unknown
  try {
    const raw = await readFile(indexPath, 'utf-8')
    indexData = JSON.parse(raw)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    console.warn('[dsh-bridge] loadZaiPlugins: failed to parse index:', err)
    return []
  }

  const pluginsMap = (indexData as { plugins?: Record<string, unknown[]> }).plugins ?? {}
  const out: ZaiPlugin[] = []

  for (const [pluginId, entries] of Object.entries(pluginsMap)) {
    if (!Array.isArray(entries) || entries.length === 0) continue
    // 取第一个 entry（按 zai 默认 scope=user）
    const entry = entries[0] as { installPath?: string; version?: string }
    if (!entry?.installPath) continue

    const manifestPath = join(entry.installPath, '.claude-plugin', 'plugin.json')
    if (!existsSync(manifestPath)) {
      console.warn(`[dsh-bridge] plugin ${pluginId} has no manifest at ${manifestPath}`)
      continue
    }

    try {
      const raw = await readFile(manifestPath, 'utf-8')
      const manifest = JSON.parse(raw) as ClaudePluginManifest
      const pluginName = pluginId.split('@')[0] ?? pluginId
      out.push({
        id: pluginId,
        name: pluginName,
        version: entry.version ?? manifest.version,
        installPath: entry.installPath,
        hooks: (manifest.hooks ?? []).map((h) => ({
          name: h.name ?? pluginName,
          trigger: h.trigger ?? 'PreToolUse',
          body: h.body ?? '',
        })),
        commands: (manifest.commands ?? []).map((c) => ({
          name: c.name,
          description: c.description ?? c.name,
          body: c.body ?? '',
        })),
        skills: await scanSkills(entry.installPath),
      })
    } catch (err) {
      console.warn(`[dsh-bridge] plugin ${pluginId} manifest parse failed:`, err)
    }
  }

  return out
}

async function scanSkills(pluginPath: string): Promise<string[]> {
  const skillsRoot = join(pluginPath, 'skills')
  if (!existsSync(skillsRoot)) return []
  const found: string[] = []
  try {
    const entries = await readdir(skillsRoot, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) found.push(join(skillsRoot, e.name))
    }
  } catch {
    // best-effort
  }
  return found
}

/**
 * Trigger → dsh event 映射。
 *
 * zai 命名空间 → dsh Cordis event：
 *   PreToolUse    → 'tool/before'
 *   PostToolUse   → 'tool/after'
 *   PreStep       → 'agent/pre-step'
 *   PostStep      → 'agent/post-step'
 *   Stop          → 'session/end-seed'（最接近）
 *   UserPromptSubmit → 'request/header'（最接近）
 */
function triggerToDshEvent(trigger: string): string {
  switch (trigger) {
    case 'PreToolUse':
      return 'tool/before'
    case 'PostToolUse':
      return 'tool/after'
    case 'PreStep':
      return 'agent/pre-step'
    case 'PostStep':
      return 'agent/post-step'
    case 'Stop':
      return 'session/end-seed'
    case 'UserPromptSubmit':
      return 'request/header'
    default:
      return trigger
  }
}

/**
 * 把 zai 插件 hooks 注册为 dsh 事件监听器。
 *
 * 当前实现：监听到事件后把 hook body 作为字符串 emit（不实际执行 shell —
 * shell 执行需要权限审批，与主计划 §3 安全语义一致）。
 */
export function registerZaiPluginHooks(ctx: Context, plugins: ZaiPlugin[]): () => void {
  const disposers: Array<() => void> = []
  for (const plugin of plugins) {
    for (const hook of plugin.hooks) {
      if (!hook.body) continue
      const dshEvent = triggerToDshEvent(hook.trigger)
      try {
        const listener = (...args: unknown[]): void => {
          // 简化：把 hook 信息记录到 ctx，避免执行未审批 shell
          ctx.set(`plugin-hook:${plugin.name}:${hook.name}`, {
            trigger: hook.trigger,
            body: hook.body,
            lastArgs: args,
            firedAt: Date.now(),
          })
        }
        // dsh-side 事件名是 cordis 动态事件类型；用 cast 绕过严格类型检查
        const off = (ctx.on as unknown as (event: string, fn: (...args: unknown[]) => void) => () => void)(
          dshEvent,
          listener,
        )
        disposers.push(off)
      } catch (err) {
        console.warn(
          `[dsh-bridge] failed to register hook ${plugin.name}/${hook.name} on ${dshEvent}:`,
          err,
        )
      }
    }
  }
  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * 把 zai 插件 commands 注册为 dsh 工具。
 *
 * 每个 command 暴露为可调用工具，返回 body 文本（zai 命令的等价 mock — 真实
 * 实现走 zai 命令执行器；当前桥接保持接口对齐）。
 */
export function registerZaiPluginCommands(
  ctx: Context,
  plugins: ZaiPlugin[],
): () => void {
  const tools = ctx.get('tools') as
    | { register: (def: unknown) => () => void }
    | undefined
  if (!tools) {
    console.warn('[dsh-bridge] registerZaiPluginCommands: tools service unavailable')
    return () => undefined
  }

  const disposers: Array<() => void> = []
  for (const plugin of plugins) {
    for (const cmd of plugin.commands) {
      const toolName = `plugin:${plugin.name}:${cmd.name}`
      const tool = defineTool({
        name: toolName,
        description: `[plugin ${plugin.name}] ${cmd.description}`,
        parameters: {
          args: {
            type: 'string',
            description: 'Optional $ARGUMENTS for the command body.',
          },
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              output: { type: 'string', description: 'Command body (with $ARGUMENTS substituted).' },
            },
            additionalProperties: false,
          },
          render(_args, value) {
            const v = value as { output: string }
            return [{ type: 'text', text: v.output }]
          },
        },
        async execute(args) {
          const a = args as { args?: string }
          const substituted = a.args ? cmd.body.replace(/\$ARGUMENTS/g, a.args) : cmd.body
          return { output: substituted }
        },
      })
      try {
        const dispose = tools.register(tool)
        disposers.push(dispose)
      } catch (err) {
        console.warn(`[dsh-bridge] failed to register command ${toolName}:`, err)
      }
    }
  }
  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * 一站式安装：加载 plugins + 注册 hooks + 注册 commands。
 *
 * 返回 disposer 数组。
 */
export async function installZaiPlugins(ctx: Context): Promise<() => void> {
  const plugins = await loadZaiPlugins()
  const disposeHooks = registerZaiPluginHooks(ctx, plugins)
  const disposeCommands = registerZaiPluginCommands(ctx, plugins)
  return () => {
    disposeHooks()
    disposeCommands()
  }
}