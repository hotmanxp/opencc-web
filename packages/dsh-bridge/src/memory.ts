/**
 * dsh 记忆系统桥 — P2-1（真实化）。
 *
 * 通过内联实现的 compat 内存加载（与 zn-agent-core/compat/memory/loader.ts 对齐）：
 *   - AGENTS.md（向上 walk 到 .git 边界）
 *   - AGENTS.local.md（仅 cwd）
 *   - @include 指令递归（MAX_INCLUDE_DEPTH=5）
 *
 * 不依赖 @zn-ai/zn-agent-core — dsh-bridge 是独立 workspace，与 zn-agent-core 解耦。
 * 内联实现保持代码纯净，启动期不需要跨包构建依赖。
 *
 * 然后把内容注册到 dsh `ctx.systemPrompt.section()`（dsh-system-prompt 提供）。
 * 启动 fs.watch 热重载，文件变更时 emit 'system-prompt/change' 通知 dsh 重建。
 */

import { readFile } from 'node:fs/promises'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export interface ZaiMemoryState {
  agentsMd: string
  rules: string[]
  hasExternalIncludes: boolean
}

interface MemoryFile {
  path: string
  content: string
  parent?: string
}

const MAX_INCLUDE_DEPTH = 5
const AGENTS_FILENAME = 'AGENTS.md'
const AGENTS_LOCAL_FILENAME = 'AGENTS.local.md'

// Per-cwd cache. Key: absolute cwd path. Value: ordered list of memory files.
const cache = new Map<string, MemoryFile[]>()

async function readSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

async function walkParentDirsForAgents(startCwd: string): Promise<string[]> {
  const result: string[] = []
  let dir = startCwd
  let iterations = 0
  const MAX_DEPTH = 50

  while (iterations++ < MAX_DEPTH) {
    const candidate = join(dir, AGENTS_FILENAME)
    if (existsSync(candidate)) result.push(candidate)
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return result.reverse()
}

async function processIncludes(
  content: string,
  parentPath: string,
  depth: number,
  chain: Set<string>,
): Promise<string> {
  if (depth >= MAX_INCLUDE_DEPTH) return content
  const lines = content.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const match = line.match(/^@(\S+)\s*$/)
    if (match) {
      const includeRel = match[1]
      const includeAbs = join(dirname(parentPath), includeRel ?? '')
      if (!includeAbs) continue
      if (chain.has(includeAbs)) continue
      if (!existsSync(includeAbs)) continue
      chain.add(includeAbs)
      const included = await readSafe(includeAbs)
      if (included !== null) {
        const recursed = await processIncludes(included, includeAbs, depth + 1, chain)
        out.push(`<!-- @include ${includeRel} -->\n${recursed}`)
      }
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

async function loadMemoryForPrompt(cwd: string): Promise<MemoryFile[]> {
  try {
    const cached = cache.get(cwd)
    if (cached) return cached

    const files: MemoryFile[] = []
    const topLevel = new Set<string>()
    const projectChain = await walkParentDirsForAgents(cwd)
    for (const projectPath of projectChain) {
      if (topLevel.has(projectPath)) continue
      topLevel.add(projectPath)
      const content = await readSafe(projectPath)
      if (content === null) continue
      const chain = new Set<string>(topLevel)
      const withIncludes = await processIncludes(content, projectPath, 0, chain)
      files.push({ path: projectPath, content: withIncludes, parent: undefined })
    }

    const localPath = join(cwd, AGENTS_LOCAL_FILENAME)
    if (!topLevel.has(localPath) && existsSync(localPath)) {
      const content = await readSafe(localPath)
      if (content !== null) {
        topLevel.add(localPath)
        const chain = new Set<string>(topLevel)
        const withIncludes = await processIncludes(content, localPath, 0, chain)
        files.push({ path: localPath, content: withIncludes, parent: undefined })
      }
    }

    cache.set(cwd, files)
    return files
  } catch (err) {
    console.warn('[dsh-bridge] loadMemoryForPrompt failed:', err)
    return []
  }
}

async function detectExternalIncludes(cwd: string): Promise<boolean> {
  try {
    const files = await loadMemoryForPrompt(cwd)
    for (const f of files) {
      if (f.parent) {
        const relParent = relative(cwd, f.parent)
        if (relParent === '..' || relParent.startsWith('..' + sep)) return true
      }
    }
    return false
  } catch {
    return false
  }
}

export function clearMemoryCache(): void {
  cache.clear()
}

const SECTION_NAME = 'zai:memory'
const SECTION_ORDER = -50

/**
 * 加载 cwd 的 memory 内容。
 */
export async function loadZaiMemory(cwd: string): Promise<ZaiMemoryState> {
  try {
    const files = await loadMemoryForPrompt(cwd)
    const agentsMd = files.map((f) => f.content).join('\n\n---\n\n')
    const hasExternal = await detectExternalIncludes(cwd)
    return { agentsMd, rules: [], hasExternalIncludes: hasExternal }
  } catch (err) {
    console.warn('[dsh-bridge] loadZaiMemory failed:', err)
    return { agentsMd: '', rules: [], hasExternalIncludes: false }
  }
}

/**
 * 把 memory 内容注入 dsh 系统 prompt。
 *
 * 注册 ctx.systemPrompt.section() provider；启动 fs.watch 热重载；
 * 文件变更时 emit 'system-prompt/change' 让 dsh 重建 prompt。
 */
export function injectMemoryToDsh(ctx: Context, cwd: string): () => void {
  const systemPrompt = ctx.get('systemPrompt') as
    | {
        section?: (s: { name: string; order: number; text: string | ((context: unknown) => string) }) => () => void
      }
    | undefined
  if (!systemPrompt?.section) {
    console.warn('[dsh-bridge] injectMemoryToDsh: systemPrompt.section unavailable')
    return () => undefined
  }

  let currentState: ZaiMemoryState = { agentsMd: '', rules: [], hasExternalIncludes: false }
  let loaded = false
  const reload = async (): Promise<void> => {
    clearMemoryCache()
    currentState = await loadZaiMemory(cwd)
    loaded = true
  }
  void reload()

  const off = systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: () => currentState.agentsMd,
  })

  // File watcher
  const watchers: FSWatcher[] = []
  const watchTargets: string[] = []
  if (existsSync(join(cwd, 'AGENTS.md'))) watchTargets.push(join(cwd, 'AGENTS.md'))
  if (existsSync(join(cwd, 'AGENTS.local.md')))
    watchTargets.push(join(cwd, 'AGENTS.local.md'))

  let dir = cwd
  for (let i = 0; i < 50; i++) {
    const candidate = join(dir, 'AGENTS.md')
    if (existsSync(candidate) && !watchTargets.includes(candidate))
      watchTargets.push(candidate)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  for (const target of watchTargets) {
    try {
      const w = watch(target, { persistent: false }, () => {
        void reload()
        ctx.emit('system-prompt/change')
      })
      watchers.push(w)
    } catch (err) {
      console.warn(`[dsh-bridge] watcher setup failed for ${target}:`, err)
    }
  }

  return () => {
    off?.()
    for (const w of watchers) {
      try {
        w.close()
      } catch {
        // best-effort
      }
    }
  }
}