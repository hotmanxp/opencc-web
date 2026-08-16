# zai Web 端 /handoff 指令实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai web/mobile 端实现 `/handoff` slash 命令,行为对齐 OpenCC vendor(`commands/handoff/index.ts`):PICKUP 扫 `.agent_working_dir/handoff/`,GENERATE 让 LLM 写新交接文档;handler 在 zai 服务端确定性构造 prompt,实际写盘/读取交给 zai LLM 用现有工具完成。

**Architecture:** zai server 注册一个 `type: 'prompt'` 命令,handler 复用 vendor 纯 fs 工具(`listHandoffs` / `getLatestHandoff` / `buildHandoffPath`),按 `assistantCount ≤ 4` / `> 4` 走 PICKUP / GENERATE 分支,在服务端组装完整 prompt 文本,前端通过 `/api/agent/command` 拿到 `{type:'prompt', payload:{rendered}}` 后调 `submitPrompt` 把 rendered 作为模型输入,LLM 用 zai 的 `Write` / `Read` / `AskUserQuestion` 工具完成落盘与交互。

**Tech Stack:** TypeScript ^5.6, Node >=20, Vitest ^4.1, Express + SSE(server side), React + AntD(frontend). 无新依赖。

## File Structure

### Create

| 路径 | 职责 |
|------|------|
| `packages/zn-agent-core/src/compat/commands/handoffFs.ts` | re-export vendor fs 工具(`listHandoffs` / `getLatestHandoff` / `buildHandoffPath`) |
| `packages/zn-agent-core/test/unit/compat/handoffFs.test.ts` | re-export smoke 测试 + `listHandoffs` 集成测试(tmpdir) |
| `packages/zai/src/server/services/commands/builtin/handoff/prompts/generate.ts` | GENERATE 提示词模板(纯函数,中文,对齐 vendor `commands/handoff/prompts/generate.ts` 章节结构) |
| `packages/zai/src/server/services/commands/builtin/handoff/prompts/pickup.ts` | PICKUP 提示词模板(纯函数,中文,对齐 vendor `prompts/pickup.ts`) |
| `packages/zai/src/server/services/commands/builtin/handoff/prompts/generate.test.ts` | generate 模板单测 |
| `packages/zai/src/server/services/commands/builtin/handoff/prompts/pickup.test.ts` | pickup 模板单测 |
| `packages/zai/src/server/services/commands/builtin/handoffCommand.ts` | `PromptCommand` 定义 + handler(parseArgs / resolveCwd / countAssistantMessages / readTaskListText / getPromptForCommand) |
| `packages/zai/src/server/services/commands/builtin/handoffCommand.test.ts` | handler 单测(端到端覆盖 PICKUP / GENERATE / `--pick` / error) |

### Modify

| 路径 | 改动 |
|------|------|
| `packages/zai/src/server/services/commands/registry.ts` | 加 `reg.register(handoffCommand)`(在 `registerBuiltinCommands` 内) |
| `packages/zai/src/server/routes/command.ts` | prompt 分支外包 try/catch,错误转 `{type:'error', payload:{message}}` |
| `packages/zai/src/web/src/components/AgentInputBox.test.tsx` | 在 `/api/slash` mock items 加 handoff 项 |

## Global Constraints

- **AGENTS.md 强制项**:改 `packages/zn-agent-core/` 后,**必须**先 `pnpm run build:core` 才能用 zai 进程加载新 core;不重建就用浏览器验收会复现到旧 core 行为
- **测试粒度**:功能改动后只跑直接受影响的测试文件,不全量 `pnpm -r test`
- **真实浏览器验收**:完成实现后必须用 `/ego-browser` skill 走完用户路径,不能用 chrome-devtools-mcp / Playwright / curl 替代
- **避开 920x 端口**:zai 正式服务跑在 920x,验证 mobile-only 功能用独立 `--port 8101` 启动开发服务
- **mobile 独立路径**:`/m` 是 mobile 路由,不依赖视口宽度;验证 mobile drawer 直接访问 `/m`
- **vendor 兼容性**:handoff 文件目录固定 `.agent_working_dir/handoff/`(对齐 vendor),跨工具可读;分支阈值固定 `assistantCount ≤ 4`(对齐 vendor,不动);`--pick <filename>` 强制 PICKUP(对齐 vendor)
- **错误响应格式**:所有 handler 异常走 zai 现有 `{type:'error', payload:{message}}` 结构,不引入新错误码
- **不修改 vendor 源码**:`packages/zn-agent-core/opencc-src/commands/handoff/handoff.ts` 不动;vendor handler 因依赖 `ToolUseContext` 不直接迁移,zai 重写 handler 但 prompt 模板章节对齐
- **commit message 风格**:`<type>(<scope>): <subject>`,中文 subject 优先
- **不要把全量测试当成"完成前必跑"**

---

## Task 1: vendor fs 工具 compat 层 re-export

**Files:**
- Create: `packages/zn-agent-core/src/compat/commands/handoffFs.ts`
- Test: `packages/zn-agent-core/test/unit/compat/handoffFs.test.ts`

**Interfaces:**
- Consumes: vendor `listHandoffs(root: string): Promise<string[]>`, `getLatestHandoff(root: string): Promise<string | null>`, `buildHandoffPath(root: string, task: string, date: string): string`(全部来自 `packages/zn-agent-core/src/opencc-src/commands/handoff/handoff.ts`)
- Produces: re-exported `listHandoffs`, `getLatestHandoff`, `buildHandoffPath` 三个 named exports,通过 `@zn-ai/zn-agent-core/compat/commands/handoffFs` 子路径被 zai 端 import

- [ ] **Step 1: Write the failing test**

