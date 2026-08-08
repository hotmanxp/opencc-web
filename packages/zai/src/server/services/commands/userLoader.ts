import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { PromptCommand, CommandContext, CommandSource } from '@zn-ai/zn-agent-core'
// yaml 解析走 agent-core 的 js-yaml(其 package.json 已声明为依赖),
// 通过 createRequire 跨包引用 node_modules,避免新增依赖。
// 使用 require.resolve 通过 Node 标准模块解析找到 agent-core 的实际路径,
// 兼容 pnpm workspace 和 npm 全局安装两种目录结构。
const _require = createRequire(import.meta.url)
const agentCorePkgPath = _require.resolve('@zn-ai/zn-agent-core/package.json')
const requireFromAgentCore = createRequire(agentCorePkgPath)
const yaml = requireFromAgentCore('js-yaml') as { load(s: string): unknown }

const NAME_RE = /^[a-z0-9][a-z0-9-_]*$/

interface CommandsDirsOpts {
  cwd?: string
  dataDir?: string
  homeDir?: string
}

/**
 * Resolve which command directories should be loaded. Merges:
 *   - project-level: `<cwd>/.zai/commands` and `<cwd>/.zai/commands` (if any)
 *   - home-level: `~/.zai/commands` wins if it exists (single-source for zai
 *     users), otherwise fall back to `~/.zai/commands` for OpenCC workflows.
 * Project-level dirs come first so a project command overrides a same-named
 * home-level command on name conflicts.
 */
export function defaultCommandsDirs(opts: CommandsDirsOpts = {}): string[] {
  const home = opts.homeDir ?? homedir()
  const zaiDir = opts.dataDir
    ? join(opts.dataDir, '.zai', 'commands')
    : join(home, '.zai', 'commands')
  const homeClaudeDir = join(home, '.zai', 'commands')

  const dirs: string[] = []
  // project-level first (project overrides home on name conflicts)
  if (opts.cwd) {
    const cwdClaude = join(opts.cwd, '.zai', 'commands')
    const cwdZai = join(opts.cwd, '.zai', 'commands')
    if (existsSync(cwdClaude)) dirs.push(cwdClaude)
    if (existsSync(cwdZai)) dirs.push(cwdZai)
  }
  // home-level: keep the original single-source policy
  if (existsSync(zaiDir)) dirs.push(zaiDir)
  else if (existsSync(homeClaudeDir)) dirs.push(homeClaudeDir)
  return dirs
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
      const { renderPrompt } = await import('@zn-ai/zn-agent-core')
      const text = renderPrompt({ body, args, argNames: fm?.argNames })
      return [{ type: 'text', text }]
    },
  }
}

/** Scan one directory for `*.md` files. */
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
  const dirs = defaultCommandsDirs({
    cwd: context.cwd,
    dataDir: context.dataDir,
    homeDir: context.homeDir,
  })
  if (dirs.length === 0) return []
  // 合并所有目录的扫描结果,同名命令保留第一个(dir 顺序:项目级优先,故项目覆盖 home)。
  const seen = new Map<string, PromptCommand>()
  for (const dir of dirs) {
    for (const cmd of await scanDir(dir)) {
      if (!seen.has(cmd.name)) seen.set(cmd.name, cmd)
    }
  }
  return Array.from(seen.values())
}

/**
 * 清掉 registry 里所有 source==='user' 的命令,重新扫描 + 注册。
 * 同步函数(内部 await),不阻塞调用方太久:O(几十) 个文件,毫秒级。
 */
export async function reloadUserCommands(context: CommandContext): Promise<PromptCommand[]> {
  const { getCommandRegistry } = await import('@zn-ai/zn-agent-core')
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