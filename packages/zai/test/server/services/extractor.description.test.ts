import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ZN_ASSETS_DIR } from '../../../src/server/services/paths.js'
import {
  listResourcesFromExtraction,
  readMarkdownDescription,
} from '../../../src/server/services/extractor.js'

// 覆盖 /manage?tab=resources 卡片上的描述来源:scanType 读 SKILL.md
// frontmatter 的 description。ZN_ASSETS_DIR 由 test/setup.isolation.ts
// 指向 worker 级临时目录,这里只往里写一个独有的版本号目录,跑完删掉。

const VERSION = '9.9.9'

function writeSkill(relDir: string, content: string) {
  const dir = join(ZN_ASSETS_DIR, VERSION, 'skills', relDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content)
}

afterEach(() => {
  rmSync(join(ZN_ASSETS_DIR, VERSION), { recursive: true, force: true })
})

describe('readMarkdownDescription', () => {
  it('returns undefined for a missing file', () => {
    expect(readMarkdownDescription(join(ZN_ASSETS_DIR, VERSION, 'nope.md'))).toBeUndefined()
  })

  it('collapses a multi-line YAML block description to one line', () => {
    writeSkill(
      'multi',
      ['---', 'name: multi', 'description: |', '  第一行', '  第二行', '---', '', 'body'].join('\n'),
    )
    expect(readMarkdownDescription(join(ZN_ASSETS_DIR, VERSION, 'skills', 'multi', 'SKILL.md'))).toBe(
      '第一行 第二行',
    )
  })

  it('returns undefined when the file has no frontmatter', () => {
    writeSkill('plain', '# just a heading\n')
    expect(
      readMarkdownDescription(join(ZN_ASSETS_DIR, VERSION, 'skills', 'plain', 'SKILL.md')),
    ).toBeUndefined()
  })
})

describe('listResourcesFromExtraction descriptions', () => {
  it('attaches SKILL.md descriptions to single skills and collection children', async () => {
    writeSkill(
      'solo',
      ['---', 'name: solo', 'description: 独立技能说明', '---', '', 'body'].join('\n'),
    )
    writeSkill(
      'pack/child-a',
      ['---', 'name: child-a', 'description: 集合内技能说明', '---', '', 'body'].join('\n'),
    )
    writeSkill('pack/child-b', ['---', 'name: child-b', '---', '', 'body'].join('\n'))

    const items = await listResourcesFromExtraction(VERSION, 'skills')
    const byName = new Map(items.map((i) => [i.name, i]))

    expect(byName.get('solo')?.description).toBe('独立技能说明')
    expect(byName.get('pack/child-a')?.description).toBe('集合内技能说明')
    // child-b 有 frontmatter 但没有 description 字段
    expect(byName.get('pack/child-b')?.description).toBeUndefined()
    // 集合本身不携带描述(它没有自己的 SKILL.md)
    expect(byName.get('pack')?.isCollection).toBe(true)
    expect(byName.get('pack')?.description).toBeUndefined()
  })
})