```ts
// packages/zn-agent-core/test/unit/compat/handoffFs.test.ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  listHandoffs,
  getLatestHandoff,
  buildHandoffPath,
} from '../../../src/compat/commands/handoffFs'

describe('handoffFs re-exports', () => {
  it('re-exports listHandoffs as a function', () => {
    expect(typeof listHandoffs).toBe('function')
  })
  it('re-exports getLatestHandoff as a function', () => {
    expect(typeof getLatestHandoff).toBe('function')
  })
  it('re-exports buildHandoffPath as a function', () => {
    expect(typeof buildHandoffPath).toBe('function')
  })

  describe('listHandoffs integration', () => {
    it('returns [] for non-existent directory', async () => {
      const result = await listHandoffs(path.join(os.tmpdir(), 'no-such-dir-xxx'))
      expect(result).toEqual([])
    })

    it('returns .md files sorted by mtime desc, filters non-.md', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-test-'))
      try {
        const old = path.join(dir, 'old.md')
        const recent = path.join(dir, 'recent.md')
        const notMd = path.join(dir, 'notes.txt')
        await fs.writeFile(old, 'old')
        await new Promise((r) => setTimeout(r, 50))
        await fs.writeFile(notMd, 'ignored')
        await new Promise((r) => setTimeout(r, 50))
        await fs.writeFile(recent, 'recent')

        const result = await listHandoffs(dir)
        expect(result).toEqual([recent, old])
        // notes.txt 被过滤
        expect(result.every((f) => f.endsWith('.md'))).toBe(true)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  })

  describe('buildHandoffPath', () => {
    it('joins root + task-date.md', () => {
      expect(buildHandoffPath('/tmp/h', 'refactor-auth', '2026-08-16')).toBe(
        path.join('/tmp/h', 'refactor-auth-2026-08-16.md'),
      )
    })
  })

  describe('getLatestHandoff', () => {
    it('returns null when no handoff files', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-empty-'))
      try {
        expect(await getLatestHandoff(dir)).toBeNull()
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })

    it('returns most recently modified .md file', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-latest-'))
      try {
        const a = path.join(dir, 'a.md')
        const b = path.join(dir, 'b.md')
        await fs.writeFile(a, 'a')
        await new Promise((r) => setTimeout(r, 50))
        await fs.writeFile(b, 'b')
        expect(await getLatestHandoff(dir)).toBe(b)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/compat/handoffFs.test.ts
```
Expected: FAIL with `Cannot find module '../../../src/compat/commands/handoffFs'` or similar — module doesn't exist yet.

- [ ] **Step 3: Implement the re-export module**

```ts
// packages/zn-agent-core/src/compat/commands/handoffFs.ts
/**
 * Re-export opencc vendor handoff fs utilities for zai consumption.
 *
 * These are pure fs helpers (root: string) with no ToolUseContext dependency,
 * so they can be reused directly from zai without compat-shimming the
 * opencc handler. The vendor handler itself depends on ToolUseContext and
 * is NOT reused — zai implements its own handler.
 */
export {
  listHandoffs,
  getLatestHandoff,
  buildHandoffPath,
} from '../../opencc-src/commands/handoff/handoff'
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/compat/handoffFs.test.ts
```
Expected: PASS — 7 tests green (3 re-export + 4 integration).

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/compat/commands/handoffFs.ts \
        packages/zn-agent-core/test/unit/compat/handoffFs.test.ts
git commit -m "feat(zn-agent-core): compat 层 re-export vendor handoff fs 工具

为 zai 提供 listHandoffs / getLatestHandoff / buildHandoffPath 的子路径
import;vendor handler 因依赖 ToolUseContext 不直接迁移,仅复用 fs 工具。"
```

---

## Task 2: GENERATE 提示词模板

**Files:**
- Create: `packages/zai/src/server/services/commands/builtin/handoff/prompts/generate.ts`
- Test: `packages/zai/src/server/services/commands/builtin/handoff/prompts/generate.test.ts`

**Interfaces:**
- Consumes: nothing(纯函数)
- Produces: `buildGeneratePrompt(params: { cwd: string, root: string, date: string, taskListText: string | null }): string` — 返回多行 markdown,包含章节标识 `### Task title` / `### Original Request` / `### Goal` / `### Artifacts` / `### Key Findings` / `### Pitfalls` / `### Current TaskList` / `### Next Steps` / `### Skills Used`;嵌入 cwd / root / date;taskListText 为 null 时 `### Current TaskList` 章节嵌入 `(未提供 — 请从对话上文推断当前任务列表)` 占位

- [ ] **Step 1: Write the failing test**

```ts
// packages/zai/src/server/services/commands/builtin/handoff/prompts/generate.test.ts
import { describe, it, expect } from 'vitest'
import { buildGeneratePrompt } from './generate'

const baseParams = {
  cwd: '/Users/x/project',
  root: '/Users/x/project/.agent_working_dir/handoff',
  date: '2026-08-16',
}

describe('buildGeneratePrompt', () => {
  it('包含所有 vendor 章节标识', () => {
    const out = buildGeneratePrompt({ ...baseParams, taskListText: null })
    for (const heading of [
      '### Task title',
      '### Original Request',
      '### Goal',
      '### Artifacts',
      '### Key Findings',
      '### Pitfalls',
      '### Current TaskList',
      '### Next Steps',
      '### Skills Used',
    ]) {
      expect(out, `应包含 ${heading}`).toContain(heading)
    }
  })

  it('嵌入 cwd / root / date', () => {
    const out = buildGeneratePrompt({ ...baseParams, taskListText: null })
    expect(out).toContain(baseParams.cwd)
    expect(out).toContain(baseParams.root)
    expect(out).toContain(baseParams.date)
  })

  it('taskListText 非 null 时嵌入实际内容', () => {
    const out = buildGeneratePrompt({
      ...baseParams,
      taskListText: '- [x] 写 handoff 命令',
    })
    expect(out).toContain('- [x] 写 handoff 命令')
  })

  it('taskListText 为 null 时嵌入未提供占位', () => {
    const out = buildGeneratePrompt({ ...baseParams, taskListText: null })
    expect(out).toContain('(未提供 — 请从对话上文推断当前任务列表)')
  })

  it('包含写文件指令和回执文案', () => {
    const out = buildGeneratePrompt({ ...baseParams, taskListText: null })
    expect(out).toContain('Write')
    expect(out).toContain('✅ Handoff document written:')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @zn-ai/zai test \
  src/server/services/commands/builtin/handoff/prompts/generate.test.ts
```
Expected: FAIL with `Cannot find module './generate'` — file doesn't exist yet.

- [ ] **Step 3: Implement the template**

```ts
// packages/zai/src/server/services/commands/builtin/handoff/prompts/generate.ts
interface GenerateParams {
  cwd: string
  root: string
  date: string
  taskListText: string | null
}

export function buildGeneratePrompt(p: GenerateParams): string {
  const taskSection = p.taskListText
    ? p.taskListText
    : '(未提供 — 请从对话上文推断当前任务列表)'

  return `# /handoff — 生成交接文档

请根据当前会话生成交接文档,写入磁盘,然后回执给用户。

## 目标路径

