import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { PromptCommand, CommandContext, CommandSource } from '@zn-ai/zai-agent-core'
// yaml 解析走 agent-core 的 js-yaml(其 package.json 已声明为依赖),
// 通过 createRequire 跨包引用 node_modules,避免新增依赖。
const requireFromAgentCore = createRequire(
  new URL('../../../../../zai-agent-core/', import.meta.url).pathname + 'package.json',
)
const yaml = requireFromAgentCore('js-yaml') as { load(s: string): unknown }

const NAME_RE = /^[a-z0-9][a-z0-9-_]*$/

interface CommandsDirsOpts {
  dataDir?: string
  homeDir?: string
}

/**
 * Resolve which command directory should be loaded. Policy:
 * 1. `~/.zai/commands` always wins if it exists (single-source for zai users).
 * 2. Otherwise fall back to `~/.claude/commands` for OpenCC workflows.
 * 3. Never merge — only one directory is scanned per server boot.
 */
export function defaultCommandsDirs(opts: CommandsDirsOpts = {}): string[] {
  const home = opts.homeDir ?? homedir()
  const zaiDir = opts.dataDir
    ? join(opts.dataDir, '.zai', 'commands')
    : join(home, '.zai', 'commands')
  const claudeDir = join(home, '.claude', 'commands')
  return existsSync(zaiDir) ? [zaiDir] : [claudeDir].filter((d) => existsSync(d))
}

interface CommandFrontmatter {
  description?: string
  argumentHint?: string
  argNames?: string[]
  allowedTools?: string[]
  model?: string
  effort?: PromptCommand['effort']
  disableModelInvocation?: boolean
  whenToUse?: string
  version?: string
}

function parseFrontmatter(raw: string): CommandFrontmatter | null {
  if (!raw.startsWith('---')) return null
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return null
  const yamlBlock = raw.slice(3, end).trim()
  try {
    return yaml.load(yamlBlock) as CommandFrontmatter
  } catch {
    return null
  }
}

function bodyOf(raw: string): string {
  if (!raw.startsWith('---')) return raw
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return raw
  const after = raw.slice(end + 4)
  // 跳过开头的空行
  return after.replace(/^\n+/, '')
}

function buildPromptCommand(
  fileName: string,
  fm: CommandFrontmatter | null,
  body: string,
): PromptCommand {
  const description = fm?.description ?? `User command ${fileName}`
  return {
    type: 'prompt',
    name: fileName,
    description,
    source: 'user' satisfies CommandSource,
    progressMessage: `Running /${fileName}`,
    contentLength: body.length,
    ...(fm?.argumentHint !== undefined ? { argumentHint: fm.argumentHint } : {}),
    ...(fm?.argNames !== undefined ? { argNames: fm.argNames } : {}),
    ...(fm?.allowedTools !== undefined ? { allowedTools: fm.allowedTools } : {}),
    ...(fm?.model !== undefined ? { model: fm.model } : {}),
    ...(fm?.effort !== undefined ? { effort: fm.effort } : {}),
    ...(fm?.disableModelInvocation !== undefined ? { disableModelInvocation: fm.disableModelInvocation } : {}),
    ...(fm?.whenToUse !== undefined ? { whenToUse: fm.whenToUse } : {}),
    ...(fm?.version !== undefined ? { version: fm.version } : {}),
    async getPromptForCommand(args: string, _context: CommandContext) {
      // 同步 prompt 模板替换 — renderPrompt 在 agent-core 里。
      // 用 dynamic import 避免循环依赖 + 与 skill loader 同模式。
      const { renderPrompt } = await import('@zn-ai/zai-agent-core')
      const text = renderPrompt({ body, args, argNames: fm?.argNames })
      return [{ type: 'text', text }]
    },
  }
}

/** Scan one directory for `*.md` files; first dir with content wins. */
async function scanDir(dir: string): Promise<PromptCommand[]> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: PromptCommand[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const name = entry.slice(0, -3)
    if (!NAME_RE.test(name)) {
      console.warn(`[userLoader] skipping invalid name: ${entry}`)
      continue
    }
    let raw: string
    try {
      raw = readFileSync(join(dir, entry), 'utf-8')
    } catch {
      continue
    }
    let fm: CommandFrontmatter | null
    try {
      fm = parseFrontmatter(raw)
    } catch {
      console.warn(`[userLoader] parseFrontmatter failed: ${entry}`)
      continue
    }
    if (fm === null) {
      console.warn(`[userLoader] no frontmatter: ${entry}`)
      continue
    }
    const body = bodyOf(raw)
    out.push(buildPromptCommand(name, fm, body))
  }
  return out
}

export async function loadUserCommands(
  context: CommandContext & { homeDir?: string },
): Promise<PromptCommand[]> {
  for (const dir of defaultCommandsDirs({ dataDir: context.dataDir, homeDir: context.homeDir })) {
    const cmds = await scanDir(dir)
    if (cmds.length > 0 || existsSync(dir)) {
      return cmds
    }
  }
  return []
}

/**
 * 清掉 registry 里所有 source==='user' 的命令,重新扫描 + 注册。
 * 同步函数(内部 await),不阻塞调用方太久:O(几十) 个文件,毫秒级。
 */
export async function reloadUserCommands(context: CommandContext): Promise<PromptCommand[]> {
  const { getCommandRegistry } = await import('@zn-ai/zai-agent-core')
  const reg = getCommandRegistry()
  // 1. unregister 旧 user
  for (const cmd of reg.all().filter((c) => c.source === 'user')) {
    reg.unregister(cmd.name)
  }
  // 2. 加载新一批
  const cmds = await loadUserCommands(context)
  for (const cmd of cmds) {
    const builtinHit = reg.get(cmd.name)
    if (builtinHit && builtinHit.source === 'builtin') {
      // 重命名 user 命令避免覆盖
      const renamed = { ...cmd, name: `user:${cmd.name}`, source: 'user' as CommandSource }
      reg.register(renamed)
      console.warn(`[userLoader] user command "${cmd.name}" conflicts with builtin; registered as "user:${cmd.name}"`)
    } else {
      reg.register(cmd)
    }
  }
  return cmds
}