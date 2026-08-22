/**
 * Skill 加载桥 — B2 T2.4。
 *
 * 复用 zai `loadSkillsFromDirs()`（ZAI_SKILLS_DIRS 语义），把解析出的 skill
 * 包装为 dsh 工具注册。支持条件激活（paths: frontmatter 匹配）。
 *
 * zai 的 skill 实现位于 compat/runtime/skills-* 与 compat/tools/opencc/SkillTool.ts，
 * 本任务跨这两处引用。
 *
 * **TODO（P1-3）真实实现**：调 `zai compat/runtime/skills-loader.ts` 的
 * `loadSkillsFromDirs(cwd, ZAI_SKILLS_DIRS)` 拿到 skill 列表，每个 skill
 * 包装为 defineTool 注册到 ctx.tools。条件激活通过 paths: frontmatter 匹配
 * 在 execute() 内部判定。
 *
 * 预计工作量 0.5-1 天。
 */

export interface ZaiSkill {
  name: string
  description: string
  /** skill.md frontmatter 解析结果 */
  frontmatter: {
    paths?: string[]
    [k: string]: unknown
  }
  body: string
  sourcePath: string
}

export interface ZaiSkillDirsConfig {
  /** 显式禁用：ZAI_SKILLS_DIRS='' */
  disabled: boolean
  /** 扫描根目录列表 */
  dirs: string[]
}

/**
 * 复用 zai 的 skill 解析结果，桥接为 dsh 工具注册。
 *
 * 当前为 stub：B2 T2.4 真实接线 zai loadSkillsFromDirs。
 */
export async function loadZaiSkills(_cwd: string): Promise<ZaiSkill[]> {
  return []
}

/**
 * 把 skill 包装为 dsh 兼容工具。
 */
export function skillsToTools(skills: ZaiSkill[]): Array<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (input: unknown) => Promise<unknown>
}> {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    async execute(_input) {
      // 触发 skill 内容注入 — dsh 系统提示装配由 system-prompt 负责
      return {
        skill: skill.name,
        body: skill.body,
        frontmatter: skill.frontmatter,
      }
    },
  }))
}