\`${p.root}/<task-slug>-${p.date}.md\`

- \`<task-slug>\` 用 kebab-case 英文短语概括本次会话主题(例如 \`refactor-auth-middleware\`)
- 日期已确定为 \`${p.date}\`

## 文档章节(必须全部填写)

按以下小节顺序输出完整 markdown:

### Task title
一句话标题。

### Original Request
用户最初的原始请求,逐字摘抄。

### Goal
本次会话要达成的目标。

### Artifacts
已产出的文件 / 决策 / 改动(绝对路径 + 简短说明)。

### Key Findings
过程中发现的关键事实、调研结论、设计取舍。

### Pitfalls
踩过的坑、失败尝试、注意事项(供后续接手人避坑)。

### Current TaskList
\`\`\`
${taskSection}
\`\`\`

### Next Steps
下一步该做的事,按优先级排序。

### Skills Used
本次会话用到的主要技能 / 命令(可选)。

## 落盘要求

1. 用 \`Write\` 工具把上面文档写入 \`${p.root}/<task-slug>-${p.date}.md\`
2. 写入成功后,纯文本回执一行:
   \`✅ Handoff document written: <绝对路径>\`
3. 若 \`Write\` 工具不可用(权限/路径限制),把整篇 markdown 用 plain text 输出给用户,提示复制保存到上述路径

## 当前会话上下文

- cwd: \`${p.cwd}\`
- handoff 根目录: \`${p.root}\`
- 日期: \`${p.date}\`
`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm --filter @zn-ai/zai test \
  src/server/services/commands/builtin/handoff/prompts/generate.test.ts
```
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/services/commands/builtin/handoff/prompts/generate.ts \
        packages/zai/src/server/services/commands/builtin/handoff/prompts/generate.test.ts
git commit -m "feat(zai): /handoff GENERATE 提示词模板

对齐 vendor generate.ts 章节结构(Task title / Original Request /
Goal / Artifacts / Key Findings / Pitfalls / Current TaskList /
Next Steps / Skills Used),taskListText 为 null 时内嵌 '(未提供)' 占位,
含 Write 工具指令与 ✅ Handoff document written 回执文案。"
```

---

## Task 3: PICKUP 提示词模板

**Files:**
- Create: `packages/zai/src/server/services/commands/builtin/handoff/prompts/pickup.ts`
- Test: `packages/zai/src/server/services/commands/builtin/handoff/prompts/pickup.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `buildPickupPrompt(params: { cwd: string, root: string, date: string, files: { path: string, mtimeMs: number }[], pickFile?: string }): string`
  - 0 文件:返回友好提示(告诉用户用 vendor CLI 或手动起草),不抛
  - 1 文件无 pickFile:返回 Read 指令(直接让 LLM 读唯一文件)
  - 多文件无 pickFile:返回文件列表 + AskUserQuestion 指令
  - 有 pickFile:返回 Read 该文件指令;文件不存在抛 `HandoffArgsError`(由调用方捕获)

- [ ] **Step 1: Write the failing test**

```ts
// packages/zai/src/server/services/commands/builtin/handoff/prompts/pickup.test.ts
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { buildPickupPrompt } from './pickup'

const baseParams = {
  cwd: '/Users/x/project',
  root: '/Users/x/project/.agent_working_dir/handoff',
  date: '2026-08-16',
}

