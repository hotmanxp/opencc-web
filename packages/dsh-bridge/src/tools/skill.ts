/**
 * Skill 加载桥 — P1-3。
 *
 * 复用 zai `loadSkillsFromDirs()` 概念（`~/.agents/skills/` + `<cwd>/.zai/skills/`），
 * 解析每个 `skill.md` 的 frontmatter，把 skill 包装为 dsh `defineTool` 注册。
 *
 * 与 zai compat/runtime/skills-loader.ts 的差异：
 *   - 不依赖 `ignore` 库；paths: 模式用简单的 glob-to-regex 转换
 *   - frontmatter 用极简 YAML 解析（仅 key: value / key: [array]）
 *   - 失败静默跳过单个 skill（不阻断整体加载）
 *
 * 条件激活（`paths:` frontmatter 匹配）在 execute() 内部判定；不立即挂载。
 */

import { readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { defineTool } from '@zn-ai/dsh-bridge/dsh-core'
import type { Context } from '@deepseek-ai/cordis'

/** 极简 frontmatter — 仅 key: value / key: [array]。 */
export interface ZaiSkillFrontmatter {
  description?: string
  paths?: string[]
  [k: string]: unknown
}

export interface ZaiSkill {
  name: string
  description: string
  frontmatter: ZaiSkillFrontmatter
  body: string
  sourcePath: string
  /** conditional：若 paths 存在则未匹配文件时不挂载 */
  conditional: boolean
}

export interface ZaiSkillDirsConfig {
  disabled: boolean
  dirs: string[]
}

const SKILL_FILENAME_RE = /^skill\.md$/i

/**
 * 解析极简 frontmatter — `---` 包围的 YAML 简版。
 *
 * 支持：
 *   key: value
 *   key: [a, b, c]
 *   # comment
 */
function parseSimpleFrontmatter(content: string): { frontmatter: ZaiSkillFrontmatter; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { frontmatter: {}, body: content }

  const fm: ZaiSkillFrontmatter = {}
  const lines = (m[1] ?? '').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf(':')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    let value: string | string[] = trimmed.slice(idx + 1).trim()
    // 数组形式
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (Array.isArray(value)) {
      fm[key] = value
    } else {
      fm[key] = value
    }
  }
  return { frontmatter: fm, body: (m[2] ?? '').trim() }
}

/**
 * 把 gitignore 风格 glob 转换为正则（极简 — 不覆盖全部 ignore 语义）。
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`)
}

/**
 * 解析 ZAI_SKILLS_DIRS 配置。
 * 显式禁用：env ZAI_SKILLS_DIRS='' → dirs=[]，disabled=true
 * 隐式禁用：env ZAI_SKILLS_DIRS 未设置且 ZAI_DISABLE_SKILLS=1
 * 默认：~/.agents/skills/ + <cwd>/.zai/skills/
 */
export function resolveSkillDirsConfig(cwd: string): ZaiSkillDirsConfig {
  const env = process.env.ZAI_SKILLS_DIRS
  if (env !== undefined) {
    if (env === '') return { disabled: true, dirs: [] }
    return { disabled: false, dirs: env.split(':').filter(Boolean) }
  }
  if (process.env.ZAI_DISABLE_SKILLS === '1') return { disabled: true, dirs: [] }
  return {
    disabled: false,
    dirs: [join(homedir(), '.agents', 'skills'), join(cwd, '.zai', 'skills')],
  }
}

/**
 * 递归扫描目录找 skill.md。
 */
async function walkForSkills(basePath: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(basePath, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const entryPath = join(basePath, entry.name)
    if (SKILL_FILENAME_RE.test(entry.name)) {
      out.push(entryPath)
    } else if (entry.isDirectory()) {
      await walkForSkills(entryPath, out)
    } else if (entry.isSymbolicLink()) {
      try {
        const { stat } = await import('node:fs/promises')
        const s = await stat(entryPath)
        if (s.isDirectory()) await walkForSkills(entryPath, out)
      } catch {
        // skip dangling
      }
    }
  }
}

function buildSkillName(skillDir: string, basePath: string): string {
  const baseName = basename(skillDir)
  const normalizedBase = basePath.replace(/[/\\]+$/, '')
  if (skillDir === normalizedBase) return baseName
  const prefix = normalizedBase + (normalizedBase.endsWith('/') ? '' : '/')
  if (!skillDir.startsWith(prefix)) return baseName
  const rel = skillDir.slice(prefix.length)
  const parts = rel.split('/')
  parts.pop()
  const ns = parts.join(':')
  return ns ? `${ns}:${baseName}` : baseName
}

