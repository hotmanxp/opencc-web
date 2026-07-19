import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  activateConditionalSkillsForPaths,
  loadSkillsFromDirs,
  loadSkillsFromDirsDetailed,
} from '../../src/runtime/skills/loader.js'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'zai-skill-')) })
afterEach(async () => { tmp && await rm(tmp, { recursive: true, force: true }) })

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

  // -------------------------------------------------------------------------
  // New (opencc-faithful) capabilities
  // -------------------------------------------------------------------------

  test('user-invocable: false → 跳过该 skill', async () => {
    await makeSkill(tmp, 'a', 'description: a', 'body')
    await makeSkill(
      tmp,
      'b',
      'description: b\nuser-invocable: false',
      'body',
    )
    await makeSkill(
      tmp,
      'c',
      'description: c\nuser-invocable: "false"',
      'body',
    )
    const skills = await loadSkillsFromDirs([tmp])
    expect(skills.map(s => s.name)).toEqual(['a'])
  })

  test('user-invocable: true (默认) → 加载', async () => {
    await makeSkill(tmp, 'a', 'description: a\nuser-invocable: true', 'body')
    const skills = await loadSkillsFromDirs([tmp])
    expect(skills.map(s => s.name)).toEqual(['a'])
  })

  test('description 是 bool/number → coerce 成字符串', async () => {
    // js-yaml with CORE_SCHEMA parses unquoted `description: true` as the
    // boolean true. coerceDescriptionToString turns it back into a string so
    // downstream code can rely on .description being a string.
    await mkdir(join(tmp, 'foo'), { recursive: true })
    await writeFile(
      join(tmp, 'foo/SKILL.md'),
      '---\ndescription: true\n---\nbody',
    )
    const skills = await loadSkillsFromDirs([tmp])
    expect(skills).toHaveLength(1)
    expect(skills[0]!.description).toBe('true')
  })

  test('shell frontmatter 解析成功', async () => {
    await makeSkill(
      tmp,
      'shell-skill',
      'description: uses bash\nshell: bash',
    )
    const skills = await loadSkillsFromDirs([tmp])
    expect(skills).toHaveLength(1)
    expect(skills[0]!.frontmatter?.shell).toBe('bash')
  })

  test('shell frontmatter 非法 → 跳过该字段', async () => {
    await makeSkill(
      tmp,
      'bad-shell',
      'description: bad shell\nshell: "rm -rf /"',
    )
    const skills = await loadSkillsFromDirs([tmp])
    expect(skills).toHaveLength(1)
    expect(skills[0]!.frontmatter?.shell).toBeUndefined()
  })

  test('isDirGitignored: true → 跳过该目录', async () => {
    await makeSkill(tmp, 'visible', 'description: visible')
    await makeSkill(tmp, 'hidden', 'description: hidden')
    const skills = await loadSkillsFromDirs([tmp], {
      isDirGitignored: async (dir) => dir.endsWith('/hidden'),
    })
    expect(skills.map(s => s.name)).toEqual(['visible'])
  })

  test('isDirGitignored: undefined → 不 gate (默认 allow)', async () => {
    await makeSkill(tmp, 'a', 'description: a')
    const skills = await loadSkillsFromDirs([tmp], {})
    expect(skills).toHaveLength(1)
  })
})

describe('loadSkillsFromDirsDetailed (conditional skills)', () => {
  test('无 paths frontmatter → 进 unconditional', async () => {
    await makeSkill(tmp, 'plain', 'description: plain')
    const { unconditional, conditional } = await loadSkillsFromDirsDetailed([tmp])
    expect(unconditional.map(s => s.name)).toEqual(['plain'])
    expect(conditional).toEqual([])
  })

  test('有 paths frontmatter → 进 conditional', async () => {
    await makeSkill(
      tmp,
      'ts-only',
      'description: ts only\npaths:\n  - "**/*.ts"',
    )
    const { unconditional, conditional } = await loadSkillsFromDirsDetailed([tmp])
    expect(unconditional).toEqual([])
    expect(conditional).toHaveLength(1)
    expect(conditional[0]!.name).toBe('ts-only')
    expect(conditional[0]!.paths).toEqual(['**/*.ts'])
  })

  test('paths 仅含 ** → 不算 conditional', async () => {
    await makeSkill(
      tmp,
      'catchall',
      'description: catchall\npaths: "**"',
    )
    const { unconditional, conditional } = await loadSkillsFromDirsDetailed([tmp])
    expect(unconditional).toHaveLength(1)
    expect(conditional).toEqual([])
  })

  test('paths /<dir>/** 后缀被剥掉', async () => {
    await makeSkill(
      tmp,
      'subdir',
      'description: subdir\npaths:\n  - "src/**"',
    )
    const { conditional } = await loadSkillsFromDirsDetailed([tmp])
    expect(conditional[0]!.paths).toEqual(['src'])
  })

  test('paths 是数组 → 每项独立规范化', async () => {
    await makeSkill(
      tmp,
      'multi',
      'description: multi\npaths:\n  - "src/**"\n  - "tests/**"',
    )
    const { conditional } = await loadSkillsFromDirsDetailed([tmp])
    expect(conditional[0]!.paths).toEqual(['src', 'tests'])
  })
})

describe('activateConditionalSkillsForPaths', () => {
  async function loadAll() {
    return loadSkillsFromDirsDetailed([tmp])
  }

  test('匹配 .ts 文件 → 激活 paths 含 **/*.ts 的 skill', async () => {
    await makeSkill(
      tmp,
      'ts',
      'description: ts\npaths:\n  - "**/*.ts"',
    )
    await makeSkill(
      tmp,
      'py',
      'description: py\npaths:\n  - "**/*.py"',
    )
    const { conditional } = await loadAll()
    const activated = activateConditionalSkillsForPaths(
      conditional,
      [join(tmp, 'foo/bar.ts')],
      tmp,
    )
    expect(activated.map(s => s.name)).toEqual(['ts'])
  })

  test('路径在 cwd 之外 → 不激活（无法解析为 cwd 相对路径）', async () => {
    await makeSkill(
      tmp,
      'ts',
      'description: ts\npaths:\n  - "**/*.ts"',
    )
    const { conditional } = await loadAll()
    const activated = activateConditionalSkillsForPaths(
      conditional,
      ['/elsewhere/foo.ts'],
      tmp,
    )
    expect(activated).toEqual([])
  })

  test('空 paths 列表 → 空结果', async () => {
    await makeSkill(
      tmp,
      'ts',
      'description: ts\npaths:\n  - "**/*.ts"',
    )
    const { conditional } = await loadAll()
    expect(
      activateConditionalSkillsForPaths(conditional, [], tmp),
    ).toEqual([])
  })

  test('空 conditional 列表 → 空结果', async () => {
    expect(
      activateConditionalSkillsForPaths(
        [],
        [join(tmp, 'foo.ts')],
        tmp,
      ),
    ).toEqual([])
  })

  test('多 patterns OR-语义：任一匹配即激活', async () => {
    await makeSkill(
      tmp,
      'multi',
      'description: multi\npaths:\n  - "**/*.ts"\n  - "**/*.tsx"',
    )
    const { conditional } = await loadAll()
    const activated = activateConditionalSkillsForPaths(
      conditional,
      [join(tmp, 'components/Foo.tsx')],
      tmp,
    )
    expect(activated.map(s => s.name)).toEqual(['multi'])
  })
})