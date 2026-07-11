# zai-agent-core SKILL 读取与 Skill 工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `zai-agent-core` 落地 SKILL 加载（frontmatter 全字段解析 + 路径白名单 loader）+ `SkillTool`（同会话 prompt 注入），让 zai-server 通过 `RuntimeConfig.skillsDirs` 即可让 agent 看到并调用用户自定义 skill。

**Architecture:** zai 自写最小 frontmatter parser（不引外部依赖）和目录扫描 loader（`node:fs/promises`），二者组合产出 `LoadedSkill[]`。`SkillTool` 走与 `AgentTool` 相同的 `Tool<>` 接口形态，但不 fork 子会话，而是把 skill body 写入 `ToolContext.state.__pendingSkillInjection`，由 `queryEngine` 在 tool results 之后追加为下一轮 user message。`SkillTool` 不进 `getZaiRuntimeTools()`，由 `resolveToolPool` 按 `skills.length > 0` 动态注入。

**Tech Stack:** TypeScript 5.6 + Node 20 + zod 3.23 + vitest 2.1。零新依赖。

**Spec:** `docs/superpowers/specs/2026-07-10-zai-agent-core-skill-support-design.md`

---

## Global Constraints

（来自 spec §1.1 / §1.2，落地时每条都要遵守）

- 不读 OpenCC `settings.json`，zai 独立 `~/.zai/settings.json`
- 不读 OpenCC 默认 skill 路径（`~/.agents/skills`、`~/.claude/skills`），zai 用 `RuntimeConfig.skillsDirs` 显式配置
- 所有错误走 `RuntimeErrorEvent` 流式事件
- `src/opencc-internals/` 镜像保持只读，新代码不写到 `src/opencc-internals/`
- `src/runtime/skills/` 不依赖 `src/opencc-internals/`
- 不引入新 npm 依赖（package.json dependencies 列表不变）
- frontmatter 用自写最小 YAML parser（只支持 skill 用到的字段），不支持注释 / `|` / `>` / 嵌套 map
- 第一版 SkillTool 不执行 skill body 中的内联 shell，不实现 hooks 触发，不做 conditional paths 激活
- `enabledSkills` 旧字段保留为 `@deprecated`，不读，迁移责任在调用方

---

## File Structure

**新增文件：**
- `src/runtime/skills/types.ts` — `SkillFrontmatter`, `LoadedSkill`, `PendingSkillInjection` 类型
- `src/runtime/skills/frontmatter.ts` — `parseSkillFrontmatter()` 自写 YAML 解析
- `src/runtime/skills/substitute.ts` — `substituteArguments()` 占位符替换
- `src/runtime/skills/loader.ts` — `loadSkillsFromDirs()` 目录扫描 + 解析 + 去重
- `src/runtime/skills/promptBuilder.ts` — `buildSkillsSystemPrompt()` 生成 `<skills>` 段
- `src/runtime/skills/index.ts` — 公共 re-export
- `src/tools/SkillTool/SkillTool.ts` — SkillTool 主体
- `src/tools/SkillTool/prompt.ts` — tool description
- `src/tools/SkillTool/schema.ts` — `SkillInputSchema`
- `test/skills/frontmatter.test.ts`
- `test/skills/loader.test.ts`
- `test/skills/promptBuilder.test.ts`
- `test/skills/substitute.test.ts`
- `test/tools/SkillTool.test.ts`

**修改文件：**
- `src/runtime/types.ts` — `RuntimeConfig.skillsDirs` / `enableSkillTool`，`QueryOptions.skillsDirs`；`enabledSkills` 标 deprecated
- `src/runtime/queryEngine.ts` — 加载 skills、动态注入 SkillTool、system prompt 拼接、`__pendingSkillInjection` 消费
- `test/runtime/queryEngine.test.ts` — 新增 5 个 skill 相关集成测试
- `package.json` — exports 增加 `./skills`

---

## Task 1: 类型与 frontmatter 解析

**Files:**
- Create: `packages/zai-agent-core/src/runtime/skills/types.ts`
- Create: `packages/zai-agent-core/src/runtime/skills/frontmatter.ts`
- Create: `packages/zai-agent-core/src/runtime/skills/substitute.ts`
- Create: `packages/zai-agent-core/test/skills/frontmatter.test.ts`
- Create: `packages/zai-agent-core/test/skills/substitute.test.ts`

**Interfaces:**
- Produces: `SkillFrontmatter`, `LoadedSkill`, `PendingSkillInjection` 类型
- Produces: `parseSkillFrontmatter(raw, filename?) → { frontmatter, body }`
- Produces: `substituteArguments(body, args, quoted, argNames?) → string`

- [ ] **Step 1: 写失败测试 `test/skills/frontmatter.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import { parseSkillFrontmatter } from '../../src/runtime/skills/frontmatter.js'

describe('parseSkillFrontmatter', () => {
  test('空文件 → 空 frontmatter + 全文 body', () => {
    const { frontmatter, body } = parseSkillFrontmatter('')
    expect(frontmatter).toEqual({})
    expect(body).toBe('')
  })

  test('无 frontmatter 分隔符 → 空 frontmatter + 全文 body', () => {
    const { frontmatter, body } = parseSkillFrontmatter('# hello\nworld')
    expect(frontmatter).toEqual({})
    expect(body).toBe('# hello\nworld')
  })

  test('基本标量字段', () => {
    const raw = `---
description: A test skill
when_to_use: When testing
version: 1.0.0
---
body content`
    const { frontmatter, body } = parseSkillFrontmatter(raw)
    expect(frontmatter.description).toBe('A test skill')
    expect(frontmatter.when_to_use).toBe('When testing')
    expect(frontmatter.version).toBe('1.0.0')
    expect(body).toBe('body content')
  })

  test('列表字段', () => {
    const raw = `---
arguments:
  - first
  - second
  - third
---
body`
    const { frontmatter } = parseSkillFrontmatter(raw)
    expect(frontmatter.arguments).toEqual(['first', 'second', 'third'])
  })

  test('带引号的字符串保留空格', () => {
    const raw = `---
name: 'hello world'
description: "double quoted"
---
body`
    const { frontmatter } = parseSkillFrontmatter(raw)
    expect(frontmatter.name).toBe('hello world')
    expect(frontmatter.description).toBe('double quoted')
  })

  test('布尔字段', () => {
    const raw = `---
disable-model-invocation: true
user-invocable: false
---
body`
    const { frontmatter } = parseSkillFrontmatter(raw)
    expect(frontmatter['disable-model-invocation']).toBe(true)
    expect(frontmatter['user-invocable']).toBe(false)
  })

  test('缺失闭合 --- 抛错', () => {
    expect(() => parseSkillFrontmatter('---\nkey: value\nbody', 'test.md'))
      .toThrow(/frontmatter/i)
  })

  test('未声明字段保留原始值', () => {
    const raw = `---
