import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { resolveZaiDir } from '../paths.js'
import type { PromptCommand, CommandContext, CommandSource } from '@zn-ai/zn-agent-core'

const NAME_RE = /^[a-z0-9][a-z0-9-_]*$/

interface CommandsDirsOpts {
  cwd?: string
  dataDir?: string
  homeDir?: string
}

/**
 * Resolve which command directories should be loaded. Merges:
 *   - project-level: `<cwd>/.zai/commands` (if any)
 *   - data-dir-level: `<resolveZaiDir()>/commands`
 * Project-level dirs come first so a project command overrides a same-named
 * user-level command on name conflicts.
 *
 * zai patch (2026-10-17, cl-003):用户级目录此前拼的是
 * `join(opts.dataDir, '.zai', 'commands')`,**比 writer 多套了一层 `.zai`**,
 * 且还保留一条无条件指向真实 home 的回落分支。writer
 * (`commands/fileStore.ts` 的 `commandsDir()`)早在 `d66d09f5` 就迁成了
 * `join(resolveZaiDir(), 'commands')`,reader 却没跟上 —— 于是**写 A 读 B**:
 * 写进 `$ZAI_DATA_DIR/commands` 的命令读不到,隔离实例反而静默继承了用户
 * 真实的全套全局命令。
 *
 * 同时清掉两处上游 `.claude` → `.zai` 重命名遗留的死代码:原 `:33-36` 的
 * `cwdClaude` 与 `cwdZai` 拼出**完全相同的字符串**,两个 `existsSync` 判同
 * 一个目录,存在时会把同一路径 push 两次(见 `loadUserCommands` 的扫描循环)。
 */
export function defaultCommandsDirs(opts: CommandsDirsOpts = {}): string[] {
  const dirs: string[] = []
  // project-level first (project overrides user-level on name conflicts)
  if (opts.cwd) {
    const cwdZai = join(opts.cwd, '.zai', 'commands')
    if (existsSync(cwdZai)) dirs.push(cwdZai)
  }
  // user-level: 与 writer 同源。`dataDir` / `homeDir` 是显式注入的测试口子,
  // 生产走 resolveZaiDir()。
  const dataRoot = opts.dataDir || opts.homeDir || resolveZaiDir()
  const zaiDir = join(dataRoot, 'commands')
  if (existsSync(zaiDir)) dirs.push(zaiDir)
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
    const data = yaml.load(yamlBlock) as Record<string, unknown> | null
    if (!data || typeof data !== 'object') return null
    // Claude 风格 command frontmatter 用 kebab-case(`argument-hint` /
    // `allowed-tools` / `disable-model-invocation` / `when-to-use`),
    // 而 CommandFrontmatter 字段是 camelCase。这里统一归一化;
    // 已显式写了 camelCase 键的以 camelCase 为准,不被 kebab 覆盖。
    const normalized: Record<string, unknown> = { ...data }
    for (const [key, value] of Object.entries(data)) {
      if (!key.includes('-')) continue
      const camel = key.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
      if (!(camel in normalized)) normalized[camel] = value
    }
    return normalized as CommandFrontmatter
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