/**
 * 加载 skills — 复用 zai loadSkillsFromDirs 的语义但简化实现。
 */
export async function loadZaiSkills(cwd: string): Promise<ZaiSkill[]> {
  const cfg = resolveSkillDirsConfig(cwd)
  if (cfg.disabled) return []
  if (cfg.dirs.length === 0) return []

  const skills: ZaiSkill[] = []
  const seen = new Set<string>()

  for (const dir of cfg.dirs) {
    const files: string[] = []
    await walkForSkills(dir, files)
    for (const file of files) {
      try {
        const fileId = await realpath(file).catch(() => null)
        if (fileId) {
          if (seen.has(fileId)) continue
          seen.add(fileId)
        }
        const content = await readFile(file, 'utf-8')
        const { frontmatter, body } = parseSimpleFrontmatter(content)
        const description =
          (typeof frontmatter.description === 'string' && frontmatter.description) ||
          body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'))?.trim() ||
          ''
        if (!description) continue
        const skillDir = dirname(file)
        const name = buildSkillName(skillDir, dir)
        const paths = Array.isArray(frontmatter.paths) ? frontmatter.paths : []
        skills.push({
          name,
          description,
          frontmatter,
          body,
          sourcePath: file,
          conditional: paths.length > 0,
        })
      } catch (err) {
        console.warn(`[dsh-bridge] skill load failed for ${file}:`, err)
      }
    }
  }
  return skills
}

/**
 * 把 skill 包装为 dsh 兼容工具。
 *
 * 每个 skill 暴露为同名工具（带 `$ARGUMENTS` 替换）。
 * conditional skills 在 execute() 内检查 cwd 文件路径是否匹配 paths glob。
 */
export function skillsToTools(
  skills: ZaiSkill[],
  opts: { cwd: string },
): Array<ReturnType<typeof defineTool>> {
  return skills.map((skill) => {
    const paths = Array.isArray(skill.frontmatter.paths) ? skill.frontmatter.paths : []
    const regexes = paths.map(globToRegex)

    return defineTool({
      name: `Skill:${skill.name}`,
      description: skill.description,
      parameters: {
        args: {
          type: 'string',
          description: 'Optional $ARGUMENTS substitution for the skill body.',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            output: { type: 'string', description: 'Skill body after $ARGUMENTS substitution.' },
            activated: { type: 'boolean', description: 'True when conditional skill matched files in cwd.' },
            sourcePath: { type: 'string', description: 'Original skill.md path.' },
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
        let activated = true
        if (skill.conditional && regexes.length > 0) {
          // 简化：扫 cwd 顶层目录看是否有文件匹配任一 glob
          const { readdir } = await import('node:fs/promises')
          let matched = false
          try {
            const entries = await readdir(opts.cwd)
            for (const e of entries) {
              for (const re of regexes) {
                if (re.test(e)) {
                  matched = true
                  break
                }
              }
              if (matched) break
            }
          } catch {
            matched = false
          }
          activated = matched
          if (!activated) {
            return {
              output: `[skill ${skill.name}] not activated — paths: ${paths.join(', ')} matched no files in cwd.`,
              activated: false,
              sourcePath: skill.sourcePath,
            }
          }
        }

        const substituted = a.args
          ? skill.body.replace(/\$ARGUMENTS/g, a.args)
          : skill.body
        return {
          output: substituted,
          activated: true,
          sourcePath: skill.sourcePath,
        }
      },
    })
  })
}

/**
 * 注册 skill 工具到 dsh ctx。
 *
 * 返回 Promise<disposer 数组>（每个 skill 一个 disposer）。
 */
export async function registerSkillTools(
  ctx: Context,
  opts: { cwd: string },
): Promise<Array<() => void>> {
  const tools = ctx.get('tools') as { register: (definition: unknown) => () => void } | undefined
  if (!tools) {
    throw new Error(
      '[dsh-bridge] skill: tools service unavailable — was @deepseek-ai/dsh-tools loaded?',
    )
  }
  const skills = await loadZaiSkills(opts.cwd)
  return skillsToTools(skills, opts).map((tool) => tools.register(tool) as () => void)
}

/**
 * 兼容旧 API 名称（skill.ts 仍导出 loadZaiSkills/skillsToTools）。
 */
export { registerSkillTools as registerZaiSkills }