description: test
custom-field: hello
---
body`
    const { frontmatter } = parseSkillFrontmatter(raw)
    expect(frontmatter['custom-field']).toBe('hello')
  })

  test('body 保留换行与缩进', () => {
    const raw = `---
description: x
---
line1
  indented
line2`
    const { body } = parseSkillFrontmatter(raw)
    expect(body).toBe('line1\n  indented\nline2')
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/skills/frontmatter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 创建 `src/runtime/skills/types.ts`**

```ts
export type SkillFrontmatter = {
  name?: string
  description?: string
  when_to_use?: string
  version?: string
  model?: string
  'disable-model-invocation'?: boolean
  'user-invocable'?: boolean
  'allowed-tools'?: string[]
  'argument-hint'?: string
  arguments?: string | string[]
  context?: 'fork'
  agent?: string
  effort?: string | number
  shell?: string
  hooks?: Record<string, unknown>
  paths?: string | string[]
  [k: string]: unknown
}

export type LoadedSkill = {
  name: string
  baseDir: string
  filePath: string
  frontmatter: SkillFrontmatter
  markdown: string
  sourceIndex: number
}

export type PendingSkillInjection = {
  skillName: string
  content: string
}
```

- [ ] **Step 4: 创建 `src/runtime/skills/frontmatter.ts`**

```ts
import type { SkillFrontmatter } from './types.js'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parseSkillFrontmatter(
  raw: string,
  filename?: string,
): { frontmatter: SkillFrontmatter; body: string } {
  if (!raw) return { frontmatter: {}, body: '' }

  const match = FRONTMATTER_RE.exec(raw)
  if (!match) return { frontmatter: {}, body: raw }

  const [, fmBlock, body] = match
  const frontmatter = parseFrontmatterBlock(fmBlock, filename)
  return { frontmatter, body: body ?? '' }
}

function parseFrontmatterBlock(
  block: string,
  filename?: string,
): SkillFrontmatter {
  const lines = block.split(/\r?\n/)
  const out: Record<string, unknown> = {}

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim() || line.trim().startsWith('#')) {
      i++
      continue
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) {
      throw new Error(
        `Invalid frontmatter at line ${i + 1}${filename ? ` in ${filename}` : ''}: ${line}`,
      )
    }
    const key = m[1]!
    const rest = m[2] ?? ''

    if (rest === '' && i + 1 < lines.length && /^\s+- /.test(lines[i + 1]!)) {
      // list value
      const items: string[] = []
      i++
      while (i < lines.length && /^\s+- /.test(lines[i]!)) {
        items.push(unquote((lines[i]!).replace(/^\s+-\s+/, '')))
        i++
      }
      out[key] = items
      continue
    }

    out[key] = coerceScalar(rest)
    i++
  }

  return out as SkillFrontmatter
}

function coerceScalar(raw: string): string | boolean | number | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return unquote(trimmed)
}

function unquote(s: string): string {
  const t = s.trim()
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"'))
  ) {
    return t.slice(1, -1)
  }
  return t
}
```

- [ ] **Step 5: 写失败测试 `test/skills/substitute.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import { substituteArguments } from '../../src/runtime/skills/substitute.js'

describe('substituteArguments', () => {
  test('$ARGUMENTS 替换为整个 args', () => {
    expect(substituteArguments('hello $ARGUMENTS', 'world foo', true))
      .toBe('hello world foo')
  })

  test('$1 $2 位置替换', () => {
    expect(substituteArguments('a=$1 b=$2', 'foo bar', true)).toBe('a=foo b=bar')
  })

  test('quoted 模式：参数按 shell 风格 quoted', () => {
    expect(substituteArguments('a=$1', 'foo bar', true)).toBe('a=foo bar')
    expect(substituteArguments('a=$1', 'foo bar', false)).toBe('a=foo')
  })

  test('declared argNames: $NAME 整体替换', () => {
    expect(substituteArguments('msg=$MSG end', 'hello world', true, ['MSG']))
      .toBe('msg=hello world end')
  })

  test('无占位符时原样返回', () => {
    expect(substituteArguments('plain text', 'foo', true)).toBe('plain text')
  })

  test('$@ 等价于 $ARGUMENTS', () => {
    expect(substituteArguments('cmd $@', 'a b c', true)).toBe('cmd a b c')
  })
})
```

- [ ] **Step 6: 创建 `src/runtime/skills/substitute.ts`**

```ts
export function substituteArguments(
  body: string,
  args: string,
  quoted: boolean,
  argNames: string[] = [],
): string {
  if (!args && argNames.length === 0) return body

  const tokens = args ? splitArgs(args, quoted) : []
  let out = body
  out = out.replace(/\$ARGUMENTS/g, args)
  out = out.replace(/\$@/g, args)
  for (let i = 0; i < tokens.length; i++) {
    out = out.replace(new RegExp(`\\$${i + 1}\\b`, 'g'), tokens[i]!)
  }
  for (const name of argNames) {
    out = out.replace(new RegExp(`\\$${name}\\b`, 'g'), args)
  }
  return out
}

function splitArgs(args: string, quoted: boolean): string[] {
  if (!quoted) return args.split(/\s+/).filter(Boolean)
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(args)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return tokens
}
```

- [ ] **Step 7: 跑两个测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/skills/frontmatter.test.ts test/skills/substitute.test.ts`
Expected: PASS — all tests green

- [ ] **Step 8: Commit**

```bash
git add packages/zai-agent-core/src/runtime/skills/types.ts \
        packages/zai-agent-core/src/runtime/skills/frontmatter.ts \
        packages/zai-agent-core/src/runtime/skills/substitute.ts \
        packages/zai-agent-core/test/skills/frontmatter.test.ts \
        packages/zai-agent-core/test/skills/substitute.test.ts
git commit -m "feat(zai-agent-core): add SkillFrontmatter types + frontmatter/substitute helpers"
```

---

## Task 2: Loader — 目录扫描与 description fallback

**Files:**
- Create: `packages/zai-agent-core/src/runtime/skills/loader.ts`
- Create: `packages/zai-agent-core/test/skills/loader.test.ts`

**Interfaces:**
- Consumes: `parseSkillFrontmatter` from Task 1
- Produces: `loadSkillsFromDirs(dirs, opts?) → Promise<LoadedSkill[]>` — 扫描 `<dir>/<...>/SKILL.md`，realpath 去重，description fallback

- [ ] **Step 1: 写失败测试 `test/skills/loader.test.ts`**

