import { writeFileSync, readFileSync, readdirSync, mkdirSync, unlinkSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// yaml 解析走 agent-core 的 js-yaml(其 package.json 已声明为依赖),
// 通过 createRequire 跨包引用 node_modules,避免新增依赖。
const requireFromAgentCore = createRequire(
  new URL('../../../../../zai-agent-core/', import.meta.url).pathname + 'package.json',
)
const yaml = requireFromAgentCore('js-yaml') as { load(s: string): unknown }

const NAME_RE = /^[a-z0-9][a-z0-9-_]*$/

export function commandsDir(): string {
  return join(homedir(), '.zai', 'commands')
}

function ensureDir(): void {
  mkdirSync(commandsDir(), { recursive: true })
}

function fileFor(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`Invalid command name: ${name}`)
  return join(commandsDir(), `${name}.md`)
}

export interface CommandFile {
  name: string
  frontmatter: Record<string, unknown>
  body: string
}

function buildFrontmatter(fm: Record<string, unknown>): string {
  // 简单 YAML 序列化(只支持 string/array/number/boolean/null)。覆盖 spec 列出的字段。
  const lines = ['---']
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      lines.push(`${k}:`)
      for (const item of v) lines.push(`  - ${JSON.stringify(item)}`)
    } else if (typeof v === 'string') {
      // 用 JSON.stringify 保证转义;前后双引号由 YAML 解析器识别为字符串。
      lines.push(`${k}: ${JSON.stringify(v)}`)
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

export async function writeCommandFile(
  name: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  const path = fileFor(name)
  ensureDir()
  const content = `${buildFrontmatter(frontmatter)}\n${body.replace(/^\n+/, '')}\n`
  // 原子写:tmp + rename
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, path)
}

export async function readCommandFile(name: string): Promise<CommandFile | null> {
  const path = fileFor(name)
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf-8')
  if (!raw.startsWith('---')) {
    return { name, frontmatter: {}, body: raw }
  }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) {
    return { name, frontmatter: {}, body: raw }
  }
  let fm: Record<string, unknown> = {}
  try {
    fm = (yaml.load(raw.slice(3, end).trim()) as Record<string, unknown>) ?? {}
  } catch {
    fm = {}
  }
  const body = raw.slice(end + 4).replace(/^\n+/, '')
  return { name, frontmatter: fm, body }
}

export async function deleteCommandFile(name: string): Promise<void> {
  const path = fileFor(name)
  if (!existsSync(path)) return
  unlinkSync(path)
}

export async function readCommandList(): Promise<Array<{ name: string; description?: string; argumentHint?: string; whenToUse?: string }>> {
  const dir = commandsDir()
  if (!existsSync(dir)) return []
  const out: Array<{ name: string; description?: string; argumentHint?: string; whenToUse?: string }> = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue
    const name = entry.slice(0, -3)
    if (!NAME_RE.test(name)) continue
    const file = await readCommandFile(name)
    if (!file) continue
    out.push({
      name,
      description: typeof file.frontmatter.description === 'string' ? file.frontmatter.description : undefined,
      argumentHint: typeof file.frontmatter.argumentHint === 'string' ? file.frontmatter.argumentHint : undefined,
      whenToUse: typeof file.frontmatter.whenToUse === 'string' ? file.frontmatter.whenToUse : undefined,
    })
  }
  return out
}