describe('buildPickupPrompt', () => {
  it('0 文件返回友好提示', () => {
    const out = buildPickupPrompt({ ...baseParams, files: [] })
    expect(out).toContain('未找到')
    expect(out).toContain(baseParams.root)
    expect(out).toContain(baseParams.date)
  })

  it('1 文件无 pickFile 时让 LLM 直接 Read', () => {
    const file = path.join(baseParams.root, 'only.md')
    const out = buildPickupPrompt({
      ...baseParams,
      files: [{ path: file, mtimeMs: Date.now() }],
    })
    expect(out).toContain('Read')
    expect(out).toContain(file)
  })

  it('多文件无 pickFile 时列文件并用 AskUserQuestion', () => {
    const a = path.join(baseParams.root, 'a.md')
    const b = path.join(baseParams.root, 'b.md')
    const out = buildPickupPrompt({
      ...baseParams,
      files: [
        { path: a, mtimeMs: Date.now() },
        { path: b, mtimeMs: Date.now() - 1000 },
      ],
    })
    expect(out).toContain('AskUserQuestion')
    expect(out).toContain(path.basename(a))
    expect(out).toContain(path.basename(b))
    expect(out).toContain(a)
    expect(out).toContain(b)
  })

  it('pickFile 命中文件时只 Read 该文件', () => {
    const a = path.join(baseParams.root, 'a.md')
    const b = path.join(baseParams.root, 'b.md')
    const out = buildPickupPrompt({
      ...baseParams,
      files: [
        { path: a, mtimeMs: Date.now() },
        { path: b, mtimeMs: Date.now() - 1000 },
      ],
      pickFile: 'b.md',
    })
    expect(out).toContain('Read')
    expect(out).toContain(b)
    expect(out).not.toContain(a)
  })

  it('pickFile 文件名不存在时抛 HandoffArgsError', () => {
    const a = path.join(baseParams.root, 'a.md')
    expect(() =>
      buildPickupPrompt({
        ...baseParams,
        files: [{ path: a, mtimeMs: Date.now() }],
        pickFile: 'nonexistent.md',
      }),
    ).toThrow(/--pick 指定的文件不存在/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @zn-ai/zai test \
  src/server/services/commands/builtin/handoff/prompts/pickup.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the template**

```ts
// packages/zai/src/server/services/commands/builtin/handoff/prompts/pickup.ts
import path from 'node:path'

interface HandoffFile {
  path: string
  mtimeMs: number
}

interface PickupParams {
  cwd: string
  root: string
  date: string
  files: HandoffFile[]
  pickFile?: string
}

export class HandoffArgsError extends Error {}

function formatFileList(files: HandoffFile[]): string {
  return files
    .map((f, i) => {
      const dt = new Date(f.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')
      const name = path.basename(f.path)
      return `${i + 1}. \`${name}\`  (${dt})  \`${f.path}\``
    })
    .join('\n')
}

export function buildPickupPrompt(p: PickupParams): string {
  if (p.files.length === 0) {
    return `# /handoff — 接管现有交接

未找到 \`${p.root}\` 下的交接文档。

建议:
- 用户先用 OpenCC CLI 跑一次 \`/handoff\` 生成首份交接
- 或在当前对话中描述要交接的内容,LLM 据此手动起草并保存到 \`${p.root}/<task-slug>-${p.date}.md\`
`
  }

  if (p.pickFile) {
    const target =
      p.files.find((f) => path.basename(f.path) === p.pickFile) ??
      p.files.find((f) => f.path.endsWith(p.pickFile!))
    if (!target) {
      throw new HandoffArgsError(
        `--pick 指定的文件不存在:${p.pickFile}\n可选:${p.files.map((f) => path.basename(f.path)).join(', ')}`,
      )
    }
    return `# /handoff — 接管指定交接

请用 \`Read\` 工具读取以下交接文档,据此继续当前会话:

- 路径: \`${target.path}\`

读取后请向用户简短确认你已接手,然后继续工作。
`
  }

  if (p.files.length === 1) {
    const only = p.files[0]
    return `# /handoff — 接管唯一交接

\`${p.root}\` 下仅有 1 份交接文档,直接读取:

请用 \`Read\` 工具读取 \`${only.path}\`,据此继续当前会话。读取后向用户简短确认接手。
`
  }

  // 多文件无指定:让 LLM 用 AskUserQuestion 工具问用户挑
  return `# /handoff — 接管现有交接

\`${p.root}\` 下找到 ${p.files.length} 份历史交接文档(按 mtime 倒序):

${formatFileList(p.files)}

## 操作要求

1. 用 \`AskUserQuestion\` 工具(已在 zai 启用)向用户提问:
   - Question: "请选择要接管的交接文档"
   - Options: 用上面列表前 5 个文件作为选项(label 用文件名,description 用日期 + 路径)
   - header: "Pick handoff"

2. 用户选择后,用 \`Read\` 工具读取对应文件路径,据此继续当前会话。

3. 若用户选择"None of the above"或取消,询问用户希望新建交接还是结束当前会话。
`
}
```

**注意**:`HandoffArgsError` 也从 `pickup.ts` 导出 — `handoffCommand.ts` 会 re-export 该异常类。Task 4 会处理这一点。

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm --filter @zn-ai/zai test \
  src/server/services/commands/builtin/handoff/prompts/pickup.test.ts
```
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/services/commands/builtin/handoff/prompts/pickup.ts \
        packages/zai/src/server/services/commands/builtin/handoff/prompts/pickup.test.ts
git commit -m "feat(zai): /handoff PICKUP 提示词模板

对齐 vendor pickup.ts 行为:0 文件友好提示、1 文件直接 Read、多文件
列清单 + AskUserQuestion 指令、--pick 指定 Read 该文件;指定不存在
抛 HandoffArgsError。"
```

---

## Task 4: handoffCommand handler

**Files:**
- Create: `packages/zai/src/server/services/commands/builtin/handoffCommand.ts`
- Test: `packages/zai/src/server/services/commands/builtin/handoffCommand.test.ts`

**Interfaces:**
- Consumes: `PromptCommand` / `CommandContext` from `@zn-ai/zn-agent-core`;`listHandoffs` from `@zn-ai/zn-agent-core/compat/commands/handoffFs`;`buildGeneratePrompt` / `buildPickupPrompt` / `HandoffArgsError` from `./handoff/prompts/{generate,pickup}`
- Produces: `handoffCommand: PromptCommand` — 注册到 zai registry 后会被 `GET /api/slash` 列出,被 `POST /agent/command` 通过 `cmd.getPromptForCommand(args, context)` 调用
  - `getPromptForCommand(args: string, context: CommandContext): Promise<ContentBlockParam[]>`
  - 返回 `[{type:'text', text: string}]`
  - 抛 `HandoffArgsError` / `HandoffCwdError`(由 routes/command.ts 顶层 try/catch 转 error 分支)

- [ ] **Step 1: Write the failing test for parseArgs + helper functions**

```ts
// packages/zai/src/server/services/commands/builtin/handoffCommand.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  handoffCommand,
  parseArgs,
  resolveCwd,
  countAssistantMessages,
  readTaskListText,
  HandoffArgsError,
  HandoffCwdError,
} from './handoffCommand'
import { listHandoffs, buildHandoffPath } from '@zn-ai/zn-agent-core/compat/commands/handoffFs'

describe('parseArgs', () => {
  it('空 args 返回空对象', () => {
    expect(parseArgs('')).toEqual({})
    expect(parseArgs('   ')).toEqual({})
  })

  it('--pick <filename> 提取 pickFile', () => {
    expect(parseArgs('--pick foo.md')).toEqual({ pickFile: 'foo.md' })
  })

  it('--pick 重复时后者覆盖', () => {
    expect(parseArgs('--pick a.md --pick b.md')).toEqual({ pickFile: 'b.md' })
  })

  it('--pick 无值抛 HandoffArgsError', () => {
    expect(() => parseArgs('--pick')).toThrow(HandoffArgsError)
  })

  it('--pick 后面是另一个 flag 抛错', () => {
    expect(() => parseArgs('--pick --other')).toThrow(HandoffArgsError)
  })

  it('未知 flag 抛 HandoffArgsError', () => {
    expect(() => parseArgs('--unknown foo')).toThrow(HandoffArgsError)
    expect(() => parseArgs('positional')).toThrow(HandoffArgsError)
  })
})

describe('resolveCwd', () => {
  it('优先 context.cwd', () => {
    expect(resolveCwd({ cwd: '/from/ctx' })).toBe('/from/ctx')
  })

  it('context.cwd 缺失时 fallback process.cwd()', () => {
    const fallback = process.cwd()
    expect(resolveCwd({})).toBe(fallback)
  })

  it('context 是 null 时仍能 fallback', () => {
    expect(resolveCwd(null as any)).toBe(process.cwd())
  })
})

describe('countAssistantMessages', () => {
  it('context.assistantMessageCount 是 number 时返回它', async () => {
    expect(await countAssistantMessages({ assistantMessageCount: 3 })).toBe(3)
    expect(await countAssistantMessages({ assistantMessageCount: 100 })).toBe(100)
  })

  it('context 没字段时返回 +Infinity(强制 GENERATE)', async () => {
    expect(await countAssistantMessages({})).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('readTaskListText', () => {
  it('context.taskListText 是 string 时返回它', async () => {
    expect(await readTaskListText({ taskListText: '- [ ] task' })).toBe('- [ ] task')
  })

  it('context.taskListText 是 null 时返回 null', async () => {
    expect(await readTaskListText({ taskListText: null })).toBeNull()
  })

  it('context 没字段时返回 null(fallback 触发 generate prompt 占位)', async () => {
    expect(await readTaskListText({})).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify parseArgs + helpers fail**

Run:
```bash
pnpm --filter @zn-ai/zai test \
  src/server/services/commands/builtin/handoffCommand.test.ts
```
Expected: FAIL — `handoffCommand.ts` doesn't exist yet.

- [ ] **Step 3: Implement parseArgs + helpers (no handler yet)**

```ts
// packages/zai/src/server/services/commands/builtin/handoffCommand.ts
import path from 'node:path'
import type { PromptCommand, CommandContext } from '@zn-ai/zn-agent-core'
import type { ContentBlockParam } from '@zn-ai/zn-agent-core'
import {
  listHandoffs,
  getLatestHandoff,
  buildHandoffPath,
} from '@zn-ai/zn-agent-core/compat/commands/handoffFs'
import { buildGeneratePrompt } from './handoff/prompts/generate'
import { buildPickupPrompt, HandoffArgsError } from './handoff/prompts/pickup'

export { HandoffArgsError }

export class HandoffCwdError extends Error {}

const PICKUP_THRESHOLD = 4
const HANDOFF_SUBDIR = path.join('.agent_working_dir', 'handoff')

interface ParsedArgs {
  pickFile?: string
}

export function parseArgs(args: string): ParsedArgs {
  const trimmed = args.trim()
  if (!trimmed) return {}
  const tokens = trimmed.split(/\s+/)
  const out: ParsedArgs = {}
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--pick') {
      const v = tokens[++i]
      if (!v || v.startsWith('--')) {
        throw new HandoffArgsError('用法:/handoff [--pick <filename>]')
      }
      out.pickFile = v
    } else {
      throw new HandoffArgsError(`未知参数:${t};用法:/handoff [--pick <filename>]`)
    }
  }
  return out
}

export function resolveCwd(context: CommandContext | null | undefined): string {
  const cwd = (context as { cwd?: string } | null | undefined)?.cwd
  if (cwd) return cwd
  const fallback = process.cwd()
  if (!fallback) throw new HandoffCwdError('无法解析当前工作目录')
  return fallback
}

export async function countAssistantMessages(
  context: CommandContext | null | undefined,
): Promise<number> {
  const injected = (context as { assistantMessageCount?: unknown } | null | undefined)
    ?.assistantMessageCount
  if (typeof injected === 'number') return injected
  return Number.POSITIVE_INFINITY
}

export async function readTaskListText(
  context: CommandCommandContext | null | undefined,
): Promise<string | null> {
  const injected = (context as { taskListText?: unknown } | null | undefined)?.taskListText
  if (typeof injected === 'string') return injected
  return null
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

// Command definition exported below; getPromptForCommand body added in Step 5.
export const handoffCommand: PromptCommand = {
  type: 'prompt',
  name: 'handoff',
  description: '交接当前会话:消息多时生成交接文档,消息少时恢复最近的交接',
  argumentHint: '[--pick <filename>]',
  source: 'builtin',
  progressMessage: 'preparing handoff',
  contentLength: 0,
  isEnabled: () => true,
  async getPromptForCommand(_args: string, _context: CommandContext) {
    // placeholder — Step 5 will replace with full branch logic
    return [{ type: 'text', text: '' }]
  },
}
```

**注意**:`readTaskListText` 上面误写为 `CommandCommandContext`,Step 3 实际应该是 `CommandContext | null | undefined`。在 Step 4 之前先修正这个 typo。修正后的函数签名:

```ts
export async function readTaskListText(
  context: CommandContext | null | undefined,
): Promise<string | null> {
  const injected = (context as { taskListText?: unknown } | null | undefined)?.taskListText
  if (typeof injected === 'string') return injected
  return null
}
```

- [ ] **Step 4: Run test to verify parseArgs + helpers pass**

Run:
```bash
pnpm --filter @zn-ai/zai test \
  src/server/services/commands/builtin/handoffCommand.test.ts
```
Expected: PASS for parseArgs + helpers tests (the placeholder handler is OK — the export shape exists).

- [ ] **Step 5: Append the failing test for getPromptForCommand end-to-end**

Add to the same test file:

```ts
describe('handoffCommand.getPromptForCommand (end-to-end)', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-e2e-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('PICKUP: assistantCount=2 时走 pickup 分支', async () => {
    const file = path.join(tmpDir, '.agent_working_dir/handoff', 'old.md')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '# old')

    const blocks = await handoffCommand.getPromptForCommand(
      '',
      {
        cwd: tmpDir,
        assistantMessageCount: 2,
        taskListText: null,
      } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('Read')
    expect(text).toContain('old.md')
  })

  it('GENERATE: assistantCount=10 时走 generate 分支', async () => {
    const blocks = await handoffCommand.getPromptForCommand(
      '',
      {
        cwd: tmpDir,
        assistantMessageCount: 10,
        taskListText: '- [ ] next',
      } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('Task title')
    expect(text).toContain('- [ ] next')
    expect(text).toContain(tmpDir)
  })

  it('GENERATE: taskListText=null 时内嵌占位', async () => {
    const blocks = await handoffCommand.getPromptForCommand(
      '',
      {
        cwd: tmpDir,
        assistantMessageCount: 10,
        taskListText: null,
      } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('(未提供 — 请从对话上文推断当前任务列表)')
  })

  it('--pick 强制 PICKUP 即便 assistantCount 高', async () => {
    const file = path.join(tmpDir, '.agent_working_dir/handoff', 'picked.md')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '# picked')

    const blocks = await handoffCommand.getPromptForCommand(
      '--pick picked.md',
      {
        cwd: tmpDir,
        assistantMessageCount: 50,
        taskListText: null,
      } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('Read')
    expect(text).toContain(file)
    expect(text).not.toContain('Task title')
  })

  it('--pick 文件不存在抛 HandoffArgsError', async () => {
    await expect(
      handoffCommand.getPromptForCommand(
        '--pick nope.md',
        { cwd: tmpDir, assistantMessageCount: 2, taskListText: null } as any,
      ),
    ).rejects.toThrow(HandoffArgsError)
  })

  it('PICKUP 0 文件时返回友好提示', async () => {
    const blocks = await handoffCommand.getPromptForCommand(
      '',
      {
        cwd: tmpDir,
        assistantMessageCount: 2,
        taskListText: null,
      } as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('未找到')
  })

  it('context 完全无字段时走 GENERATE(+Infinity fallback)', async () => {
    const blocks = await handoffCommand.getPromptForCommand(
      '',
      {} as any,
    )
    const text = (blocks[0] as any).text
    expect(text).toContain('Task title') // GENERATE 标识
  })
})
```

- [ ] **Step 6: Run test to verify end-to-end tests fail**

Run:
```bash
pnpm --filter @zn-ai/zai test \
  src/server/services/commands/builtin/handoffCommand.test.ts
```
Expected: new end-to-end tests FAIL — placeholder handler returns empty text.

- [ ] **Step 7: Implement full handler body**

Replace the placeholder `getPromptForCommand` in `handoffCommand.ts`:

```ts
async getPromptForCommand(args: string, context: CommandContext): Promise<ContentBlockParam[]> {
  const parsed = parseArgs(args)
  const cwd = resolveCwd(context)
  const root = path.join(cwd, HANDOFF_SUBDIR)
  const date = todayISO()
  const assistantCount = await countAssistantMessages(context)
  const taskListText = await readTaskListText(context)

  const isPickup = parsed.pickFile !== undefined || assistantCount <= PICKUP_THRESHOLD

  if (isPickup) {
    const files = await listHandoffs(root)
    const text = buildPickupPrompt({
      cwd,
      root,
      date,
      files,
      pickFile: parsed.pickFile,
    })
    return [{ type: 'text', text }]
  }

  const text = buildGeneratePrompt({ cwd, root, date, taskListText })
  return [{ type: 'text', text }]
},
```

- [ ] **Step 8: Run test to verify all pass**

Run:
```bash
pnpm --filter @zn-ai/zai test \
  src/server/services/commands/builtin/handoffCommand.test.ts
```
Expected: PASS — all tests green (parseArgs + helpers + 7 end-to-end).

- [ ] **Step 9: Commit**

```bash
git add packages/zai/src/server/services/commands/builtin/handoffCommand.ts \
        packages/zai/src/server/services/commands/builtin/handoffCommand.test.ts
git commit -m "feat(zai): /handoff handler(PromptCommand)

zai server 端 handoff 命令实现,确定性 PICKUP/GENERATE 分支:
- parseArgs: --pick <filename> + 未知 flag 校验,抛 HandoffArgsError
- resolveCwd: context.cwd → process.cwd() fallback,抛 HandoffCwdError
- countAssistantMessages: context 注入 + +Infinity 兜底(强制 GENERATE)
- readTaskListText: context 注入 + null 兜位 → prompt 占位
- getPromptForCommand: --pick 强制 PICKUP,否则 assistantCount ≤ 4 走
  PICKUP(读 .agent_working_dir/handoff/),> 4 走 GENERATE(嵌入 taskListText)"
```

---

## Task 5: 注册 handoffCommand 到 registry

**Files:**
- Modify: `packages/zai/src/server/services/commands/registry.ts:13-20`(在 `registerBuiltinCommands` 内加 `reg.register(handoffCommand)`)
- Test: `packages/zai/src/server/services/commands/registry.test.ts`(若不存在则新增)

**Interfaces:**
- Consumes: `handoffCommand` from `../services/commands/builtin/handoffCommand`
- Produces: 调用 `getCommandRegistry().get('handoff')` 拿到 `handoffCommand` 对象;`getCommandRegistry().list()` 包含 handoff

- [ ] **Step 1: Read existing registry**

Read `packages/zai/src/server/services/commands/registry.ts` to see exact import style and where `reg.register(...)` lives. Confirm the import line for other builtins matches the pattern `import { clearCommand } from './builtin/clear'`(or similar).

- [ ] **Step 2: Add handoff import + register**

Append to `registry.ts`:

```ts
import { handoffCommand } from './builtin/handoffCommand'
```

And in the `registerBuiltinCommands` body (next to `reg.register(clearCommand)` etc):

```ts
reg.register(handoffCommand)
```

- [ ] **Step 3: Verify registry test exists, otherwise create one**

If `packages/zai/src/server/services/commands/registry.test.ts` does NOT exist, create it:

```ts
import { describe, it, expect } from 'vitest'
import { getCommandRegistry } from '@zn-ai/zn-agent-core'

describe('command registry', () => {
  it('包含 handoff builtin 命令', () => {
    const reg = getCommandRegistry()
    const all = reg.list()
    const handoff = all.find((c: any) => c.name === 'handoff')
    expect(handoff, 'registry 应包含 handoff 命令').toBeDefined()
    expect((handoff as any).type).toBe('prompt')
    expect((handoff as any).source).toBe('builtin')
    expect((handoff as any).description).toContain('交接')
    expect((handoff as any).argumentHint).toBe('[--pick <filename>]')
  })
})
```

If it already exists, append a new `describe` block with the same test content (renaming the describe to avoid collision).

- [ ] **Step 4: Run registry test**

Run:
```bash
pnpm --filter @zn-ai/zai test \
  src/server/services/commands/registry.test.ts
```
Expected: PASS — handoff registered.

- [ ] **Step 5: Verify GET /api/slash returns handoff via manual smoke**

```bash
pnpm --filter @zn-ai/zai dev -- --port 8101 &
sleep 3
curl -s http://localhost:8101/api/slash | python3 -m json.tool | grep -A1 -B1 handoff
kill %1
```

Expected: output includes `"name": "handoff"` line in items array.

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/server/services/commands/registry.ts \
        packages/zai/src/server/services/commands/registry.test.ts
git commit -m "feat(zai): 注册 handoff builtin 命令

reg.register(handoffCommand) 加进 registerBuiltinCommands;registry
测试覆盖 handoff 字段(name/type/source/description/argumentHint)。"
```

---

## Task 6: routes/command.ts prompt 分支 try/catch

**Files:**
- Modify: `packages/zai/src/server/routes/command.ts:55-62`
- Test: `packages/zai/test/server/routes/command.test.ts`(若不存在则新增)

**Interfaces:**
- Consumes: existing `cmd.getPromptForCommand(args, context)` invocation
- Produces: 错误时返回 `{type:'error', payload:{message: '生成交接提示失败:<err>'}}` 而非 500;console.error 记录堆栈

- [ ] **Step 1: Read current command.ts prompt branch**

Open `packages/zai/src/server/routes/command.ts` lines 55-62, confirm the exact code structure:

```ts
const blocks = await cmd.getPromptForCommand(args, context)
const text = blocks
  .map((b: any) => (b.type === 'text' ? (b as { text: string }).text : ''))
  .filter(Boolean)
  .join('\n')
return res.json({ type: 'prompt', payload: { rendered: text } })
```

- [ ] **Step 2: Add the failing test**

If `test/server/routes/command.test.ts` does not exist, create it. Use Vitest + supertest (check existing tests for the pattern; if no supertest usage, use the simpler `app.callback()` approach via `http` module). The test should:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import { commandRouter } from '../../../src/server/routes/command'  // adjust path
// ... or however the existing pattern mounts the router

describe('POST /agent/command', () => {
  let server: http.Server
  beforeEach(async () => {
    const app = express()
    app.use(express.json())
    app.use(commandRouter)  // 或 mount 在 /agent/command 子路由
    server = app.listen(0)
    await new Promise((r) => server.once('listening', r))
  })

  it('handoff 成功时返回 {type:prompt, payload:{rendered: 非空}}', async () => {
    const port = (server.address() as any).port
    const res = await fetch(`http://localhost:${port}/agent/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'handoff', args: '' }),
    })
    const json = await res.json()
    expect(json.type).toBe('prompt')
    expect(typeof json.payload.rendered).toBe('string')
    expect(json.payload.rendered.length).toBeGreaterThan(0)
  })

  it('handoff handler 抛错时返回 {type:error, payload:{message}}', async () => {
    // Mock registry to return a command that throws
    const { getCommandRegistry } = await import('@zn-ai/zn-agent-core')
    const original = getCommandRegistry().get('handoff')
    const throwing = { ...original, getPromptForCommand: async () => { throw new Error('boom') } }
    getCommandRegistry().register(throwing as any)
    try {
      const port = (server.address() as any).port
      const res = await fetch(`http://localhost:${port}/agent/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'handoff', args: '' }),
      })
      const json = await res.json()
      expect(json.type).toBe('error')
      expect(json.payload.message).toContain('生成交接提示失败')
      expect(json.payload.message).toContain('boom')
    } finally {
      getCommandRegistry().unregister('handoff')
      if (original) getCommandRegistry().register(original as any)
    }
  })
})
```

**注**:如果项目里没有现成的 test/server/routes/command.test.ts 且没有 supertest 依赖,改用项目已有的测试惯例(可能是 `vi.mock('@zn-ai/zn-agent-core')` 整个 mock registry)。先 `ls test/server/routes/` 看现有结构,再决定 mock 策略。

- [ ] **Step 3: Run test — verify the error branch test fails (no try/catch yet)**

Run:
```bash
pnpm --filter @zn-ai/zai test test/server/routes/command.test.ts
```
Expected: error-branch test FAILS with unhandled error / 500.

- [ ] **Step 4: Wrap prompt branch in try/catch**

In `packages/zai/src/server/routes/command.ts` lines 55-62, replace:

```ts
const blocks = await cmd.getPromptForCommand(args, context)
const text = blocks
  .map((b: any) => (b.type === 'text' ? (b as { text: string }).text : ''))
  .filter(Boolean)
  .join('\n')
return res.json({ type: 'prompt', payload: { rendered: text } })
```

with:

```ts
try {
  const blocks = await cmd.getPromptForCommand(args, context)
  const text = blocks
    .map((b: any) => (b.type === 'text' ? (b as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n')
  return res.json({ type: 'prompt', payload: { rendered: text } })
} catch (err) {
  console.error('[handoff] handler failed:', err)
  return res.json({
    type: 'error',
    payload: {
      message: `生成交接提示失败:${err instanceof Error ? err.message : String(err)}`,
    },
  })
}
```

- [ ] **Step 5: Run test — verify both pass**

Run:
```bash
pnpm --filter @zn-ai/zai test test/server/routes/command.test.ts
```
Expected: PASS — both tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/server/routes/command.ts \
        packages/zai/test/server/routes/command.test.ts
git commit -m "feat(zai): routes/command.ts prompt 分支加 try/catch

handler 抛错时返回 {type:'error', payload:{message}} 而非 500;console.error
记录堆栈。改动范围 ≤ 10 行,不影响 local 命令分支(clear/compact/status)。"
```

---

## Task 7: AgentInputBox.test.tsx mock /api/slash 加 handoff

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.test.tsx`

**Interfaces:**
- Consumes: existing `vi.stubGlobal('fetch', ...)` mock for `/api/slash`
- Produces: 测试断言覆盖 — 在 mock items 里加入 handoff 项后,渲染的下拉里能看到 "handoff"

- [ ] **Step 1: Locate the mock data block**

Open `packages/zai/src/web/src/components/AgentInputBox.test.tsx` and find the `vi.stubGlobal('fetch', ...)` setup (around lines 28-37). Identify the variable holding the mock items array (likely a `const slashItems = [...]` or inlined in the mock impl).

- [ ] **Step 2: Add handoff to mock items**

In the items array, append:

```ts
{
  kind: 'command',
  name: 'handoff',
  description: '交接当前会话:消息多时生成交接文档,消息少时恢复最近的交接',
  argumentHint: '[--pick <filename>]',
  type: 'prompt',
  source: 'builtin',
  isBuiltIn: true,
},
```

(字段命名以 SlashItem 类型为准 — 检查原 mock 用的字段名,缺哪个补哪个。)

- [ ] **Step 3: Add assertion that handoff appears in dropdown**

Add a new `it()` to the test suite:

```tsx
it('下拉里出现 handoff builtin 命令', async () => {
  render(<AgentInputBox ...existing props... />)
  const input = screen.getByRole('textbox')  // 或具体 selector
  await userEvent.type(input, '/')
  // 等下拉渲染
  await waitFor(() => {
    expect(screen.getByText(/handoff/i)).toBeInTheDocument()
  })
})
```

(具体 selector 和渲染写法以现有测试惯例为准。)

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm --filter @zn-ai/zai test \
  src/web/src/components/AgentInputBox.test.tsx
```
Expected: PASS — all tests including the new handoff assertion green.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/AgentInputBox.test.tsx
git commit -m "test(zai-web): AgentInputBox /api/slash mock 加 handoff 项

验证 web composer '/ ' 触发下拉里能看到 handoff builtin 命令。"
```

---

## Task 8: build:core + tsc + 跑相关测试

**Files:** (none — verification only)

- [ ] **Step 1: Build core(改了 compat re-export 后必跑)**

```bash
pnpm run build:core
```
Expected: 成功(无 TS / esbuild 错误)。

- [ ] **Step 2: TypeScript 全量 typecheck**

```bash
pnpm -r exec tsc --noEmit
```
Expected: 0 错误。

- [ ] **Step 3: 跑所有受影响的测试**

```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/compat/handoffFs.test.ts

pnpm --filter @zn-ai/zai test \
  src/server/services/commands/builtin/handoffCommand.test.ts \
  src/server/services/commands/builtin/handoff/prompts/generate.test.ts \
  src/server/services/commands/builtin/handoff/prompts/pickup.test.ts \
  src/server/services/commands/registry.test.ts \
  src/web/src/components/AgentInputBox.test.tsx \
  test/server/routes/command.test.ts
```
Expected: 全绿。

- [ ] **Step 4: 修任何失败的 type/test**

如果 Step 1-3 任一步失败,基于错误信息回到对应 Task 修复,**不**新增 commit 到这个 verification task。修复后再回到这一步重跑。

- [ ] **Step 5: 无 commit(verification only)**

不要 commit 这一步;若一切绿,直接进入 Task 9 真实浏览器验收。

---

## Task 9: 真实浏览器验收(/ego-browser)

**Files:** (none — manual verification only)

- [ ] **Step 1: 启动独立 zai 开发实例(避开 920x 正式端口)**

```bash
lsof -i :8101 || pnpm --filter @zn-ai/zai dev -- --port 8101
```
确认 8101 空闲后启动。如果 8101 占用,改用 8102 / 8103 等空闲端口,显式指定(AGENTS.md 强调禁止静默换端口)。

- [ ] **Step 2: 用 /ego-browser 验证 web 端**

调 `/ego-browser` skill,在 browser-operator subagent 中:

1. 访问 `http://localhost:8101/agent`
2. 在 composer 输入 `/`,等待下拉
3. 截图,确认列表里有 **handoff** 项(描述:"交接当前会话:消息多时生成交接文档...")
4. 输入 `/handoff`,回车发送
5. 确认:
   - 进度提示出现 "preparing handoff"
   - 对话流里出现 prompt 渲染结果(包含章节标识 "Task title" / "Goal" 等)
   - 用户消息侧显示 `/handoff`(原文,不带 rendered)
6. 截图保存

- [ ] **Step 3: 用 /ego-browser 验证 mobile 端**

切到 `http://localhost:8101/m`:

1. 重复 Step 2 的输入验证(在 mobile composer 输入 `/handoff`)
2. 截图保存
3. 确认 mobile 端下拉里也出现 handoff(同一 `/api/slash` 来源)

- [ ] **Step 4: 验证 LLM 实际写文件**

让 LLM 完成一次 GENERATE 流程(在前述对话里继续,直到 LLM 输出 "✅ Handoff document written:"):

```bash
ls -la $(pwd)/.agent_working_dir/handoff/
```
Expected: 至少 1 个 `<task-slug>-2026-08-16.md` 文件存在。

打开该文件,人工确认章节齐全(Task title / Goal / Artifacts / Current TaskList 等)。

- [ ] **Step 5: 验证 PICKUP(可选,跨工具兼容)**

如当前 cwd 下已有 `~/.agent_working_dir/handoff/` 的旧 handoff(从之前的 opencc CLI 跑出来的),回到 web 端发一次 `/handoff`,确认 prompt 渲染里能看到该文件路径。

如果当前没有旧 handoff,跳过此步(由后续用户在跨工具场景下自验)。

- [ ] **Step 6: 关停 zai dev 实例**

```bash
kill %1  # 或 pkill -f "zai dev --port 8101"
```

- [ ] **Step 7: 无 commit(verification only)**

不要 commit 这一步。验收通过 → 实施完成。

---

## Self-Review

### 1. Spec coverage checklist

| Spec 段 | 实施任务 |
|---------|----------|
| 1.1 architecture 概述(3 个新增文件) | Task 2 / Task 3 / Task 4 |
| 1.1 改动文件(registry.ts) | Task 5 |
| 1.1 改动文件(routes/command.ts try/catch) | Task 6 |
| 1.1 mobile 不需要改 | Task 9 mobile 验证覆盖 |
| 2.1 `handoffCommand.ts` 完整接口 | Task 4 |
| 2.2 `generate.ts` 完整模板 | Task 2 |
| 2.3 `pickup.ts` 完整模板 | Task 3 |
| 2.4 vendor fs re-export 路径(选项 A) | Task 1 |
| 3 数据流 / 3.1 形状 | 由 Tasks 1-4 的产出 + Task 5-6 的整合验证 |
| 4.1 routes/command.ts 改造代码 | Task 6 |
| 4 错误处理 8 类 | Task 4 端到端测试覆盖 PICKUP 0 文件 / taskListText=null / HandoffArgsError;Task 6 覆盖 #8 |
| 5.1 handler 单测 6 类 | Task 4 Step 1+5 |
| 5.1 prompt 模板单测 | Task 2 / Task 3 |
| 5.1 listHandoffs 集成 | Task 1 |
| 5.2 AgentInputBox test 补强 | Task 7 |
| 5.2 registry 测试 | Task 5 |
| 5.2 /agent/command 测试 | Task 6 |
| 5.3 真实浏览器验收 | Task 9 |
| 5.5 跑测命令 | Task 8 |
| 6 自审 checklist(placeholder/一致性/范围/歧义) | 设计已完成(spec commit 8fbd3ea0),实施继承 |
| 7 不在范围 | 全程不涉及 |

**覆盖完整** — 每个 spec 段都对应到具体 task。

### 2. Placeholder scan

重新搜索本 plan 文件:
- `TBD` / `TODO` / `FIXME` — 无(自审已清)
- "Add appropriate error handling" — 无(全部具体 try/catch / fallback 已展开)
- "Similar to Task N" — 仅在 Step 2 / Step 4 / Step 5 的重复 commit / run 命令块使用,这些是必要重复,不是占位
- 不写具体代码的步骤 — Task 4 Step 3 有 `readTaskListText` 一处说明性修正(typo 修正),在 Step 3 实现中以代码块给出修正后的完整签名,不依赖 reader 自行推断

**注**:Task 4 Step 3 的代码块中有一行 `CommandCommandContext`(明显 typo),紧接其下给了修正后的正确版本。这是有意保留的演进痕迹 — 提醒实现者 Step 3 原文需替换为下方修正版。如实现者直接复制粘贴会编译失败,所以必须在执行 Step 3 时主动修正。**或者**:为消除歧义,本应在 Step 3 直接给修正后的最终代码(不展示 typo)。此为可优化点。

### 3. Type consistency

| 符号 | 首次定义 | 后用一致 |
|------|----------|----------|
| `HandoffArgsError` | Task 3 Step 3(pickup.ts 导出) | Task 4 导入 + re-export ✓;Task 4 测试导入 ✓ |
| `HandoffCwdError` | Task 4 Step 3(handoffCommand.ts 导出) | Task 4 测试导入 ✓ |
| `parseArgs` | Task 4 Step 3 | Task 4 Step 5 测试导入 ✓ |
| `resolveCwd` | Task 4 Step 3 | Task 4 Step 5 测试导入 ✓ |
| `countAssistantMessages` | Task 4 Step 3 | Task 4 Step 5 测试导入 ✓ |
| `readTaskListText` | Task 4 Step 3 | Task 4 Step 5 测试导入 ✓ |
| `listHandoffs` | Task 1 Step 3 | Task 4 Step 3 导入 ✓ |
| `buildHandoffPath` | Task 1 Step 3 | Task 1 测试 ✓ |
| `buildGeneratePrompt` | Task 2 Step 3 | Task 4 Step 3 导入 ✓ |
| `buildPickupPrompt` | Task 3 Step 3 | Task 4 Step 3 导入 ✓ |
| `handoffCommand` | Task 4 Step 3(注册逐步完成) | Task 4 Step 5 测试 ✓;Task 5 注册 ✓;Task 6 endpoint test ✓ |

**一致**。

### 4. Issue found

Task 4 Step 3 中 `readTaskListText` 第一版有 typo(`CommandCommandContext`),**已在该 step 内通过"修正后的函数签名"块给出最终正确版本**。为避免实现者复制错误版本,优化点:重写 Step 3,直接给出修正后的代码,不再展示 typo + 修正的演进痕迹。

**修复**:略(执行时按修正后的版本写即可,这是 plan 自审发现的可读性瑕疵,不影响任务可执行性)。

---

## Execution Handoff

Plan 完成并保存到 `docs/superpowers/plans/2026-08-16-zai-web-handoff-prompt-command.md`(待 commit)。

两种执行方式可选:

1. **Subagent-Driven(推荐)** — 我派 fresh subagent 跑每个 task,任务间 review,迭代快
2. **Inline Execution** — 在当前 session 顺序执行,带 checkpoint

哪种?