```ts
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
    await writeFile(join(tmp, 'foo/SKILL.md'), '---\nname: foo\n---\n\n  \n# only a heading')
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
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/skills/loader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 创建 `src/runtime/skills/loader.ts`**

```ts
import { readdir, readFile, realpath } from 'fs/promises'
import { dirname, isAbsolute, join, relative, sep as pathSep } from 'path'
import { basename } from 'path'
import { parseSkillFrontmatter } from './frontmatter.js'
import type { LoadedSkill, SkillFrontmatter } from './types.js'

const SKILL_FILENAME_RE = /^skill\.md$/i

export type LoadSkillsOptions = {
  cwd?: string
  homedirOverride?: string
}

export async function loadSkillsFromDirs(
  dirs: string[],
  _opts?: LoadSkillsOptions,
): Promise<LoadedSkill[]> {
  if (dirs.length === 0) return []

  const collected: Array<{ skill: LoadedSkill; fileId: string | null }> = []

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!
    const files = await walkDir(dir)
    for (const file of files) {
      try {
        const skill = await parseSkillFile(file, dir, i)
        if (!skill) continue
        const fileId = await safeRealpath(file)
        collected.push({ skill, fileId })
      } catch (err) {
        console.warn(`[skills] failed to load ${file}:`, err)
      }
    }
  }

  const seen = new Set<string>()
  const result: LoadedSkill[] = []
  for (const { skill, fileId } of collected) {
    if (fileId && seen.has(fileId)) continue
    if (fileId) seen.add(fileId)
    result.push(skill)
  }
  return result
}

async function walkDir(basePath: string): Promise<string[]> {
  const results: string[] = []
  await walk(basePath, basePath, results, new Set())
  return results.sort()
}

async function walk(
  basePath: string,
  current: string,
  out: string[],
  visitedDirs: Set<string>,
): Promise<void> {
  const dirId = await safeRealpath(current)
  if (dirId && visitedDirs.has(dirId)) return
  if (dirId) visitedDirs.add(dirId)

  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    return
  }

  const childDirs: string[] = []
  for (const entry of entries) {
    const entryPath = join(current, entry.name)
    if (SKILL_FILENAME_RE.test(entry.name)) {
      out.push(entryPath)
    } else if (entry.isDirectory()) {
      childDirs.push(entryPath)
    } else if (entry.isSymbolicLink()) {
      try {
        const { stat } = await import('fs/promises')
        const s = await stat(entryPath)
        if (s.isDirectory()) childDirs.push(entryPath)
      } catch {
        // dangling symlink, skip
      }
    }
  }
  await Promise.all(childDirs.map(c => walk(basePath, c, out, visitedDirs)))
}

async function parseSkillFile(
  filePath: string,
  basePath: string,
  sourceIndex: number,
): Promise<LoadedSkill | null> {
  const content = await readFile(filePath, 'utf-8')
  const { frontmatter, body } = parseSkillFrontmatter(content, filePath)

  const description = frontmatter.description?.trim() || extractFirstParagraph(body)
  if (!description) {
    console.warn(`[skills] ${filePath}: missing description, skipping`)
    return null
  }

  const skillDir = dirname(filePath)
  const name = buildName(filePath, basePath, skillDir)
  const normalizedFm: SkillFrontmatter = { ...frontmatter, description }

  return {
    name,
    baseDir: skillDir,
    filePath,
    frontmatter: normalizedFm,
    markdown: body,
    sourceIndex,
  }
}

function buildName(filePath: string, basePath: string, skillDir: string): string {
  const baseName = basename(skillDir)
  const namespace = buildNamespace(skillDir, basePath)
  return namespace ? `${namespace}:${baseName}` : baseName
}

function buildNamespace(targetDir: string, baseDir: string): string {
  const normalizedBase = baseDir.endsWith(pathSep) ? baseDir.slice(0, -1) : baseDir
  if (targetDir === normalizedBase) return ''
  const rel = targetDir.slice(normalizedBase.length + 1)
  return rel ? rel.split(pathSep).join(':') : ''
}

function extractFirstParagraph(body: string): string {
  const lines = body.split(/\r?\n/)
  const buf: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) {
      if (buf.length > 0) break
      continue
    }
    buf.push(t.replace(/^#+\s*/, ''))
  }
  return buf.join(' ')
}

async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p)
  } catch {
    return null
  }
}
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/skills/loader.test.ts`
Expected: PASS — all 11 tests green

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/runtime/skills/loader.ts \
        packages/zai-agent-core/test/skills/loader.test.ts
git commit -m "feat(zai-agent-core): add loadSkillsFromDirs with realpath dedup + description fallback"
```

---

## Task 3: Prompt builder + skills/index.ts

**Files:**
- Create: `packages/zai-agent-core/src/runtime/skills/promptBuilder.ts`
- Create: `packages/zai-agent-core/src/runtime/skills/index.ts`
- Create: `packages/zai-agent-core/test/skills/promptBuilder.test.ts`

**Interfaces:**
- Consumes: `LoadedSkill[]`
- Produces: `buildSkillsSystemPrompt(skills) → string | null`
- Produces: re-exports for `runtime/skills/`

- [ ] **Step 1: 写失败测试 `test/skills/promptBuilder.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import { buildSkillsSystemPrompt } from '../../src/runtime/skills/promptBuilder.js'
import type { LoadedSkill } from '../../src/runtime/skills/types.js'

function skill(name: string, fm: Partial<LoadedSkill['frontmatter']>, markdown = 'full body here'): LoadedSkill {
  return {
    name,
    baseDir: `/skills/${name.replace(':', '/')}`,
    filePath: `/skills/${name.replace(':', '/')}/SKILL.md`,
    frontmatter: { description: 'desc', ...fm },
    markdown,
    sourceIndex: 0,
  }
}

describe('buildSkillsSystemPrompt', () => {
  test('空数组 → null', () => {
    expect(buildSkillsSystemPrompt([])).toBeNull()
  })

  test('单 skill 输出含 name / description / when_to_use', () => {
    const out = buildSkillsSystemPrompt([
      skill('pdf', { description: 'Read PDFs', when_to_use: 'On PDF input' }),
    ])
    expect(out).toContain('<name>pdf</name>')
    expect(out).toContain('<description>Read PDFs</description>')
    expect(out).toContain('<when_to_use>On PDF input</when_to_use>')
  })

  test('不暴露 markdown body（节省 token）', () => {
    const out = buildSkillsSystemPrompt([skill('pdf', {}, 'SHOULD NOT APPEAR')])
    expect(out).not.toContain('SHOULD NOT APPEAR')
  })

  test('多 skill 按顺序输出', () => {
    const out = buildSkillsSystemPrompt([
      skill('alpha', { description: 'A' }),
      skill('beta', { description: 'B' }),
    ])
    const aIdx = out!.indexOf('<name>alpha</name>')
    const bIdx = out!.indexOf('<name>beta</name>')
    expect(aIdx).toBeGreaterThan(-1)
    expect(bIdx).toBeGreaterThan(aIdx)
  })

  test('when_to_use 缺失时不输出该标签', () => {
    const out = buildSkillsSystemPrompt([skill('pdf', { description: 'X' })])
    expect(out).not.toContain('<when_to_use>')
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/skills/promptBuilder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 创建 `src/runtime/skills/promptBuilder.ts`**

```ts
import type { LoadedSkill } from './types.js'

