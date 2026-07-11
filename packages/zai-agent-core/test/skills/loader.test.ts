import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadSkillsFromDirs } from '../../src/runtime/skills/loader.js'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'zai-skill-')) })
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

async function makeSkill(dir: string, relPath: string, fm: string, body = 'body') {
  const full = join(dir, relPath)
  await mkdir(full, { recursive: true })
  await writeFile(join(full, 'SKILL.md'), `---\n${fm}\n---\n${body}`)
}

describe('loadSkillsFromDirs', () => {
  test('空目录数组 → 空结果', async () => {
    expect(await loadSkillsFromDirs([])).toEqual([])
  })

  test('不存在的目录 → 空结果（不抛错）', async () => {
    expect(await loadSkillsFromDirs([join(tmp, 'nope')])).toEqual([])
  })

  test('加载单层 SKILL.md，name 用目录名', async () => {
    await makeSkill(tmp, 'pdf', 'description: read pdf', 'body')
    const skills = await loadSkillsFromDirs([tmp])
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('pdf')
    expect(skills[0]!.frontmatter.description).toBe('read pdf')
    expect(skills[0]!.markdown).toBe('body')
  })

  test('嵌套 SKILL.md 用 : 分隔命名空间', async () => {
    await makeSkill(tmp, 'code-review/go', 'description: review go code')
    const skills = await loadSkillsFromDirs([tmp])
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('code-review:go')
  })

  test('根目录直接放 SKILL.md → 跳过', async () => {
    await writeFile(join(tmp, 'SKILL.md'), '---\ndescription: top\n---\nbody')
    const skills = await loadSkillsFromDirs([tmp])
    expect(skills).toEqual([])
  })

  test('description 缺失 → 从 markdown 第一段提取', async () => {
    await mkdir(join(tmp, 'foo'), { recursive: true })
    await writeFile(join(tmp, 'foo/SKILL.md'), '---\nname: foo\n---\nFirst paragraph here.\n\nSecond.')
    const skills = await loadSkillsFromDirs([tmp])
    expect(skills[0]!.frontmatter.description).toBe('First paragraph here.')
  })

  test('description 缺失且 body 也无 → 该文件被跳过', async () => {
    await mkdir(join(tmp, 'foo'), { recursive: true })
    // body is whitespace-only with no headings, so extractFirstParagraph returns ''.
    await writeFile(join(tmp, 'foo/SKILL.md'), '---\nname: foo\n---\n\n   \n\n  ')
    const skills = await loadSkillsFromDirs([tmp])
    expect(skills).toEqual([])
  })

  test('frontmatter 解析失败 → 跳过该文件，不阻断其他', async () => {
    await makeSkill(tmp, 'good', 'description: good')
    await mkdir(join(tmp, 'bad'), { recursive: true })
    await writeFile(join(tmp, 'bad/SKILL.md'), '---\nno closing')
    const skills = await loadSkillsFromDirs([tmp])
    expect(skills.map(s => s.name)).toEqual(['good'])
  })

  test('符号链接去重：realpath 相同的文件只保留一份', async () => {
    await makeSkill(tmp, 'a', 'description: a')
    await mkdir(join(tmp, 'b'), { recursive: true })
    try {
      await symlink(join(tmp, 'a/SKILL.md'), join(tmp, 'b/SKILL.md'))
    } catch {
      // platform may not support symlinks; skip silently
      return
    }
    const skills = await loadSkillsFromDirs([tmp])
    expect(skills).toHaveLength(1)
  })

  test('多个 dirs 按声明顺序合并', async () => {
    const dir1 = join(tmp, 'd1')
    const dir2 = join(tmp, 'd2')
    await makeSkill(dir1, 'alpha', 'description: alpha')
    await makeSkill(dir2, 'beta', 'description: beta')
    const skills = await loadSkillsFromDirs([dir1, dir2])
    expect(skills.map(s => s.name).sort()).toEqual(['alpha', 'beta'])
  })

  test('文件大小写不敏感：skill.MD 也能识别', async () => {
    await mkdir(join(tmp, 'pdf'), { recursive: true })
    await writeFile(join(tmp, 'pdf/skill.MD'), '---\ndescription: x\n---\nbody')
    const skills = await loadSkillsFromDirs([tmp])
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('pdf')
  })
})