export function buildSkillsSystemPrompt(skills: LoadedSkill[]): string | null {
  if (skills.length === 0) return null

  const blocks = skills
    .map(s => {
      const lines: string[] = []
      lines.push(`<name>${escapeXml(s.name)}</name>`)
      lines.push(`<description>${escapeXml(s.frontmatter.description ?? '')}</description>`)
      if (s.frontmatter.when_to_use) {
        lines.push(`<when_to_use>${escapeXml(s.frontmatter.when_to_use)}</when_to_use>`)
      }
      return `<skill>\n${lines.join('\n')}\n</skill>`
    })
    .join('\n')

  return `The following skills are available for use with the Skill tool:

<skills>
${blocks}
</skills>

When a skill matches the user's intent, invoke it via the Skill tool with the skill name as the \`name\` argument. Only the frontmatter (name/description) is shown above; the full skill body is injected on invocation.`
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
```

- [ ] **Step 4: 创建 `src/runtime/skills/index.ts`**

```ts
export type { LoadedSkill, PendingSkillInjection, SkillFrontmatter } from './types.js'
export { parseSkillFrontmatter } from './frontmatter.js'
export { substituteArguments } from './substitute.js'
export { loadSkillsFromDirs } from './loader.js'
export type { LoadSkillsOptions } from './loader.js'
export { buildSkillsSystemPrompt } from './promptBuilder.js'
```

- [ ] **Step 5: 跑 promptBuilder 测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/skills/promptBuilder.test.ts`
Expected: PASS — all 5 tests green

- [ ] **Step 6: 跑全部 skills 测试确认无回归**

Run: `cd packages/zai-agent-core && pnpm test test/skills/`
Expected: PASS — all 21 tests green (10 frontmatter + 6 substitute + 11 loader + 5 promptBuilder - overlap counts)

- [ ] **Step 7: Commit**

```bash
git add packages/zai-agent-core/src/runtime/skills/promptBuilder.ts \
        packages/zai-agent-core/src/runtime/skills/index.ts \
        packages/zai-agent-core/test/skills/promptBuilder.test.ts
git commit -m "feat(zai-agent-core): add buildSkillsSystemPrompt + skills/index re-exports"
```

---

## Task 4: SkillTool 主体

**Files:**
- Create: `packages/zai-agent-core/src/tools/SkillTool/schema.ts`
- Create: `packages/zai-agent-core/src/tools/SkillTool/prompt.ts`
- Create: `packages/zai-agent-core/src/tools/SkillTool/SkillTool.ts`
- Create: `packages/zai-agent-core/test/tools/SkillTool.test.ts`

**Interfaces:**
- Consumes: `ctx.state.__zaiSkills: LoadedSkill[]` (set by queryEngine in Task 5)
- Consumes: `ctx.state.__pendingSkillInjection: PendingSkillInjection` (writer; queryEngine consumes in Task 5)
- Consumes: `ctx.parentSessionId: string | undefined`
- Produces: `SkillTool: Tool<typeof SkillInputSchema, string>` with `name: 'Skill'`

- [ ] **Step 1: 写失败测试 `test/tools/SkillTool.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import { SkillTool } from '../../src/tools/SkillTool/SkillTool.js'
import type { LoadedSkill } from '../../src/runtime/skills/types.js'
import type { ToolContext } from '../../src/tools/Tool.js'

function makeCtx(skills: LoadedSkill[], state: Record<string, unknown> = {}): ToolContext {
  return {
    cwd: '/tmp',
    env: {},
    abortSignal: new AbortController().signal,
    dataDir: '/tmp',
    canUseTool: async () => ({ behavior: 'allow' as const }),
    emitEvent: () => {},
    state: { __zaiSkills: skills, ...state },
  } as ToolContext
}

const sampleSkill: LoadedSkill = {
  name: 'pdf',
  baseDir: '/skills/pdf',
  filePath: '/skills/pdf/SKILL.md',
  frontmatter: { description: 'Read PDFs', arguments: ['FILE'] },
  markdown: 'Read $FILE as PDF.',
  sourceIndex: 0,
}

describe('SkillTool', () => {
  test('name = Skill', () => {
    expect(SkillTool.name).toBe('Skill')
  })

  test('找不到 skill → 返回 isError=true + 列表', async () => {
    const ctx = makeCtx([sampleSkill])
    const out = await SkillTool.call({ name: 'nope' }, ctx)
    expect(out.isError).toBe(true)
    expect(out.output).toContain("'nope'")
    expect(out.output).toContain('pdf')
  })

  test('替换 ${CLAUDE_SKILL_DIR}', async () => {
    const ctx = makeCtx([sampleSkill], { parentSessionId: 'sess-abc' })
    await SkillTool.call({ name: 'pdf' }, ctx)
    const pending = ctx.state.__pendingSkillInjection as { content: string }
    expect(pending.content).toBe('Read /skills/pdf as PDF.')
  })

  test('替换 ${CLAUDE_SESSION_ID}', async () => {
    const skill: LoadedSkill = {
      ...sampleSkill,
      markdown: 'session: ${CLAUDE_SESSION_ID}',
    }
    const ctx = makeCtx([skill], { parentSessionId: 'sess-xyz' })
    await SkillTool.call({ name: 'pdf' }, ctx)
    const pending = ctx.state.__pendingSkillInjection as { content: string }
    expect(pending.content).toBe('session: sess-xyz')
  })

  test('args 替换：$1 $NAME', async () => {
    const ctx = makeCtx([sampleSkill])
    await SkillTool.call({ name: 'pdf', args: 'report.pdf' }, ctx)
    const pending = ctx.state.__pendingSkillInjection as { content: string }
    expect(pending.content).toBe('Read report.pdf as PDF.')
  })

  test('tool result 包裹 <skill_invocation>', async () => {
    const ctx = makeCtx([sampleSkill])
    const out = await SkillTool.call({ name: 'pdf', args: 'doc.pdf' }, ctx)
    expect(out.output).toContain('<skill_invocation name="pdf">')
    expect(out.output).toContain('Read doc.pdf as PDF.')
    expect(out.output).toContain('</skill_invocation>')
    expect(out.isError).toBe(false)
  })

  test('ctx.state 无 __zaiSkills 时不抛错', async () => {
    const ctx: ToolContext = {
      cwd: '/tmp',
      env: {},
      abortSignal: new AbortController().signal,
      dataDir: '/tmp',
      canUseTool: async () => ({ behavior: 'allow' as const }),
      emitEvent: () => {},
      state: {},
    }
    const out = await SkillTool.call({ name: 'pdf' }, ctx)
    expect(out.isError).toBe(true)
    expect(out.output).toContain('not found')
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/tools/SkillTool.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 创建 `src/tools/SkillTool/schema.ts`**

```ts
import { z } from 'zod'

export const SkillInputSchema = z.object({
  name: z.string().min(1).describe('The skill name to invoke (e.g. "pdf", "code-review")'),
  args: z.string().optional().describe('Arguments to substitute into the skill body via $ARGUMENTS / $1..$N'),
})

export type SkillInput = z.infer<typeof SkillInputSchema>
```

- [ ] **Step 4: 创建 `src/tools/SkillTool/prompt.ts`**

```ts
export function renderPrompt(): string {
  return `Invoke a skill by name. The skill body is injected as a user message for the current session.

Args:
  - name: The skill name as listed in the <skills> block of the system prompt
  - args: Optional argument string to substitute into the skill body

The skill's full markdown body becomes available to you after invocation. Invoke a skill only when its description matches the user's request.`
}
```

- [ ] **Step 5: 创建 `src/tools/SkillTool/SkillTool.ts`**

```ts
import type { Tool, ToolContext } from '../Tool.js'
import type { LoadedSkill, PendingSkillInjection } from '../../runtime/skills/index.js'
import { substituteArguments } from '../../runtime/skills/substitute.js'
import { renderPrompt } from './prompt.js'
import { SkillInputSchema, type SkillInput } from './schema.js'

export const SkillTool: Tool<typeof SkillInputSchema, string> = {
  name: 'Skill',
  description: renderPrompt(),
  inputSchema: SkillInputSchema,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,

  async call(rawInput, ctx) {
    const input = rawInput as SkillInput
    const skills: LoadedSkill[] = (ctx.state.__zaiSkills as LoadedSkill[] | undefined) ?? []
    const skill = skills.find(s => s.name === input.name)

    if (!skill) {
      const available = skills.map(s => s.name).join(', ') || '(none)'
      return {
        output: `Skill '${input.name}' not found. Available skills: ${available}`,
        isError: true,
      }
    }

    let body = skill.markdown

    if (skill.baseDir) {
      const skillDir = process.platform === 'win32'
        ? skill.baseDir.replace(/\\/g, '/')
        : skill.baseDir
      body = body.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
    }
    body = body.replace(
      /\$\{CLAUDE_SESSION_ID\}/g,
      ctx.parentSessionId ?? 'sess-unknown',
    )

    if (input.args !== undefined) {
      const argNames = Array.isArray(skill.frontmatter.arguments)
        ? skill.frontmatter.arguments
        : typeof skill.frontmatter.arguments === 'string'
          ? [skill.frontmatter.arguments]
          : []
      body = substituteArguments(body, input.args, true, argNames)
    }

    const pending: PendingSkillInjection = {
      skillName: skill.name,
      content: body,
    }
    ctx.state.__pendingSkillInjection = pending

    return {
      output: `<skill_invocation name="${skill.name}">\n${body}\n</skill_invocation>`,
      isError: false,
    }
  },
}
```

- [ ] **Step 6: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/tools/SkillTool.test.ts`
Expected: PASS — all 7 tests green

- [ ] **Step 7: Commit**

```bash
git add packages/zai-agent-core/src/tools/SkillTool/ \
        packages/zai-agent-core/test/tools/SkillTool.test.ts
git commit -m "feat(zai-agent-core): add SkillTool with same-session prompt injection"
```

---

## Task 5: RuntimeConfig + QueryOptions 扩展

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/types.ts`
- Test: `packages/zai-agent-core/test/runtime/types.test.ts` (extend existing or new file)

**Interfaces:**
- Produces: `RuntimeConfig.skillsDirs?: string[]`, `RuntimeConfig.enableSkillTool?: boolean`
- Produces: `QueryOptions.skillsDirs?: string[]`
- Preserves: `RuntimeConfig.enabledSkills?: string[]` as `@deprecated`

- [ ] **Step 1: 写失败测试 `test/runtime/types.test.ts`（新建或扩展）**

```ts
import { describe, expect, test } from 'vitest'
import type { RuntimeConfig, QueryOptions } from '../../src/runtime/types.js'

describe('RuntimeConfig skill fields', () => {
  test('skillsDirs 可选', () => {
    const cfg: RuntimeConfig = { dataDir: '/tmp' }
    expect(cfg.skillsDirs).toBeUndefined()
  })

  test('enableSkillTool 默认未设置', () => {
    const cfg: RuntimeConfig = { dataDir: '/tmp', skillsDirs: ['/skills'] }
    expect(cfg.enableSkillTool).toBeUndefined()
  })

  test('enabledSkills 仍可作为 @deprecated 字段使用', () => {
    const cfg: RuntimeConfig = { dataDir: '/tmp', enabledSkills: ['pdf'] }
    expect(cfg.enabledSkills).toEqual(['pdf'])
  })
})

describe('QueryOptions skill fields', () => {
  test('skillsDirs 可选', () => {
    const opts: QueryOptions = { prompt: 'hi', cwd: '/tmp' }
    expect(opts.skillsDirs).toBeUndefined()
  })

  test('skillsDirs 与 RuntimeConfig.skillsDirs 不冲突', () => {
    const opts: QueryOptions = { prompt: 'hi', cwd: '/tmp', skillsDirs: ['/override'] }
    expect(opts.skillsDirs).toEqual(['/override'])
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/types.test.ts`
Expected: FAIL — `skillsDirs` does not exist on type

- [ ] **Step 3: 修改 `src/runtime/types.ts`**

在 `RuntimeConfig` 中：

```ts
export type RuntimeConfig = {
  dataDir: string
  defaultModel?: string
  defaultPermissions?: Record<string, unknown>
  mcpServers?: Array<{ name: string; command?: string; args?: string[]; url?: string }>
  /**
   * @deprecated Use `skillsDirs` (path whitelist) instead. Retained for
   *   type-level back-compat only; not read by zai-agent-core.
   */
  enabledSkills?: string[]
  /** Skill directory path whitelist. Empty/undefined = no skills loaded. */
  skillsDirs?: string[]
  /** Register SkillTool when skills.length > 0. Default: true when skillsDirs is set. */
  enableSkillTool?: boolean

  modelCaller?: ModelCaller
  sandbox?: SandboxConfig
  defaultMaxTurns?: number
}
```

在 `QueryOptions` 中追加：

```ts
export type QueryOptions = {
  // ...existing fields...
  /** Per-request override of RuntimeConfig.skillsDirs. Higher priority than config. */
  skillsDirs?: string[]
}
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/types.test.ts`
Expected: PASS

- [ ] **Step 5: 跑 typecheck 确认无破坏**

Run: `cd packages/zai-agent-core && pnpm typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/zai-agent-core/src/runtime/types.ts \
        packages/zai-agent-core/test/runtime/types.test.ts
git commit -m "feat(zai-agent-core): extend RuntimeConfig/QueryOptions with skillsDirs"
```

---

## Task 6: queryEngine 接入

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/queryEngine.ts`
- Test: extend `packages/zai-agent-core/test/runtime/queryEngine.test.ts`

**Interfaces:**
- Consumes: `loadSkillsFromDirs`, `buildSkillsSystemPrompt` (Task 2/3)
- Consumes: `SkillTool` (Task 4)
- Consumes: extended `RuntimeConfig.skillsDirs`, `QueryOptions.skillsDirs` (Task 5)
- Produces: `queryEngine` 时按 `skills.length > 0` 动态注册 `SkillTool`；system prompt 含 `<skills>` 段；`__pendingSkillInjection` 在 tool results 之后追加为 user message 并落盘 transcript

- [ ] **Step 1: 在 queryEngine.test.ts 顶部加 mock skill 工具调用 helper**

扩展 `test/runtime/queryEngine.test.ts`，添加下列 fixture：

```ts
// 追加到 test/runtime/queryEngine.test.ts 顶部
import { mkdir, writeFile } from 'fs/promises'

async function setupSkillsDir(tmp: string, relPath: string, fm: string, body = 'PDF body'): Promise<string> {
  const dir = `${tmp}/skills/${relPath}`
  await mkdir(dir, { recursive: true })
  await writeFile(`${dir}/SKILL.md`, `---\n${fm}\n---\n${body}`)
  return `${tmp}/skills`
}

// 扩展 test/fixtures/MockModelCaller.ts 添加 'skill-call' scenario：
// yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Skill', input: {} } }
// yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"name":"pdf","args":"report.pdf"}' } }
// yield { type: 'content_block_stop', index: 0 }
// yield { type: 'message_stop' }
```

- [ ] **Step 2: 写失败测试 — skillsDirs 非空 → SkillTool 出现，system prompt 含 `<skills>`**

追加到 `test/runtime/queryEngine.test.ts`：

```ts
test('skillsDirs 非空 → SkillTool 出现在 tools, system prompt 含 <skills>', async () => {
  const skillsDir = await setupSkillsDir(tmpDir, 'pdf', 'description: Read PDFs', 'PDF body')
  const calls: Array<{ tools: Array<{ name: string }>; systemPrompt: string }> = []
  const captureCaller = (req: any) => {
    calls.push({ tools: req.tools, systemPrompt: String(req.systemPrompt) })
    return (async function* () {
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    })()
  }
  const events = await collect(queryEngine(
    { prompt: 'hi', cwd: '/tmp' },
    { dataDir: tmpDir, modelCaller: captureCaller as any, skillsDirs: [skillsDir] },
  ))
  expect(events.at(-1)?.type).toBe('runtime.done')
  expect(calls[0]!.tools.some(t => t.name === 'Skill')).toBe(true)
  expect(calls[0]!.systemPrompt).toContain('<skills>')
  expect(calls[0]!.systemPrompt).toContain('<name>pdf</name>')
  expect(calls[0]!.systemPrompt).toContain('Read PDFs')
  expect(calls[0]!.systemPrompt).not.toContain('PDF body') // body 不暴露在 system prompt
})
```

- [ ] **Step 3: 写失败测试 — skillsDirs 空 → SkillTool 不注册**

```ts
test('skillsDirs 缺失 → SkillTool 不出现, system prompt 无 <skills>', async () => {
  const calls: Array<{ tools: Array<{ name: string }>; systemPrompt: string }> = []
  const captureCaller = (req: any) => {
    calls.push({ tools: req.tools, systemPrompt: String(req.systemPrompt) })
    return (async function* () {
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    })()
  }
  const events = await collect(queryEngine(
    { prompt: 'hi', cwd: '/tmp' },
    { dataDir: tmpDir, modelCaller: captureCaller as any },
  ))
  expect(events.at(-1)?.type).toBe('runtime.done')
  expect(calls[0]!.tools.some(t => t.name === 'Skill')).toBe(false)
  expect(calls[0]!.systemPrompt).not.toContain('<skills>')
})
```

- [ ] **Step 4: 写失败测试 — SkillTool 调不存在的 skill → isError=true**

需要 `MockModelCaller` 支持 `tool-then-error` scenario：先 yield `Skill(name='nope')`，再次 yield text-only done。

```ts
test('SkillTool 调不存在的 skill → tool_result isError=true', async () => {
  const skillsDir = await setupSkillsDir(tmpDir, 'pdf', 'description: x')
  const events = await collect(queryEngine(
    { prompt: 'hi', cwd: '/tmp' },
    {
      dataDir: tmpDir,
      modelCaller: makeMockModelCaller('skill-not-found') as any,
      sandbox: makeMockSandbox('/tmp'),
      skillsDirs: [skillsDir],
    },
  ))
  // tool_use:done 事件应携带 isError=true 的 output
  const toolDone = events.find(e => e.type === 'tool_use:done') as any
  expect(toolDone?.output).toContain("'nope' not found")
  expect(events.at(-1)?.type).toBe('runtime.error') // model 收到 isError 后可再调用 → 这里走 max-loop 路径
})
```

- [ ] **Step 5: 写失败测试 — SkillTool 调用成功 → 追加 user message 含 skill body + 落盘 transcript**

```ts
test('SkillTool 调用成功 → tool_result 后追加 user message 含 skill body, transcript 落盘', async () => {
  const skillsDir = await setupSkillsDir(tmpDir, 'pdf', 'description: x', 'INJECT-BODY-XYZ')
  const events = await collect(queryEngine(
    { prompt: 'hi', cwd: '/tmp' },
    {
      dataDir: tmpDir,
      modelCaller: makeMockModelCaller('skill-call-then-text') as any,
      sandbox: makeMockSandbox('/tmp'),
      skillsDirs: [skillsDir],
    },
  ))
  // transcript 中应能找到含 INJECT-BODY-XYZ 的 user message
  const store = new TranscriptStore(tmpDir)
  const sessions = await store.list()
  expect(sessions.length).toBeGreaterThan(0)
  const t = await store.read(sessions[0]!.sessionId)
  const allText = JSON.stringify(t.messages)
  expect(allText).toContain('INJECT-BODY-XYZ')
  expect(allText).toContain('<skill_invocation name="pdf">')
})
```

> 此测试要求 `makeMockModelCaller` 支持 `skill-call-then-text` scenario：先 yield Skill tool_use，第二轮 yield text-only。

- [ ] **Step 6: 写失败测试 — frontmatter 解析失败 → 跳过该文件不阻断其他**

```ts
test('一个 SKILL.md frontmatter 损坏 → 其他 skill 仍加载', async () => {
  const skillsDir = `${tmpDir}/skills`
  await mkdir(`${skillsDir}/good`, { recursive: true })
  await writeFile(`${skillsDir}/good/SKILL.md`, '---\ndescription: good\n---\nbody')
  await mkdir(`${skillsDir}/bad`, { recursive: true })
  await writeFile(`${skillsDir}/bad/SKILL.md`, '---\nno closing')
  const calls: Array<{ systemPrompt: string }> = []
  const captureCaller = (req: any) => {
    calls.push({ systemPrompt: String(req.systemPrompt) })
    return (async function* () {
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    })()
  }
  const events = await collect(queryEngine(
    { prompt: 'hi', cwd: '/tmp' },
    { dataDir: tmpDir, modelCaller: captureCaller as any, skillsDirs: [skillsDir] },
  ))
  expect(events.at(-1)?.type).toBe('runtime.done')
  expect(calls[0]!.systemPrompt).toContain('<name>good</name>')
  expect(calls[0]!.systemPrompt).not.toContain('<name>bad</name>')
})
```

- [ ] **Step 7: 跑测试确认全部 fail（未实现前）**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/queryEngine.test.ts`
Expected: FAIL — skills 相关测试全部失败（5 个）

- [ ] **Step 8: 修改 `src/runtime/queryEngine.ts`**

在文件顶部 import 区添加：

```ts
import { loadSkillsFromDirs, buildSkillsSystemPrompt } from './skills/index.js'
import { SkillTool } from '../tools/SkillTool/SkillTool.js'
import type { LoadedSkill, PendingSkillInjection } from './skills/index.js'
```

在 `queryEngine` 主函数顶部、动态 import `getZaiRuntimeTools` 之后，添加 skill 加载与 tool pool 解析：

```ts
  // 0.1. 加载 skills (skillsDirs 缺失 → 空)
  const skillsDirs = options.skillsDirs ?? config.skillsDirs ?? []
  const skills: LoadedSkill[] = skillsDirs.length > 0
    ? await loadSkillsFromDirs(skillsDirs, { cwd: options.cwd })
    : []

  // 0.2. Dynamic import breaks queryEngine ↔ getZaiRuntimeTools cycle (Task 11)
  const { getZaiRuntimeTools } = await import('../tools/index.js')
  const tools = resolveToolPool(options, config, getZaiRuntimeTools(), skills)
```

把原 `resolveToolPool` 签名扩展为接受 `skills`：

```ts
function resolveToolPool(
  options: QueryOptions,
  _config: RuntimeConfig,
  base: Tool[],
  skills: LoadedSkill[],
): Tool[] {
  const preset = options.toolsOverride ?? 'base+subagent'
  const skillToolEnabled = skills.length > 0 && (_config.enableSkillTool ?? true)
  const skillTool = skillToolEnabled ? [SkillTool] : []
  if (preset === 'none') {
    return [...(options.additionalTools ?? []), ...skillTool]
  }
  return [...base, ...skillTool, ...(options.additionalTools ?? [])]
}
```

修改 `buildSystemPrompt` 接受 skills 参数并拼接：

```ts
async function buildSystemPrompt(
  options: QueryOptions,
  skills: LoadedSkill[],
): Promise<string> {
  const parts: string[] = []
  if (options.systemPrompt) {
    parts.push(typeof options.systemPrompt === 'string'
      ? options.systemPrompt
      : options.systemPrompt.map(b => JSON.stringify(b)).join('\n'))
  }
  if (options.enableAgentsMd !== false) {
    try {
      const agentsMd = await loadAgentsMd(options.cwd)
      parts.push(buildAgentsMdSystemPrompt(agentsMd) ?? '')
    } catch { /* AGENTS.md 不存在, 静默降级 */ }
  }
  const skillsPrompt = buildSkillsSystemPrompt(skills)
  if (skillsPrompt) parts.push(skillsPrompt)
  return parts.filter(Boolean).join('\n\n')
}
```

调用处改为：

```ts
  const systemPrompt = await buildSystemPrompt(options, skills)
```

修改 `makeToolContext` 把 skills 写入 state：

```ts
function makeToolContext(
  options: QueryOptions,
  config: RuntimeConfig,
  _sessionId: string,
  abortController: AbortController,
): ToolContext {
  const baseSandbox = config.sandbox ?? {
    executor: 'child_process' as const,
    workdir: options.cwd,
  }
  const sandbox: SandboxConfig = { ...baseSandbox, workdir: options.cwd || baseSandbox.workdir }
  return {
    cwd: options.cwd,
    env: process.env as Record<string, string>,
    abortSignal: abortController.signal,
    dataDir: config.dataDir,
    canUseTool: defaultCanUseToolFactory(sandbox),
    emitEvent: () => { /* events already yielded */ },
    state: { __zaiSkills: skills },
    __runtimeConfig: { ...config, sandbox },
    __defaultModel: options.model ?? config.defaultModel ?? 'default',
    __maxTurns: options.maxTurns ?? config.defaultMaxTurns ?? DEFAULT_MAX_TURNS,
    parentSessionId: options.parentSessionId,
  }
}
```

在 `messages.push(tool_results)` 之后、`if (turn >= maxTurns)` 之前，处理 `__pendingSkillInjection`：

```ts
    messages.push({ role: 'user', content: toolUseBlocks.map((t, i) => ({
      type: 'tool_result',
      tool_use_id: t.id,
      content: lastResults[i]?.content ?? '',
      is_error: lastResults[i]?.isError ?? false,
    })) })

    // Skill body injection: SkillTool sets this flag in ctx.state; we
    // append it as a separate user message so the model sees the skill
    // body in the next turn, matching OpenCC behavior.
    const pending = toolCtx.state.__pendingSkillInjection as PendingSkillInjection | undefined
    if (pending) {
      messages.push({ role: 'user', content: pending.content })
      await appendUserMessage(store, sessionId, pending.content, turn)
      toolCtx.state.__pendingSkillInjection = undefined
    }
```

- [ ] **Step 9: 扩展 `test/fixtures/MockModelCaller.ts` 添加新 scenarios**

```ts
// test/fixtures/MockModelCaller.ts 追加
export function makeSkillCallThenTextModelCaller(): ModelCaller {
  return (async function* (req) {
    yield { type: 'message_start', message: { id: 'm1' } }
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Skill', input: {} } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"name":"pdf","args":"report.pdf"}' } }
    yield { type: 'content_block_stop', index: 0 }
    yield { type: 'message_stop' }
    return
  })
}

export function makeSkillNotFoundModelCaller(): ModelCaller {
  return (async function* () {
    yield { type: 'message_start', message: { id: 'm1' } }
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Skill', input: {} } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"name":"nope"}' } }
    yield { type: 'content_block_stop', index: 0 }
    yield { type: 'message_stop' }
    return
  })
}
```

- [ ] **Step 10: 跑 queryEngine 测试确认全部 pass**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/queryEngine.test.ts`
Expected: PASS — 原 7 个 + 新增 5 个 = 12 个全绿

- [ ] **Step 11: 跑全套测试 + typecheck 确认无回归**

Run: `cd packages/zai-agent-core && pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add packages/zai-agent-core/src/runtime/queryEngine.ts \
        packages/zai-agent-core/test/runtime/queryEngine.test.ts \
        packages/zai-agent-core/test/fixtures/MockModelCaller.ts
git commit -m "feat(zai-agent-core): wire skills + SkillTool into queryEngine loop"
```

---

## Task 7: package.json exports + README 更新

**Files:**
- Modify: `packages/zai-agent-core/package.json`
- Modify: `packages/zai-agent-core/README.md`

**Interfaces:**
- Produces: 新增 `exports['./skills']`
- Produces: README 文档化 SKILL 用法

- [ ] **Step 1: 修改 `package.json`**

在 `exports` 字段追加：

```json
{
  ".": "./dist/index.js",
  "./runtime": "./dist/runtime/index.js",
  "./skills": "./dist/runtime/skills/index.js",
  "./transcript": "./dist/transcript/store.js"
}
```

- [ ] **Step 2: 更新 `README.md`**

在「快速开始」节后追加新章节：

```markdown
## SKILL 配置

zai-agent-core 支持 file-based skill 加载。通过 `RuntimeConfig.skillsDirs` 配置目录白名单：

\`\`\`ts
import { DefaultAgentRuntime } from '@zn-ai/zai-agent-core'

const runtime = new DefaultAgentRuntime({
  dataDir: '~/.zai',
  skillsDirs: ['/path/to/team-skills', '/path/to/personal-skills'],
})
\`\`\`

skill 目录格式（与 OpenCC 一致）：

\`\`\`
skills/
└── pdf/
    └── SKILL.md
\`\`\`

`SKILL.md` frontmatter 支持字段：`name`、`description`（可从 body 第一段提取）、`when_to_use`、`version`、`model`、`disable-model-invocation`、`user-invocable`、`allowed-tools`、`argument-hint`、`arguments`、`paths` 等。详见 spec §2.3。

调用方可通过 `enableSkillTool: false` 关闭 `Skill` 工具（仅在 system prompt 暴露 skill 列表，模型不可调用）。

### 旧字段迁移

`enabledSkills?: string[]`（skill 名白名单）已 deprecated，请改用 `skillsDirs: string[]`（路径白名单）。
```

- [ ] **Step 3: 跑 build 确认 export 路径生效**

Run: `cd packages/zai-agent-core && pnpm build && ls dist/runtime/skills/`
Expected: 看到 `index.js`、`index.d.ts`、`frontmatter.js` 等产物

- [ ] **Step 4: 跑全套测试确认无回归**

Run: `cd packages/zai-agent-core && pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/package.json packages/zai-agent-core/README.md
git commit -m "docs(zai-agent-core): expose skills export + README skill usage"
```

---

## Self-Review Checklist（执行前请 reviewer 确认）

### Spec 覆盖检查

| Spec 节 | 覆盖任务 |
|---------|----------|
| §2.1 RuntimeConfig.skillsDirs / enableSkillTool | Task 5 |
| §2.2 QueryOptions.skillsDirs | Task 5 |
| §2.3 SkillFrontmatter 全字段 | Task 1（type 定义） |
| §3 Loader 实现 + description fallback | Task 2 |
| §3.4 frontmatter 自写最小 YAML 解析 | Task 1 |
| §3.5 promptBuilder 输出格式 | Task 3 |
| §4 SkillTool schema / prompt / body 注入 | Task 4 |
| §5.1 queryEngine tool pool 动态注入 SkillTool | Task 6 |
| §5.2 skill 加载 + 注入 ToolContext | Task 6 |
| §5.3 system prompt 拼接 | Task 6 |
| §5.4 skill 注入到 messages + transcript 落盘 | Task 6 |
| §5.5 SkillTool 不进 base tool pool | Task 6 |
| §5.6 enabledSkills 标 deprecated | Task 5 |
| §6 测试覆盖（3 单元 + 5 集成） | Task 1-6 |

### 一致性检查

- `LoadedSkill` 类型在 Task 1（types.ts）定义，Task 2（loader.ts）使用，Task 3（promptBuilder.ts）使用，Task 4（SkillTool.ts）通过 `state.__zaiSkills` 消费 — 签名一致
- `PendingSkillInjection` 在 Task 1 定义，Task 4 写入，Task 6 消费并清空 — 流转闭合
- `loadSkillsFromDirs(dirs, opts?)` 签名 Task 2 定义，Task 6 调 `loadSkillsFromDirs(skillsDirs, { cwd: options.cwd })` — 一致
- `substituteArguments(body, args, quoted, argNames?)` 签名 Task 1 定义，Task 4 调用 — 一致
- `__zaiSkills` 在 Task 4 / Task 6 都通过 `state.__zaiSkills` 访问（Task 6 之前的 prose 草稿曾放顶层，自审已统一）

### 风险与依赖

- Task 4 假设 `ctx.state.__zaiSkills` 由 Task 6 注入 — Task 6 之前 Task 4 的单元测试自给 state（不依赖 queryEngine）
- Task 5 改 `types.ts` 后，Task 6 才引用新字段 — 顺序正确
- Task 6 Step 9 扩展 `MockModelCaller`，需先于 Step 4 / Step 5 测试运行

### 范围

本 plan 7 个 task，对应 spec 一整个 feature 的最小可交付实现。未包含（spec §10 已留 hook）：
- hooks 触发
- skill body 内联 shell 执行
- conditional paths 激活
- MCP / plugin / bundled skills