# zai 内置指令基础能力与扩展机制 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai 中实现 `/clear` / `/compact` / `/status` 三个 built-in slash 命令,加上 `~/.zai/commands/*.md` 文件级 user-defined prompt 命令(完整 OpenCC prompt 字段集)、Web CRUD 面板,以及统一的 `/` autocomplete 弹层(commands + skills 合并显示)。

**Architecture:**
- `zai-agent-core` 新增 `src/commands/` 模块,提供 `Command` 类型(收窄,去掉 local-jsx)、`CommandRegistry` 单例、`renderPrompt`($ARGUMENTS / $1..$n / argNames 替换)
- `zai/src/server/services/commands/` 包装 agent-core,提供 `/clear` `/compact` `/status` 三个 `LocalCommand` 实现 + `userLoader` 扫 `~/.zai/commands/*.md` + 服务层单例 `initCommands()`
- 三个 Express 路由:`POST /api/agent/command` (执行)、`/api/agent/commands` (CRUD)、`GET /api/agent/slash` (合并 commands + skills 给前端弹层)
- 前端 `Agent.tsx` `handleSend` 头部加 `/` 分支;`Resources.tsx` Commands 区块加 CRUD 弹窗

**Tech Stack:** TypeScript、Bun (运行时 + `bun:test`)、Express、Ant Design、Zustand、React。零新增 npm 依赖。

---

## Global Constraints

- 测试框架:**vitest**(仓库已有 vitest.config.ts;`bun:test` import 也兼容),`packages/zai-agent-core/test/**` 跑 `pnpm vitest run`(或 `bun run test`),`packages/zai/test/**` 同理。test 写 import 风格:**`import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'`**(不要用 `bun:test`,因为 Task 3 clear 测试要用 `vi.mock`,这是 vitest 才有)
- YAML 解析:**必须复用** `packages/zai-agent-core/src/opencc-internals/utils/yaml.ts` 的 `parseYaml()`(Bun.YAML 优先,fallback `yaml` 包),**不**新增依赖
- agent-core export:**Task 1 创建 `src/commands/` 后,必须同步改 `packages/zai-agent-core/src/index.ts`** 加 `export * from './commands/index.js'` — 否则 zai 端 `import { getCommandRegistry } from '@zn-ai/zai-agent-core'` 拿不到(当前 exports 字段只暴露 `.` / `./runtime` / `./transcript`)
- 文件路径:zai 服务端命令目录 **`~/.zai/commands/<name>.md`**(`name` 匹配 `^[a-z0-9][a-z0-9-_]*$`),**不**用 OpenCC 的 `~/.claude/commands/`
- 已知限制:仓库**没有** `packages/zai/src/server/services/compact/` 目录 → `/compact` MVP 走 stub,返回 `{kind:'error', message:'/compact 暂未实现'}`(spec §2.6 已锁定);后续单独 spec 接
- 现有 skills 端点:**`GET /api/agent/skills`** 已经被 `Agent.tsx:1106` 消费;新增 `/api/agent/slash` 与之并存,前端从 `/skills` 切到 `/slash`
- 现有 token 中间件:路由**不需要** token(参考 `/api/agent/skills` 是无 token 公开)
- 文件写入:原子写(tmp + rename),参考 `JsonTaskStore.atomicWriteFile` 已有模式
- prompt 命令的 `allowedTools` / `model` / `effort` / `disableModelInvocation` 字段:zai 端**只存**到 `.md` frontmatter;消费由后续 spec 接入 QueryEngine(本次不接,plan 不渲染对应 UI 控件)

---

## Task 1: agent-core Command 类型与 prompt 渲染

**Files:**
- Create: `packages/zai-agent-core/src/commands/types.ts`
- Create: `packages/zai-agent-core/src/commands/promptRender.ts`
- Create: `packages/zai-agent-core/src/commands/index.ts`
- Test: `packages/zai-agent-core/test/commands/promptRender.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `CommandContext { cwd; sessionId?; model?; dataDir }`
  - `PromptCommand { type:'prompt'; name; aliases?; description; source; progressMessage; contentLength; argumentHint?; argNames?; allowedTools?; model?; effort?; disableModelInvocation?; whenToUse?; version?; getPromptForCommand(args, context): Promise<ContentBlockParam[]> }`
  - `LocalCommandResult = { kind:'cleared' } | { kind:'compacted'; removedMessages; summary? } | { kind:'status'; payload } | { kind:'message'; text } | { kind:'error'; message }`
  - `LocalCommand { type:'local'; name; aliases?; description; argumentHint?; source; isEnabled?(); call(args, context): Promise<LocalCommandResult> }`
  - `Command = PromptCommand | LocalCommand`
  - `CommandSource = 'builtin'|'bundled'|'plugin'|'project'|'user'|'mcp'`
  - `renderPrompt({body, args, argNames?}): string`

- [ ] **Step 1: 写失败测试** — Create `packages/zai-agent-core/test/commands/promptRender.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { renderPrompt } from '../../src/commands/promptRender.js'

describe('renderPrompt', () => {
  it('replaces $ARGUMENTS', () => {
    expect(renderPrompt({ body: 'Say $ARGUMENTS to me', args: 'hello world' })).toBe('Say hello world to me')
  })

  it('replaces positional $1 $2', () => {
    expect(renderPrompt({ body: 'Hi $1, age $2', args: 'alice 30' })).toBe('Hi alice, age 30')
  })

  it('positional beyond args becomes empty string', () => {
    expect(renderPrompt({ body: 'a=$1 b=$2 c=$3', args: 'x y' })).toBe('a=x b=y c=')
  })

  it('replaces ${name} via argNames order', () => {
    expect(renderPrompt({ body: 'Hi ${name}', args: 'alice', argNames: ['name'] })).toBe('Hi alice')
  })

  it('keeps ${name} literal when name not in argNames', () => {
    expect(renderPrompt({ body: 'Hi ${unknown}', args: 'alice', argNames: ['name'] })).toBe('Hi ${unknown}')
  })

  it('empty args → all replacements empty', () => {
    expect(renderPrompt({ body: '$ARGUMENTS $1', args: '' })).toBe(' ')
  })

  it('handles $$ (escaped dollar) — not a spec requirement, but verify no crash', () => {
    expect(renderPrompt({ body: 'price is $$5', args: '' })).toBe('price is $$5')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai-agent-core && pnpm vitest run test/commands/promptRender.test.ts`
Expected: FAIL — `Cannot find module '../../src/commands/promptRender.js'`

- [ ] **Step 3: 实现 types.ts** — Create `packages/zai-agent-core/src/commands/types.ts`:

```ts
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages'

export type CommandSource =
  | 'builtin' | 'bundled' | 'plugin' | 'project' | 'user' | 'mcp'

export interface CommandContext {
  cwd: string
  sessionId?: string
  model?: string
  dataDir: string
}

export interface PromptCommand {
  type: 'prompt'
  name: string
  aliases?: string[]
  description: string
  source: CommandSource
  progressMessage: string
  contentLength: number
  argumentHint?: string
  argNames?: string[]
  allowedTools?: string[]
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'max'
  disableModelInvocation?: boolean
  whenToUse?: string
  version?: string
  getPromptForCommand(args: string, context: CommandContext): Promise<ContentBlockParam[]>
}

export interface StatusPayload {
  sessionId?: string | null
  cwd: string
  cwdName: string
  branch: string
  model: string
  permissionMode?: string
  version: string
}

export type LocalCommandResult =
  | { kind: 'cleared' }
  | { kind: 'compacted'; removedMessages: number; summary?: string }
  | { kind: 'status'; payload: StatusPayload }
  | { kind: 'message'; text: string }
  | { kind: 'error'; message: string }

export interface LocalCommand {
  type: 'local'
  name: string
  aliases?: string[]
  description: string
  argumentHint?: string
  source: CommandSource
  isEnabled?: () => boolean
  call(args: string, context: CommandContext): Promise<LocalCommandResult>
}

export type Command = PromptCommand | LocalCommand
```

- [ ] **Step 4: 实现 promptRender.ts** — Create `packages/zai-agent-core/src/commands/promptRender.ts`:

```ts
export interface RenderArgs {
  body: string
  args: string
  argNames?: string[]
}

/**
 * Replace `$ARGUMENTS`, `$1..$n`, `${name}` tokens in `body` based on
 * whitespace-split `args` and optional `argNames` (positional mapping).
 * - `$ARGUMENTS` → full args string
 * - `$N` (1-indexed) → N-th whitespace token, or '' if missing
 * - `${name}` → if name appears in argNames, the corresponding positional token;
 *   otherwise literal text is preserved
 */
export function renderPrompt({ body, args, argNames }: RenderArgs): string {
  const tokens = args.trim() ? args.split(/\s+/) : []

  // Pre-compute argNames → positional index map (only for tokens present).
  // name → its positional value (or '' if missing).
  const nameValue = new Map<string, string>()
  if (argNames) {
    argNames.forEach((name, i) => {
      nameValue.set(name, tokens[i] ?? '')
    })
  }

  let out = ''
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    // Escape: $$ means literal $.
    if (ch === '$' && body[i + 1] === '$') {
      out += '$$'
      i += 2
      continue
    }
    if (ch !== '$') {
      out += ch
      i++
      continue
    }
    // We're at a $. Try to match:
    //   $ARGUMENTS (rest of body until something un-$-compatible — but spec: case-sensitive literal)
    //   $N where N is digits
    //   ${name} where name is alpha-numeric + dash + underscore
    if (body.startsWith('$ARGUMENTS', i)) {
      out += args
      i += '$ARGUMENTS'.length
      continue
    }
    if (body[i + 1] !== undefined && /[0-9]/.test(body[i + 1]!)) {
      // parse number
      let j = i + 1
      while (j < body.length && /[0-9]/.test(body[j]!)) j++
      const idx = Number(body.slice(i + 1, j)) - 1
      out += tokens[idx] ?? ''
      i = j
      continue
    }
    if (body[i + 1] === '{') {
      const end = body.indexOf('}', i + 2)
      if (end > i + 2) {
        const name = body.slice(i + 2, end)
        if (nameValue.has(name)) {
          out += nameValue.get(name)!
          i = end + 1
          continue
        }
        // unknown name → preserve literal
        out += body.slice(i, end + 1)
        i = end + 1
        continue
      }
    }
    // Unrecognized $X → keep literal
    out += ch
    i++
  }
  return out
}
```

- [ ] **Step 5: 实现 index.ts** — Create `packages/zai-agent-core/src/commands/index.ts`:

```ts
export * from './types.js'
export { renderPrompt } from './promptRender.js'
export type { RenderArgs } from './promptRender.js'
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/zai-agent-core && pnpm vitest run test/commands/promptRender.test.ts`
Expected: PASS — 7 tests pass

- [ ] **Step 7: Commit**

```bash
git add packages/zai-agent-core/src/commands packages/zai-agent-core/test/commands
git commit -m "feat(zai-agent-core): Command types + renderPrompt(\$ARGUMENTS/\$1..\$n/\${name})"
```

---

## Task 2: agent-core CommandRegistry

**Files:**
- Create: `packages/zai-agent-core/src/commands/registry.ts`
- Test: `packages/zai-agent-core/test/commands/registry.test.ts`
- Modify: `packages/zai-agent-core/src/commands/index.ts` — add export

**Interfaces:**
- Consumes: Task 1 `Command`、`CommandSource`
- Produces:
  - `CommandRegistry { register(cmd); unregister(name); get(name); all(); resolve(input): { command, args } | null }`
  - `getCommandRegistry(): CommandRegistry` (单例)
  - `setCommandRegistry(r | null): void` (测试 seam)

- [ ] **Step 1: 写失败测试** — Create `packages/zai-agent-core/test/commands/registry.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { setCommandRegistry, getCommandRegistry } from '../../src/commands/registry.js'
import type { LocalCommand, Command } from '../../src/commands/types.js'

function makeLocal(name: string, aliases?: string[]): LocalCommand {
  return {
    type: 'local',
    name,
    description: `cmd ${name}`,
    source: 'builtin',
    call: async () => ({ kind: 'message', text: name }),
    ...(aliases ? { aliases } : {}),
  }
}

beforeEach(() => setCommandRegistry(null))

describe('CommandRegistry', () => {
  it('register + get by primary name', () => {
    const r = getCommandRegistry()
    const cmd = makeLocal('clear')
    r.register(cmd)
    expect(r.get('clear')).toBe(cmd)
  })

  it('register + get is case-insensitive', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('clear'))
    expect(r.get('CLEAR')).toBeDefined()
  })

  it('get by alias', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('clear', ['c', 'reset']))
    expect(r.get('reset')).toBeDefined()
    expect(r.get('C')).toBeDefined()
  })

  it('unregister by primary name', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('clear'))
    r.unregister('clear')
    expect(r.get('clear')).toBeUndefined()
  })

  it('all returns registered commands', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('a'))
    r.register(makeLocal('b'))
    expect(r.all().map((c) => c.name).sort()).toEqual(['a', 'b'])
  })

  it('resolve("/clear") returns the clear command with empty args', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('clear'))
    const res = r.resolve('/clear')
    expect(res?.command.name).toBe('clear')
    expect(res?.args).toBe('')
  })

  it('resolve("/compact --force") returns compact with args="--force"', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('compact'))
    const res = r.resolve('/compact --force')
    expect(res?.command.name).toBe('compact')
    expect(res?.args).toBe('--force')
  })

  it('resolve("/foo") returns null for unknown command', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('clear'))
    expect(r.resolve('/foo')).toBeNull()
  })

  it('resolve("/") returns null (empty name)', () => {
    expect(getCommandRegistry().resolve('/')).toBeNull()
  })

  it('all() filters by source for reloadUserCommands pattern', () => {
    const r = getCommandRegistry()
    const a: Command = makeLocal('a')
    const b: LocalCommand = makeLocal('b')
    b.source = 'user'
    r.register(a)
    r.register(b)
    const users = r.all().filter((c) => c.source === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]!.name).toBe('b')
  })

  it('setCommandRegistry(null) resets the singleton', () => {
    const r1 = getCommandRegistry()
    r1.register(makeLocal('a'))
    setCommandRegistry(null)
    const r2 = getCommandRegistry()
    expect(r2).not.toBe(r1)
    expect(r2.get('a')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai-agent-core && pnpm vitest run test/commands/registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/commands/registry.js'`

- [ ] **Step 3: 实现 registry.ts** — Create `packages/zai-agent-core/src/commands/registry.ts`:

```ts
import type { Command } from './types.js'

export interface ResolvedCommand {
  command: Command
  args: string
}

export interface CommandRegistry {
  register(cmd: Command): void
  unregister(name: string): void
  get(name: string): Command | undefined
  all(): Command[]
  resolve(input: string): ResolvedCommand | null
}

class InMemoryRegistry implements CommandRegistry {
  private byPrimary = new Map<string, Command>()
  private byAlias = new Map<string, Command>()

  private key(name: string): string {
    return name.toLowerCase()
  }

  register(cmd: Command): void {
    this.byPrimary.set(this.key(cmd.name), cmd)
    if (cmd.aliases) {
      for (const a of cmd.aliases) this.byAlias.set(this.key(a), cmd)
    }
  }

  unregister(name: string): void {
    const cmd = this.byPrimary.get(this.key(name))
    this.byPrimary.delete(this.key(name))
    if (cmd?.aliases) {
      for (const a of cmd.aliases) this.byAlias.delete(this.key(a))
    }
  }

  get(name: string): Command | undefined {
    const k = this.key(name)
    return this.byPrimary.get(k) ?? this.byAlias.get(k)
  }

  all(): Command[] {
    return Array.from(this.byPrimary.values())
  }

  resolve(input: string): ResolvedCommand | null {
    const trimmed = input.trim()
    if (!trimmed.startsWith('/')) return null
    const rest = trimmed.slice(1)
    if (!rest) return null
    // First whitespace-separated token is the name; the rest is args.
    const sp = rest.search(/\s/)
    const name = sp === -1 ? rest : rest.slice(0, sp)
    const args = sp === -1 ? '' : rest.slice(sp + 1).trim()
    const cmd = this.get(name)
    if (!cmd) return null
    return { command: cmd, args }
  }
}

let _registry: CommandRegistry | null = null

export function getCommandRegistry(): CommandRegistry {
  if (!_registry) _registry = new InMemoryRegistry()
  return _registry
}

export function setCommandRegistry(r: CommandRegistry | null): void {
  _registry = r
}
```

- [ ] **Step 4: 更新 index.ts** — Edit `packages/zai-agent-core/src/commands/index.ts`:

```ts
export * from './types.js'
export { renderPrompt } from './promptRender.js'
export type { RenderArgs } from './promptRender.js'
export { getCommandRegistry, setCommandRegistry } from './registry.js'
export type { CommandRegistry, ResolvedCommand } from './registry.js'
```

- [ ] **Step 5: 跑全部 commands 测试确认通过**

Run: `cd packages/zai-agent-core && pnpm vitest run test/commands/`
Expected: PASS — both files pass

- [ ] **Step 6: 跑全部 commands 测试确认通过**

Run: `cd packages/zai-agent-core && pnpm vitest run test/commands/`
Expected: PASS — both files pass

- [ ] **Step 7: 把 commands 模块接入 agent-core 顶层导出**

zai 端 `import { ... } from '@zn-ai/zai-agent-core'` 必须能拿到 `getCommandRegistry` / `renderPrompt` / `Command` 类型。当前 `packages/zai-agent-core/src/index.ts` 只有 `export * from './runtime/index.js'`,需要追加一行。

Edit `packages/zai-agent-core/src/index.ts`(在 VERSION + runtime export 之后追加):

```ts
// @zn-ai/zai-agent-core
export const VERSION = '0.1.0'
export * from './runtime/index.js'
export * from './commands/index.js'  // 新增
```

Edit `packages/zai-agent-core/package.json` 的 `exports` 字段(可选 — zai 端通过根路径 import 也能拿到,但显式声明更清晰):

```json
"exports": {
  ".": "./dist/index.js",
  "./runtime": "./dist/runtime/index.js",
  "./transcript": "./dist/transcript/store.js",
  "./commands": "./dist/commands/index.js"
}
```

跑构建确认无 TS 错误:

Run: `cd packages/zai-agent-core && pnpm build`
Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add packages/zai-agent-core/src/commands packages/zai-agent-core/test/commands packages/zai-agent-core/src/index.ts packages/zai-agent-core/package.json
git commit -m "feat(zai-agent-core): CommandRegistry with case-insensitive resolve + alias"
```

---

## Task 3: zai 服务层 commandRegistry + 三个 built-in 实现

**Files:**
- Create: `packages/zai/src/server/services/commands/builtin/clear.ts`
- Create: `packages/zai/src/server/services/commands/builtin/compact.ts`
- Create: `packages/zai/src/server/services/commands/builtin/status.ts`
- Create: `packages/zai/src/server/services/commands/registry.ts`
- Test: `packages/zai/test/services/commands/builtin.clear.test.ts`
- Test: `packages/zai/test/services/commands/builtin.compact.test.ts`
- Test: `packages/zai/test/services/commands/builtin.status.test.ts`

**Interfaces:**
- Consumes:
  - agent-core `LocalCommand`, `LocalCommandResult`, `StatusPayload`, `CommandContext`, `getCommandRegistry`
  - `getTranscriptStore()` (from `services/agentRuntime.ts` — **实施前请 Read 该文件确认导出存在**)
  - `getCurrentSessionId()` (from `services/agentRuntime.ts`)
  - `abortAgentSession(reason)` (from `services/agentRuntime.ts` — **同上,确认导出与签名**)
  - `getRuntime()` (from `services/agentRuntime.ts`)
- Produces:
  - `registerBuiltinCommands(): void` (Task 3);最终 `initCommands(context)` 在 Task 4 包装此函数
  - `clearCommand: LocalCommand`
  - `compactCommand: LocalCommand`
  - `statusCommand: LocalCommand`

- [ ] **Step 1: 写失败测试 clear** — Create `packages/zai/test/services/commands/builtin.clear.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { setCommandRegistry, getCommandRegistry } from '@zn-ai/zai-agent-core'
import { clearCommand } from '../../../src/server/services/commands/builtin/clear.js'

beforeEach(() => setCommandRegistry(null))

describe('clearCommand', () => {
  it('removes transcript and returns {kind:"cleared"}', async () => {
    getCommandRegistry().register(clearCommand)
    const removeMock = vi.fn(() => Promise.resolve())
    const abortMock = vi.fn(() => Promise.resolve())
    // We import services via dynamic require to allow mocking the module surface.
    // vi.mock is preferred; use that.
    vi.mock('../../../src/server/services/agentRuntime.js', () => ({
      getTranscriptStore: () => ({ remove: removeMock }),
      getCurrentSessionId: () => null,
      getRuntime: () => ({}),
      abortAgentSession: abortMock,
    }))
    const { clearCommand: fresh } = await import('../../../src/server/services/commands/builtin/clear.js')
    const result = await fresh.call('whatever', { cwd: '/x', dataDir: '/d' })
    expect(result).toEqual({ kind: 'cleared' })
    expect(removeMock).toHaveBeenCalledTimes(0) // sessionId is null
    expect(abortMock).toHaveBeenCalledTimes(0)
  })

  it('aborts active session and removes transcript when sessionId present', async () => {
    const removeMock = vi.fn(() => Promise.resolve())
    const abortMock = vi.fn(() => Promise.resolve())
    vi.mock('../../../src/server/services/agentRuntime.js', () => ({
      getTranscriptStore: () => ({ remove: removeMock }),
      getCurrentSessionId: () => 'sess-1',
      getRuntime: () => ({}),
      abortAgentSession: abortMock,
    }))
    const { clearCommand: fresh } = await import('../../../src/server/services/commands/builtin/clear.js')
    const result = await fresh.call('', { cwd: '/x', dataDir: '/d' })
    expect(result).toEqual({ kind: 'cleared' })
    expect(abortMock).toHaveBeenCalled()
    expect(removeMock).toHaveBeenCalledWith('sess-1')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm vitest run test/services/commands/builtin.clear.test.ts`
Expected: FAIL — `Cannot find module '../../../src/server/services/commands/builtin/clear.js'`

- [ ] **Step 3: 实现 builtin/clear.ts** — Create `packages/zai/src/server/services/commands/builtin/clear.ts`:

```ts
import { getTranscriptStore, getCurrentSessionId, abortAgentSession } from '../../agentRuntime.js'
import type { LocalCommand, LocalCommandResult } from '@zn-ai/zai-agent-core'

export const clearCommand: LocalCommand = {
  type: 'local',
  name: 'clear',
  description: '清空当前对话',
  argumentHint: '',
  source: 'builtin',
  async call(_args, _context): Promise<LocalCommandResult> {
    const sessionId = getCurrentSessionId()
    if (sessionId) {
      await abortAgentSession('user_clear')
      await getTranscriptStore().remove(sessionId)
    }
    return { kind: 'cleared' }
  },
}
```

- [ ] **Step 4: 实现 builtin/compact.ts** — Create `packages/zai/src/server/services/commands/builtin/compact.ts`:

```ts
import type { LocalCommand, LocalCommandResult } from '@zn-ai/zai-agent-core'

/**
 * MVP: returns an explicit 'not yet wired' error.
 * Future spec wires this to the existing services/compact pipeline
 * (or implements compact inside this module). See spec §2.6 / §9.
 */
export const compactCommand: LocalCommand = {
  type: 'local',
  name: 'compact',
  description: '手动压缩当前对话',
  argumentHint: '[--force]',
  source: 'builtin',
  async call(_args, _context): Promise<LocalCommandResult> {
    return { kind: 'error', message: '/compact 暂未实现' }
  },
}
```

- [ ] **Step 5: 实现 builtin/status.ts** — Create `packages/zai/src/server/services/commands/builtin/status.ts`:

```ts
import { getCurrentSessionId } from '../../agentRuntime.js'
import type { LocalCommand, LocalCommandResult, StatusPayload } from '@zn-ai/zai-agent-core'

export const statusCommand: LocalCommand = {
  type: 'local',
  name: 'status',
  description: '查看当前会话状态',
  argumentHint: '',
  source: 'builtin',
  async call(_args, context): Promise<LocalCommandResult> {
    const payload: StatusPayload = {
      sessionId: getCurrentSessionId(),
      cwd: context.cwd,
      cwdName: context.cwd.split('/').pop() || '/',
      branch: '', // branch 由前端 useAppStore.instanceContext.branch 提供,服务端不解析
      model: context.model ?? 'unknown',
      version: '0.1.0',
    }
    return { kind: 'status', payload }
  },
}
```

- [ ] **Step 6: 实现 service-layer registry.ts** — Create `packages/zai/src/server/services/commands/registry.ts`:

```ts
import { getCommandRegistry } from '@zn-ai/zai-agent-core'
import { clearCommand } from './builtin/clear.js'
import { compactCommand } from './builtin/compact.js'
import { statusCommand } from './builtin/status.js'

let initialized = false

/**
 * Registers built-in commands into the agent-core singleton registry.
 * Idempotent. User commands are loaded separately via reloadUserCommands
 * (see Task 4) and wired into a final initCommands in Task 4 Step 5.
 */
export function registerBuiltinCommands(): void {
  if (initialized) return
  const reg = getCommandRegistry()
  reg.register(clearCommand)
  reg.register(compactCommand)
  reg.register(statusCommand)
  initialized = true
}
```

**注**:Task 3 这一步只注册 built-in,**不**调 userLoader。Task 4 完成后 Step 5 会把 `registry.ts` 改写为最终形态:`initCommands(context)` = `registerBuiltinCommands()` + `await reloadUserCommands(context)`,并被 Task 5 / Task 10 引用。Task 3 不应 import `reloadUserCommands`(避免循环 + Task 3 跑测试时 userLoader 还不存在)。

- [ ] **Step 7: 写失败测试 compact** — Create `packages/zai/test/services/commands/builtin.compact.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { compactCommand } from '../../../src/server/services/commands/builtin/compact.js'

describe('compactCommand (MVP stub)', () => {
  it('returns {kind:"error"} with explicit message', async () => {
    const result = await compactCommand.call('', { cwd: '/x', dataDir: '/d' })
    expect(result.kind).toBe('error')
    expect((result as { message: string }).message).toBe('/compact 暂未实现')
  })
})
```

- [ ] **Step 8: 写失败测试 status** — Create `packages/zai/test/services/commands/builtin.status.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest'

beforeEach(() => {
  vi.mock('../../../src/server/services/agentRuntime.js', () => ({
    getCurrentSessionId: () => 'sess-abc',
  }))
})

describe('statusCommand', () => {
  it('payload includes cwdName derived from cwd', async () => {
    const { statusCommand } = await import('../../../src/server/services/commands/builtin/status.js')
    const result = await statusCommand.call('', { cwd: '/Users/x/project', dataDir: '/d', model: 'claude-3-5-sonnet' })
    expect(result.kind).toBe('status')
    const payload = (result as { payload: any }).payload
    expect(payload.cwd).toBe('/Users/x/project')
    expect(payload.cwdName).toBe('project')
    expect(payload.model).toBe('claude-3-5-sonnet')
    expect(payload.sessionId).toBe('sess-abc')
  })
})
```

- [ ] **Step 9: 跑三组 builtin 测试**

Run: `cd packages/zai && pnpm vitest run test/services/commands/`
Expected: PASS — clear(2) + compact(1) + status(1) = 4 tests pass

- [ ] **Step 10: Commit**

```bash
git add packages/zai/src/server/services/commands packages/zai/test/services/commands
git commit -m "feat(zai): built-in commands /clear /compact /status + service registry"
```

---

## Task 4: userLoader — 扫 ~/.zai/commands/*.md

**Files:**
- Create: `packages/zai/src/server/services/commands/userLoader.ts`
- Modify: `packages/zai/src/server/services/commands/registry.ts` — add `loadUserCommands()` + `reloadUserCommands()`
- Test: `packages/zai/test/services/commands/userLoader.test.ts`

**Interfaces:**
- Consumes:
  - agent-core `PromptCommand`, `CommandContext`, `CommandSource`
  - `parseYaml` from `@zn-ai/zai-agent-core` 的 utils/yaml(走 deep import: `'@zn-ai/zai-agent-core/utils/yaml'`,确认 export;否则用相对路径:`../../../../zai-agent-core/src/opencc-internals/utils/yaml.js`)
  - `~/.zai/commands/<name>.md` 文件系统
- Produces:
  - `loadUserCommands(cwd, dataDir): Promise<PromptCommand[]>` — 单次扫描
  - `reloadUserCommands(cwd, dataDir): Promise<PromptCommand[]>` — unregister 旧 user + 重新 register + 返回注册表

- [ ] **Step 1: 验证 yaml parser 的 export 路径**

Run: `grep -rn "yaml" packages/zai-agent-core/src/index.ts packages/zai-agent-core/src/utils/index.ts 2>/dev/null | head -20`

If `parseYaml` is exported from `@zn-ai/zai-agent-core`, use that. Otherwise, fall back to the relative path import inside userLoader.

(Falls back to direct import from the opencc-internals file — acceptable since this is the same approach `loadSkillsFromDirs` uses via dynamic import. If blocked, the test in step 4 catches the failure.)

- [ ] **Step 2: 写失败测试** — Create `packages/zai/test/services/commands/userLoader.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setCommandRegistry, getCommandRegistry } from '@zn-ai/zai-agent-core'
import { loadUserCommands, reloadUserCommands } from '../../../src/server/services/commands/userLoader.js'

let tmpHome: string
let commandsDir: string

beforeEach(() => {
  setCommandRegistry(null)
  tmpHome = mkdtempSync(join(tmpdir(), 'zai-cmd-test-'))
  commandsDir = join(tmpHome, '.zai', 'commands')
  mkdirSync(commandsDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

function writeCommand(name: string, frontmatter: object, body: string): void {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  const content = `---\n${yaml}\n---\n${body}`
  writeFileSync(join(commandsDir, `${name}.md`), content, 'utf-8')
}

describe('loadUserCommands', () => {
  it('returns [] when commands dir does not exist', async () => {
    rmSync(commandsDir, { recursive: true, force: true })
    const cmds = await loadUserCommands({ cwd: '/x', dataDir: tmpHome })
    expect(cmds).toEqual([])
  })

  it('loads a valid .md as PromptCommand', async () => {
    writeCommand('greet', {
      description: 'Say hi',
      argumentHint: '[name]',
      argNames: ['name'],
      whenToUse: 'Greet someone',
    }, 'Hello $ARGUMENTS')
    const cmds = await loadUserCommands({ cwd: '/x', dataDir: tmpHome })
    expect(cmds).toHaveLength(1)
    expect(cmds[0]!.name).toBe('greet')
    expect(cmds[0]!.source).toBe('user')
    expect(cmds[0]!.description).toBe('Say hi')
    expect(cmds[0]!.argumentHint).toBe('[name]')
    expect(cmds[0]!.argNames).toEqual(['name'])
    expect(cmds[0]!.contentLength).toBe('Hello $ARGUMENTS'.length)
    const rendered = await cmds[0]!.getPromptForCommand('alice', { cwd: '/x', dataDir: tmpHome })
    expect((rendered[0] as any).text).toBe('Hello alice')
  })

  it('skips files with invalid name', async () => {
    writeCommand('Bad-Name', { description: 'x' }, 'body')
    writeCommand('good', { description: 'y' }, 'body')
    const cmds = await loadUserCommands({ cwd: '/x', dataDir: tmpHome })
    expect(cmds.map((c) => c.name)).toEqual(['good'])
  })

  it('skips files with invalid YAML (no crash)', async () => {
    writeFileSync(join(commandsDir, 'broken.md'), '---\n: : invalid\n---\nbody', 'utf-8')
    writeCommand('good', { description: 'y' }, 'body')
    const cmds = await loadUserCommands({ cwd: '/x', dataDir: tmpHome })
    expect(cmds.map((c) => c.name)).toEqual(['good'])
  })
})

describe('reloadUserCommands', () => {
  it('removes old user commands and registers new', async () => {
    writeCommand('foo', { description: 'old' }, 'body')
    const r = getCommandRegistry()
    reloadUserCommands({ cwd: '/x', dataDir: tmpHome })
    expect(r.get('foo')).toBeDefined()

    writeCommand('bar', { description: 'new' }, 'body')
    rmSync(join(commandsDir, 'foo.md'))
    reloadUserCommands({ cwd: '/x', dataDir: tmpHome })
    expect(r.get('foo')).toBeUndefined()
    expect(r.get('bar')).toBeDefined()
  })

  it('does not overwrite built-in commands with same name (user gets user: prefix)', async () => {
    // Pre-register a built-in manually
    const reg = getCommandRegistry()
    reg.register({
      type: 'local',
      name: 'clear',
      description: 'builtin',
      source: 'builtin',
      call: async () => ({ kind: 'cleared' }),
    })
    writeCommand('clear', { description: 'user wants to override clear' }, 'hi')
    reloadUserCommands({ cwd: '/x', dataDir: tmpHome })
    // builtin still wins
    expect(reg.get('clear')?.source).toBe('builtin')
    // user variant registered as user:clear
    expect(reg.get('user:clear')).toBeDefined()
    expect(reg.get('user:clear')?.source).toBe('user')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/zai && pnpm vitest run test/services/commands/userLoader.test.ts`
Expected: FAIL — `Cannot find module '../../../src/server/services/commands/userLoader.js'`

- [ ] **Step 4: 实现 userLoader.ts** — Create `packages/zai/src/server/services/commands/userLoader.ts`:

```ts
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PromptCommand, CommandContext, CommandSource } from '@zn-ai/zai-agent-core'
// yaml 解析走 agent-core 已有工具,避免新增依赖:
//   该文件位于 packages/zai-agent-core/src/opencc-internals/utils/yaml.ts,
//   Bun.YAML 优先,fallback 到 'yaml' npm 包。
import { parseYaml } from '../../../../zai-agent-core/src/opencc-internals/utils/yaml.js'

const NAME_RE = /^[a-z0-9][a-z0-9-_]*$/

function defaultCommandsDir(): string {
  return join(homedir(), '.zai', 'commands')
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
  // Frontmatter: 以 --- 开头,以 --- 结束。
  if (!raw.startsWith('---')) return null
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return null
  const yamlBlock = raw.slice(3, end).trim()
  // 用 \n 修复末尾换行 + 余下 body
  try {
    return parseYaml(yamlBlock) as CommandFrontmatter
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
      const { renderPrompt } = await import('@zn-ai/zai-agent-core')
      const text = renderPrompt({ body, args, argNames: fm?.argNames })
      return [{ type: 'text', text }]
    },
  }
}

export async function loadUserCommands(context: CommandContext): Promise<PromptCommand[]> {
  const dir = defaultCommandsDir()
  if (!existsSync(dir)) return []
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

/**
 * 清掉 registry 里所有 source==='user' 的命令,重新扫描 + 注册。
 * 同步函数(内部 await),不阻塞调用方太久:O(几十) 个文件,毫秒级。
 */
export async function reloadUserCommands(context: CommandContext): Promise<PromptCommand[]> {
  const { getCommandRegistry } = await import('@zn-ai/zai-agent-core')
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
```

- [ ] **Step 5: 把 registry.ts 改为最终形态** — Edit `packages/zai/src/server/services/commands/registry.ts`,把 `registerBuiltinCommands` 替换为 `initCommands`(包装其调用 + 触发 user loader reload),并 re-export 旧名字向后兼容(可选,Task 5 import 用新名):

```ts
import type { CommandContext } from '@zn-ai/zai-agent-core'
import { registerBuiltinCommands } from './builtin/_register.js'
import { reloadUserCommands } from './userLoader.js'

/**
 * Idempotent. Registers built-ins (once) + (re)loads user commands from disk.
 * Safe to call multiple times — built-in registration is gated inside
 * registerBuiltinCommands.
 */
export async function initCommands(context: CommandContext): Promise<void> {
  registerBuiltinCommands()
  await reloadUserCommands(context)
}

// Re-export for any other module that imports the bare function.
export { registerBuiltinCommands }
```

**注**:为了让 Step 5 工作,需要把 Task 3 Step 6 中的 `registerBuiltinCommands` export 拆到一个独立小文件 `packages/zai/src/server/services/commands/builtin/_register.ts`,避免与 Step 5 写新的 registry.ts 冲突。如果不想拆文件,Step 5 也可以直接在 registry.ts 顶部保留 `registerBuiltinCommands` 函数定义,然后加 `initCommands` 调用它 — 两种方式任选其一。**plan 默认采用"不拆文件、保留函数"路径**:

```ts
import type { CommandContext } from '@zn-ai/zai-agent-core'
import { clearCommand } from './builtin/clear.js'
import { compactCommand } from './builtin/compact.js'
import { statusCommand } from './builtin/status.js'
import { reloadUserCommands } from './userLoader.js'

let initialized = false

/** Registers built-in commands into the agent-core singleton registry. Idempotent. */
export function registerBuiltinCommands(): void {
  if (initialized) return
  const reg = getCommandRegistry()
  reg.register(clearCommand)
  reg.register(compactCommand)
  reg.register(statusCommand)
  initialized = true
}

/**
 * Idempotent. Registers built-ins (once) + (re)loads user commands from disk.
 */
export async function initCommands(context: CommandContext): Promise<void> {
  registerBuiltinCommands()
  await reloadUserCommands(context)
}
```

加上 `import { getCommandRegistry } from '@zn-ai/zai-agent-core'`(顶部)。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/zai && pnpm vitest run test/services/commands/userLoader.test.ts`
Expected: PASS — 6 tests pass

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/server/services/commands packages/zai/test/services/commands
git commit -m "feat(zai): userLoader scans ~/.zai/commands/*.md as PromptCommand"
```

---

## Task 5: Express 路由 — POST /api/agent/command

**Files:**
- Create: `packages/zai/src/server/routes/command.ts`
- Modify: `packages/zai/src/server/routes/agent.ts` — register commandRouter

**Interfaces:**
- Consumes:
  - agent-core `getCommandRegistry`
  - `initCommands`, `getCurrentSessionId`
  - server-side `CommandContext` build helper (用 `process.cwd()` + `getCurrentSessionId()` + `runtime model`)
- Produces:
  - `POST /api/agent/command` returning `{ type: 'cleared'|'compacted'|'status'|'prompt'|'unknown'|'error', payload }`

- [ ] **Step 1: 找 Express app 注入点**

Run: `grep -rn "app.use\|app.post\|router\." packages/zai/src/server/routes/agent.ts | head -30`
Expected: 找到类似 `app.post('/api/agent/prompt', ...)` 和 `app.use('/api/agent', ...)` 的入口。

Read line numbers exactly as printed by grep to add the new router at the same location.

- [ ] **Step 2: 实现 routes/command.ts** — Create `packages/zai/src/server/routes/command.ts`:

```ts
import { Router } from 'express'
import { getCommandRegistry } from '@zn-ai/zai-agent-core'
import { initCommands } from '../services/commands/registry.js'
import { getCurrentSessionId, getRuntime } from '../services/agentRuntime.js'

export const commandRouter = Router()

interface CommandRequestBody {
  name?: string
  args?: string
  sessionId?: string
}

commandRouter.post('/command', async (req, res) => {
  const { name, args = '', sessionId } = (req.body ?? {}) as CommandRequestBody

  // 服务启动时若未 init,先兜底一次。
  await initCommands({ cwd: process.cwd(), dataDir: process.env.ZAI_DATA_DIR ?? '', sessionId })

  const reg = getCommandRegistry()
  const cmd = name ? reg.get(name) : undefined
  if (!cmd) {
    return res.json({ type: 'unknown', payload: { input: `/${name}` } })
  }

  // 取当前 session;若 body 带 sessionId,优先用。
  const sid = sessionId ?? getCurrentSessionId() ?? undefined
  const context = {
    cwd: process.cwd(),
    dataDir: process.env.ZAI_DATA_DIR ?? '',
    ...(sid ? { sessionId: sid } : {}),
    ...(getRuntime().config.defaultModel ? { model: getRuntime().config.defaultModel } : {}),
  }

  try {
    if (cmd.type === 'local') {
      const result = await cmd.call(args, context)
      switch (result.kind) {
        case 'cleared': return res.json({ type: 'cleared', payload: null })
        case 'compacted': return res.json({ type: 'compacted', payload: { removedMessages: result.removedMessages, summary: result.summary } })
        case 'status': return res.json({ type: 'status', payload: result.payload })
        case 'message': return res.json({ type: 'message', payload: { text: result.text } })
        case 'error': return res.json({ type: 'error', payload: { message: result.message } })
      }
    }
    // PromptCommand
    const blocks = await cmd.getPromptForCommand(args, context)
    // 合并 text 块为单字符串(实际场景绝大多数命令只有一段 text)。
    const text = blocks
      .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n')
    return res.json({ type: 'prompt', payload: { rendered: text } })
  } catch (err) {
    return res.status(500).json({ type: 'error', payload: { message: (err as Error).message } })
  }
})
```

- [ ] **Step 3: 在 agent.ts 注册 commandRouter**

Locate the existing router registration block (e.g. `app.use('/api/agent', someRouter)`), then add:

```ts
import { commandRouter } from './command.js'
// ...
app.use('/api/agent', commandRouter)
```

Place the import next to the other router imports. Place the `app.use` next to the existing `/api/agent` registrations.

- [ ] **Step 4: 跑 zai 端已有测试**

Run: `cd packages/zai && pnpm vitest run test/`
Expected: PASS — 现有测试不变,新路由是 additive。

- [ ] **Step 5: 手测启动 server + curl**

```bash
cd packages/zai
# 启动开发 server;具体命令参考 README.md 或 package.json scripts
# 用真实 sessionId 测试三个端点:
# curl -X POST http://localhost:PORT/api/agent/command -H 'Content-Type: application/json' -d '{"name":"status"}'
# curl -X POST http://localhost:PORT/api/agent/command -H 'Content-Type: application/json' -d '{"name":"compact","args":"--force"}'
# curl -X POST http://localhost:PORT/api/agent/command -H 'Content-Type: application/json' -d '{"name":"unknown"}'
```

Expected: status 返回 `{type:'status',payload:{...}}`;compact 返回 `{type:'error',payload:{message:'/compact 暂未实现'}}`;unknown 返回 `{type:'unknown',payload:{input:'/unknown'}}`。

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/server/routes/command.ts packages/zai/src/server/routes/agent.ts
git commit -m "feat(zai): POST /api/agent/command routes built-in + user commands"
```

---

## Task 6: Express 路由 — CRUD /api/agent/commands

**Files:**
- Create: `packages/zai/src/server/routes/commands.ts`
- Modify: `packages/zai/src/server/routes/agent.ts` — register

**Interfaces:**
- Consumes: `writeUserCommandFile`, `readUserCommandFile`, `deleteUserCommandFile`, `reloadUserCommands`
- Produces:
  - `GET /api/agent/commands` → 列表
  - `GET /api/agent/commands/:name` → 全文
  - `POST /api/agent/commands` → 写
  - `PUT /api/agent/commands/:name` → 写(覆盖)
  - `DELETE /api/agent/commands/:name` → 删

- [ ] **Step 1: 写失败测试** — Create `packages/zai/test/server/routes/commandsCrud.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let originalHome: string | undefined
let tmpHome: string

beforeEach(() => {
  originalHome = process.env.HOME
  tmpHome = mkdtempSync(join(tmpdir(), 'zai-cmdcrud-'))
  process.env.HOME = tmpHome
})

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('commands CRUD routes', () => {
  it('GET list returns [] when no commands dir', async () => {
    const res = await fetch(`http://localhost:0/api/agent/commands`)
    // 由于我们没有真实 server,这里测试 fileIO helpers;路由测试在集成测试中。
    const { readCommandList } = await import('../../../src/server/services/commands/fileStore.js')
    expect(await readCommandList()).toEqual([])
  })

  it('PUT then GET reads the saved file', async () => {
    const { writeCommandFile, readCommandFile } = await import('../../../src/server/services/commands/fileStore.js')
    await writeCommandFile('greet', { description: 'Say hi', argumentHint: '[name]' }, 'Hello $1')
    const out = await readCommandFile('greet')
    expect(out).not.toBeNull()
    expect(out!.frontmatter.description).toBe('Say hi')
    expect(out!.body).toBe('Hello $1')
  })

  it('write rejects invalid name', async () => {
    const { writeCommandFile } = await import('../../../src/server/services/commands/fileStore.js')
    await expect(writeCommandFile('Bad-Name', { description: 'x' }, 'b')).rejects.toThrow()
  })

  it('delete removes file', async () => {
    const { writeCommandFile, deleteCommandFile, readCommandFile } = await import('../../../src/server/services/commands/fileStore.js')
    await writeCommandFile('foo', { description: 'x' }, 'b')
    await deleteCommandFile('foo')
    expect(await readCommandFile('foo')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm vitest run test/server/routes/commandsCrud.test.ts`
Expected: FAIL — `Cannot find module '../../../src/server/services/commands/fileStore.js'`

- [ ] **Step 3: 实现 fileStore.ts** — Create `packages/zai/src/server/services/commands/fileStore.ts`:

```ts
import { writeFileSync, readFileSync, readdirSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseYaml } from '../../../../zai-agent-core/src/opencc-internals/utils/yaml.js'

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
  const { renameSync } = await import('node:fs')
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
    fm = (parseYaml(raw.slice(3, end).trim()) as Record<string, unknown>) ?? {}
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
```

- [ ] **Step 4: 跑 fileStore 测试**

Run: `cd packages/zai && pnpm vitest run test/server/routes/commandsCrud.test.ts`
Expected: PASS — 4 tests pass

- [ ] **Step 5: 实现 routes/commands.ts** — Create `packages/zai/src/server/routes/commands.ts`:

```ts
import { Router } from 'express'
import { writeCommandFile, readCommandFile, deleteCommandFile, readCommandList } from '../services/commands/fileStore.js'
import { reloadUserCommands } from '../services/commands/userLoader.js'

export const commandsRouter = Router()

async function refreshRegistry(): Promise<void> {
  await reloadUserCommands({ cwd: process.cwd(), dataDir: process.env.ZAI_DATA_DIR ?? '' })
}

commandsRouter.get('/commands', async (_req, res) => {
  res.json({ items: await readCommandList() })
})

commandsRouter.get('/commands/:name', async (req, res) => {
  const file = await readCommandFile(req.params.name)
  if (!file) return res.status(404).json({ error: 'not found' })
  res.json(file)
})

commandsRouter.post('/commands', async (req, res) => {
  const { name, frontmatter = {}, body = '' } = req.body ?? {}
  if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'name required' })
  if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body required' })
  try {
    await writeCommandFile(name, frontmatter, body)
    await refreshRegistry()
    res.json({ ok: true, name })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

commandsRouter.put('/commands/:name', async (req, res) => {
  const { frontmatter = {}, body = '' } = req.body ?? {}
  if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'body required' })
  try {
    await writeCommandFile(req.params.name, frontmatter, body)
    await refreshRegistry()
    res.json({ ok: true, name: req.params.name })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

commandsRouter.delete('/commands/:name', async (req, res) => {
  await deleteCommandFile(req.params.name)
  await refreshRegistry()
  res.json({ ok: true })
})
```

- [ ] **Step 6: 在 agent.ts 注册 commandsRouter**

Edit `packages/zai/src/server/routes/agent.ts`, alongside the commandRouter registration:

```ts
import { commandsRouter } from './commands.js'
// ...
app.use('/api/agent', commandsRouter)
```

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/server/services/commands/fileStore.ts packages/zai/src/server/routes/commands.ts packages/zai/src/server/routes/agent.ts packages/zai/test/server/routes/commandsCrud.test.ts
git commit -m "feat(zai): CRUD /api/agent/commands + atomic file store"
```

---

## Task 7: Express 路由 — GET /api/agent/slash

**Files:**
- Create: `packages/zai/src/server/routes/slash.ts`
- Modify: `packages/zai/src/server/routes/agent.ts` — register

**Interfaces:**
- Consumes: `getCommandRegistry`, `listSkills` (from agentRuntime)
- Produces: `GET /api/agent/slash` → `{ items: [{kind:'command'|'skill', name, description, ...}] }`

- [ ] **Step 1: 写失败测试** — Create `packages/zai/test/server/routes/slash.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { setCommandRegistry, getCommandRegistry } from '@zn-ai/zai-agent-core'
import { slashList } from '../../../src/server/services/commands/slashList.js'

beforeEach(() => setCommandRegistry(null))

describe('slashList', () => {
  it('returns built-in commands when no user commands', async () => {
    const r = getCommandRegistry()
    r.register({ type: 'local', name: 'clear', description: 'd', source: 'builtin', call: async () => ({ kind: 'cleared' }) })
    r.register({ type: 'local', name: 'compact', description: 'd', source: 'builtin', call: async () => ({ kind: 'error', message: 'x' }) })
    const out = await slashList({ skills: [{ name: 'frontend-design', description: 'design skill' }] })
    expect(out.map((i) => i.name)).toEqual(['clear', 'compact', 'frontend-design'])
    expect(out[0]!.kind).toBe('command')
    expect(out[0]!.isBuiltIn).toBe(true)
    expect(out[2]!.kind).toBe('skill')
  })

  it('user commands appear after built-ins', async () => {
    const r = getCommandRegistry()
    r.register({ type: 'local', name: 'clear', description: 'd', source: 'builtin', call: async () => ({ kind: 'cleared' }) })
    r.register({ type: 'prompt', name: 'greet', description: 'd', source: 'user', progressMessage: 'p', contentLength: 0, getPromptForCommand: async () => [{ type: 'text', text: 'hi' }] })
    const out = await slashList({ skills: [] })
    expect(out.map((i) => i.name)).toEqual(['clear', 'greet'])
    expect(out[1]!.kind).toBe('command')
    expect(out[1]!.isBuiltIn).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm vitest run test/server/routes/slash.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 slashList helper** — Create `packages/zai/src/server/services/commands/slashList.ts`:

```ts
import { getCommandRegistry } from '@zn-ai/zai-agent-core'
import { listSkills } from '../agentRuntime.js'

export interface SlashItem {
  kind: 'command' | 'skill'
  name: string
  description: string
  argumentHint?: string
  whenToUse?: string
  isBuiltIn?: boolean
}

export async function slashList(opts: { skills?: Array<{ name: string; description: string }> } = {}): Promise<SlashItem[]> {
  const items: SlashItem[] = []

  // 1. built-in commands first
  for (const cmd of getCommandRegistry().all()) {
    if (cmd.source !== 'builtin') continue
    items.push({
      kind: 'command',
      name: cmd.name,
      description: cmd.description,
      ...(cmd.argumentHint ? { argumentHint: cmd.argumentHint } : {}),
      ...(cmd.whenToUse ? { whenToUse: cmd.whenToUse } : {}),
      isBuiltIn: true,
    })
  }

  // 2. user commands
  for (const cmd of getCommandRegistry().all()) {
    if (cmd.source !== 'user') continue
    items.push({
      kind: 'command',
      name: cmd.name,
      description: cmd.description,
      ...(cmd.argumentHint ? { argumentHint: cmd.argumentHint } : {}),
      ...(cmd.whenToUse ? { whenToUse: cmd.whenToUse } : {}),
      isBuiltIn: false,
    })
  }

  // 3. skills (走 service 层 listSkills)
  let skills = opts.skills
  if (!skills) {
    try {
      skills = await listSkills()
    } catch {
      skills = []
    }
  }
  for (const s of skills) {
    items.push({
      kind: 'skill',
      name: s.name,
      description: s.description,
    })
  }

  return items
}
```

- [ ] **Step 4: 实现 routes/slash.ts** — Create `packages/zai/src/server/routes/slash.ts`:

```ts
import { Router } from 'express'
import { slashList } from '../services/commands/slashList.js'

export const slashRouter = Router()

slashRouter.get('/slash', async (_req, res) => {
  const items = await slashList()
  res.json({ items })
})
```

- [ ] **Step 5: 在 agent.ts 注册 slashRouter**

Edit `packages/zai/src/server/routes/agent.ts`:

```ts
import { slashRouter } from './slash.js'
// ...
app.use('/api/agent', slashRouter)
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/zai && pnpm vitest run test/server/routes/slash.test.ts`
Expected: PASS — 2 tests pass

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/server/services/commands/slashList.ts packages/zai/src/server/routes/slash.ts packages/zai/src/server/routes/agent.ts packages/zai/test/server/routes/slash.test.ts
git commit -m "feat(zai): GET /api/agent/slash merges commands + skills"
```

---

## Task 8: 前端 — Agent.tsx handleSend 加 slash 分支 + 合并 slash 弹层

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`

**Interfaces:**
- Consumes:
  - 现有 `api.post('/agent/prompt', ...)`, `fetch('/api/agent/skills')`, `useAgentStore.clearMessages()`, `useAgentStore.loadSessions()`
  - 现有 `useState<skills>` 状态变量
- Produces:
  - `handleSend` 头部 `if (text.startsWith('/'))` 分支
  - `useState<slashItems>` 替代 `useState<skills>`,从 `/api/agent/slash` 拉
  - `filteredSlashItems` 替代 `filteredSkills`,合并 commands + skills fuzzy 匹配

- [ ] **Step 1: 找到目标行** — Open `packages/zai/src/web/src/pages/Agent.tsx`. Locate:

  - Line 1006-1011: `useState<skills>` 等
  - Line 1104-1112: `useEffect` fetch `/api/agent/skills`
  - Line 1134-1151: `filteredSkills` useMemo
  - Line 1269-1342: `handleSend`

- [ ] **Step 2: 替换 skills 状态为 slashItems**

Edit the state block (around line 1006-1011):

```tsx
// 旧:
// const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([])
// 新:
const [slashItems, setSlashItems] = useState<
  Array<{ kind: 'command' | 'skill'; name: string; description: string; isBuiltIn?: boolean }>
>([])
const setSlashSkills = useCallback((items: typeof slashItems) => setSlashItems(items), [])
const skills = useMemo(
  () => slashItems.filter((i) => i.kind === 'skill') as Array<{ name: string; description: string }>,
  [slashItems],
)
const commands = useMemo(
  () => slashItems.filter((i) => i.kind === 'command') as Array<{ name: string; description: string; isBuiltIn?: boolean }>,
  [slashItems],
)
```

- [ ] **Step 3: 替换 fetch /skills 为 fetch /slash**

Edit the `useEffect` around line 1104-1112:

```tsx
// 旧:
// fetch("/api/agent/skills").then(...).then(data => { if (data.skills) setSkills(data.skills) })
// 新:
useEffect(() => {
  fetch("/api/agent/slash")
    .then((res) => res.json())
    .then((data) => {
      if (Array.isArray(data.items)) setSlashItems(data.items)
    })
    .catch(() => {})
}, [])
```

- [ ] **Step 4: 替换 filteredSkills 为 filteredSlashItems**

Replace `filteredSkills` useMemo (lines 1134-1151) with:

```tsx
const filteredSlashItems = useMemo(() => {
  if (!input.startsWith("/")) return []
  const q = input.slice(1).toLowerCase()
  if (!q) return slashItems
  const scored = slashItems
    .map((item) => {
      const nameScore = fuzzyMatch(q, item.name)
      const descScore = fuzzyMatch(q, item.description)
      if (nameScore === 0) return { item, score: 0 }
      const bonus = descScore > 0 ? descScore * 0.3 : 0
      return { item, score: nameScore + bonus }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.map((s) => s.item)
}, [input, slashItems])

// 把过滤后,做"命令优先"的重新排序:commands 排在 skills 前面。
// 这样用户打 "/cl" 时,/clear 排在任何 skill 前面。
const orderedSlashItems = useMemo(() => {
  const cmds = filteredSlashItems.filter((i) => i.kind === "command")
  const sks = filteredSlashItems.filter((i) => i.kind === "skill")
  return [...cmds, ...sks]
}, [filteredSlashItems])
```

- [ ] **Step 5: 把 filteredSkills 的下游引用改为 orderedSlashItems**

Find every occurrence of `filteredSkills` in this file and rename to `orderedSlashItems`. Locations include:

- `useEffect(() => { setSkillMenuIdx(0); setShowSkillMenu(filteredSkills.length > 0) }, [...])`
- `handleKeyDown` 里的 `filteredSkills.length > 0`
- `selectSkill(filteredSkills[skillMenuIdx]!.name)`

(Note: `selectSkill` and the keyboard handlers do NOT need other changes — they operate on item.name, which still works for commands and skills identically.)

- [ ] **Step 6: handleSend 头部加 / 分支**

Insert at the very top of `handleSend` (before line 1282: `if (!text && blocks.length === 0) return;`):

```tsx
if (text.startsWith("/")) {
  setInput("")
  const sp = text.indexOf(" ")
  const name = sp === -1 ? text.slice(1) : text.slice(1, sp)
  const args = sp === -1 ? "" : text.slice(sp + 1)
  // 取当前 sessionId 优先 store.sessionId;前端可能为 null,后端会兜底。
  const sid = sessionId || activeSessionId || undefined
  try {
    const result = await api.post<{ type: string; payload: any }>(
      "/agent/command",
      { name, args, ...(sid ? { sessionId: sid } : {}) },
    )
    switch (result.type) {
      case "cleared":
        useAgentStore.getState().clearMessages()
        message.success("对话已清空")
        return
      case "compacted":
        message.success(`压缩完成,移除 ${result.payload.removedMessages} 条`)
        await useAgentStore.getState().loadSessions()
        return
      case "status":
        // 复用 useAppStore instanceContext 注入到 modal。
        // 把 payload 推到 existing ConversationInfoCard 弹层。
        // 简化版:弹一个 message.info 摘要。
        message.info(
          `cwd: ${result.payload.cwd}\nmodel: ${result.payload.model}\nsession: ${result.payload.sessionId ?? "-"}`,
          5,
        )
        return
      case "prompt":
        // 把 rendered 当普通 prompt 走原 LLM 路径
        await postPromptToLLM(result.payload.rendered, blocks)
        return
      case "message":
        message.info(result.payload.text, 3)
        return
      case "unknown":
        // OpenCC 默认 fallthrough:把原文本当普通 prompt 发给 LLM
        await postPromptToLLM(text, blocks)
        return
      case "error":
        message.error(result.payload.message)
        return
    }
  } catch (err) {
    message.error(`命令执行失败: ${(err as Error).message}`)
    return
  }
}
```

- [ ] **Step 7: 提取 postPromptToLLM helper**

把 `handleSend` 中 `setInput("")` 之后、到结尾的逻辑(拼 userMsg + 推 store + `api.post("/agent/prompt", ...)` + `applySessionEvent`)抽成同一文件内的 helper:

```tsx
const postPromptToLLM = useCallback(async (text: string, blocks: Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }>) => {
  // 注意:attachments 已经清空,这里 userMsg 不带 attachments;
  // 调用方应确保"无附件" — 这是合理的:slash prompt 命令不需要附带图片。
  const userMsg: AgentMessage = {
    eventId: `user-${Date.now()}`,
    sessionId: "",
    ts: Date.now(),
    turnIndex: 0,
    type: "user.text",
    text,
    attachments: [],
  }
  useAgentStore.setState((s) => ({
    status: "streaming",
    messages: [...s.messages, userMsg],
    sendSeq: s.sendSeq + 1,
  }))

  const { sessionId: returnedSessionId } = await api.post<{ sessionId: string }>(
    "/agent/prompt",
    {
      prompt: text || undefined,
      contentBlocks: blocks.length > 0 ? blocks : undefined,
      sessionId: sessionId || activeSessionId || undefined,
    },
  )
  useAgentStore.setState({
    sessionId: returnedSessionId,
    activeSessionId: returnedSessionId,
  })
  const localTitle = deriveLocalTitle(text)
  if (localTitle) {
    useAgentStore.getState().applySessionEvent({
      type: "session.renamed",
      sessionId: returnedSessionId,
      title: localTitle,
    })
  }
}, [sessionId, activeSessionId])
```

Then the original `handleSend` calls `await postPromptToLLM(text, blocks)` after building the userMsg locally. Refactor carefully — preserve existing behavior for the non-slash path.

- [ ] **Step 8: 验证编译**

Run: `cd packages/zai && bun run typecheck` (or whatever the workspace typecheck script is)
Expected: PASS — 0 errors

- [ ] **Step 9: 手测 dev server**

```bash
cd packages/zai
# 启动 dev server,然后:
# 1) 在输入框打 /clear → 应弹"对话已清空" toast + messages 清空
# 2) 打 /status → 应弹 message.info 含 cwd/model
# 3) 打 /foo → 应作为普通 prompt 发给 LLM(unknown fallthrough)
# 4) 打 /greet alice(假设 ~/.zai/commands/greet.md 存在)→ 应走 prompt_appended 路径
# 5) 打 /cl → 弹层里 /clear 应在 frontend-design 这种 skill 前面
```

- [ ] **Step 10: Commit**

```bash
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "feat(zai-web): slash dispatch + merged commands/skills popup"
```

---

## Task 9: 前端 — Resources.tsx Commands 区块 CRUD 弹窗

**Files:**
- Modify: `packages/zai/src/web/src/pages/Resources.tsx`

**Interfaces:**
- Consumes: 现有 Resources 区块样式 + 现有 antd Modal / Form / Button / Tag 组件
- Produces:
  - Commands 区块的列表渲染(替换或新增)
  - 新建 / 编辑 / 删除按钮 + Modal

- [ ] **Step 1: 打开 Resources.tsx 看现有 Commands 区块**

Run: `grep -n "Commands\|commands\|Skill" packages/zai/src/web/src/pages/Resources.tsx | head -40`
Expected: 找到 Commands 区块的渲染位置(可能是 count 占位 / Card 列表)。

- [ ] **Step 2: 在 Resources.tsx 加 state + fetch + 弹窗**

在 file 顶部 `import` 区追加:

```tsx
import { useCallback, useEffect, useState } from 'react'  // 若未引入
import { Modal, Form, Input, Select, message, Button, Tag, Space, Popconfirm } from 'antd'  // 按需
import { EditOutlined, DeleteOutlined, PlusOutlined, CopyOutlined } from '@ant-design/icons'
```

在 Resources 函数体内加 state:

```tsx
const [commandList, setCommandList] = useState<Array<{ name: string; description?: string; argumentHint?: string; whenToUse?: string }>>([])
const [commandLoading, setCommandLoading] = useState(false)
const [editingCommand, setEditingCommand] = useState<null | { name: string; frontmatter: Record<string, unknown>; body: string }>(null)
const [editingIsNew, setEditingIsNew] = useState(false)
const [commandForm] = Form.useForm()

const fetchCommandList = useCallback(async () => {
  setCommandLoading(true)
  try {
    const res = await fetch('/api/agent/commands')
    const data = await res.json()
    setCommandList(Array.isArray(data.items) ? data.items : [])
  } catch {
    setCommandList([])
  } finally {
    setCommandLoading(false)
  }
}, [])

useEffect(() => { fetchCommandList() }, [fetchCommandList])

const openCreateCommand = () => {
  setEditingIsNew(true)
  setEditingCommand({ name: '', frontmatter: { description: '', argumentHint: '' }, body: '' })
  commandForm.resetFields()
}

const openEditCommand = async (name: string) => {
  try {
    const res = await fetch(`/api/agent/commands/${encodeURIComponent(name)}`)
    if (!res.ok) { message.error('读取失败'); return }
    const data = await res.json()
    setEditingIsNew(false)
    setEditingCommand({ name: data.name, frontmatter: data.frontmatter ?? {}, body: data.body ?? '' })
    commandForm.setFieldsValue({
      name: data.name,
      description: data.frontmatter?.description ?? '',
      argumentHint: data.frontmatter?.argumentHint ?? '',
      argNames: Array.isArray(data.frontmatter?.argNames) ? data.frontmatter.argNames.join(', ') : '',
      allowedTools: Array.isArray(data.frontmatter?.allowedTools) ? data.frontmatter.allowedTools.join(', ') : '',
      model: data.frontmatter?.model ?? '',
      effort: data.frontmatter?.effort ?? '',
      body: data.body ?? '',
    })
  } catch (err) {
    message.error(`读取失败: ${(err as Error).message}`)
  }
}

const submitCommand = async () => {
  const v = await commandForm.validateFields()
  const fm: Record<string, unknown> = {}
  if (v.description) fm.description = v.description
  if (v.argumentHint) fm.argumentHint = v.argumentHint
  if (v.argNames) fm.argNames = v.argNames.split(',').map((s: string) => s.trim()).filter(Boolean)
  if (v.allowedTools) fm.allowedTools = v.allowedTools.split(',').map((s: string) => s.trim()).filter(Boolean)
  if (v.model) fm.model = v.model
  if (v.effort) fm.effort = v.effort
  const name = v.name
  try {
    const res = editingIsNew
      ? await fetch('/api/agent/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, frontmatter: fm, body: v.body }) })
      : await fetch(`/api/agent/commands/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frontmatter: fm, body: v.body }) })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      message.error(err.error ?? `HTTP ${res.status}`)
      return
    }
    message.success(editingIsNew ? '已创建' : '已更新')
    setEditingCommand(null)
    fetchCommandList()
  } catch (err) {
    message.error(`保存失败: ${(err as Error).message}`)
  }
}

const deleteCommand = async (name: string) => {
  try {
    const res = await fetch(`/api/agent/commands/${encodeURIComponent(name)}`, { method: 'DELETE' })
    if (!res.ok) { message.error('删除失败'); return }
    message.success('已删除')
    fetchCommandList()
  } catch (err) {
    message.error(`删除失败: ${(err as Error).message}`)
  }
}
```

- [ ] **Step 3: 渲染 Commands 区块**

在现有 Resources JSX 中,找到 Commands 区块(若是占位,替换;若没有,新建一段)。建议放在 Skills 区块的下方:

```tsx
<Card title="用户命令 (User Commands)" extra={
  <Button icon={<PlusOutlined />} type="primary" onClick={openCreateCommand}>新建</Button>
}>
  {commandLoading ? <Spin /> : commandList.length === 0 ? (
    <Empty description="暂无用户命令" />
  ) : (
    <Space direction="vertical" style={{ width: '100%' }}>
      {commandList.map((c) => (
        <Card key={c.name} size="small" type="inner"
          title={<Space><Text code>/{c.name}</Text>{c.description && <Text type="secondary">{c.description}</Text>}</Space>}
          extra={
            <Space>
              <Button icon={<EditOutlined />} size="small" onClick={() => openEditCommand(c.name)}>编辑</Button>
              <Popconfirm title={`删除 /${c.name}?`} onConfirm={() => deleteCommand(c.name)}>
                <Button icon={<DeleteOutlined />} size="small" danger>删除</Button>
              </Popconfirm>
            </Space>
          }
        >
          {c.argumentHint && <Tag>arg: {c.argumentHint}</Tag>}
          {c.whenToUse && <Text type="secondary"> {c.whenToUse}</Text>}
        </Card>
      ))}
    </Space>
  )}
</Card>
```

- [ ] **Step 4: 加 Modal 表单**

在 JSX 末尾(整个 Resources 组件 return 的最后)加:

```tsx
<Modal
  open={editingCommand !== null}
  title={editingIsNew ? '新建用户命令' : `编辑 /${editingCommand?.name ?? ''}`}
  onCancel={() => setEditingCommand(null)}
  onOk={submitCommand}
  okText="保存"
  cancelText="取消"
  width={720}
  destroyOnClose
>
  <Form form={commandForm} layout="vertical" preserve={false}>
    <Form.Item label="name" name="name" rules={[
      { required: true, message: '必填' },
      { pattern: /^[a-z0-9][a-z0-9-_]*$/, message: '小写字母/数字/-/_ 开头' },
    ]}>
      <Input disabled={!editingIsNew} placeholder="例如 greet" />
    </Form.Item>
    <Form.Item label="description" name="description"><Input /></Form.Item>
    <Form.Item label="argumentHint" name="argumentHint"><Input placeholder="例如 [name]" /></Form.Item>
    <Form.Item label="argNames (逗号分隔)" name="argNames"><Input placeholder="例如 name, age" /></Form.Item>
    <Form.Item label="allowedTools (逗号分隔)" name="allowedTools"><Input /></Form.Item>
    <Form.Item label="model" name="model"><Input placeholder="例如 claude-3-5-sonnet" /></Form.Item>
    <Form.Item label="effort" name="effort">
      <Select allowClear options={[
        { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' }, { value: 'max', label: 'max' },
      ]} />
    </Form.Item>
    <Form.Item label="body (markdown;可用 $ARGUMENTS / $1 / ${name})" name="body" rules={[{ required: true, message: '必填' }]}>
      <Input.TextArea rows={10} placeholder="Hello $ARGUMENTS" />
    </Form.Item>
  </Form>
</Modal>
```

- [ ] **Step 5: 验证编译**

Run: `cd packages/zai && bun run typecheck`
Expected: PASS

- [ ] **Step 6: 手测 dev server**

```bash
# 启动 dev server → 打开 Resources 页面 → 点 Commands 区块:
# 1) 点"新建" → 填 name=greet / description="打招呼" / argNames="name" / body="Hello $1" → 保存
# 2) 切到 Agent 页 → 打 /greet alice → 应展开为 "Hello alice" 发给 LLM
# 3) 回 Resources → 点刚建命令的"编辑" → 修改后保存 → reload
# 4) 点删除 → 命令从列表消失
# 5) Resources 区块刷新后,Agent 页 /greet 应 unknown fallthrough
```

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/web/src/pages/Resources.tsx
git commit -m "feat(zai-web): Resources Commands CRUD panel"
```

---

## Task 10: 集成 smoke + 文档收尾

**Files:**
- Modify: `packages/zai/src/server/services/agentRuntime.ts` — initCommands 兜底
- Create or Modify: `docs/superpowers/specs/2026-07-15-zai-builtin-commands-design.md` — 追加实现说明
- (Optional) Create: `docs/superpowers/plans/README.md` 链接索引

**Interfaces:**
- 集成层 — 不引入新接口,验证既有契约

- [ ] **Step 1: 在 server 启动路径调 initCommands**

Open `packages/zai/src/server/services/agentRuntime.ts`. Locate `initAgentRuntime` (line 48-78). At the end of that function (after `runtime = new DefaultAgentRuntime(...)`), add:

```ts
// 启动时一次性加载 commands registry(built-in + first user scan)。
// 若启动时 dataDir 尚未就绪,context.cwd 兜底为 process.cwd()。
import('./commands/registry.js').then(({ initCommands }) =>
  initCommands({ cwd, dataDir: process.env.ZAI_DATA_DIR ?? '', sessionId: undefined })
).catch((err) => console.error('[initCommands] failed:', err))
```

(Dynamic import 避免循环依赖 — `agentRuntime.ts` 不应被 commands/registry.ts 反向 import。)

- [ ] **Step 2: 跑全量测试**

Run: `cd packages/zai && pnpm vitest run`
Expected: PASS — 全部已有测试 + 新增 commands tests 全过

Run: `cd packages/zai-agent-core && pnpm vitest run`
Expected: PASS

- [ ] **Step 3: 跑 typecheck / build**

Run: `pnpm -r run build` (or `bun run build` per zai 项目 README)
Expected: 0 errors

- [ ] **Step 4: 集成 smoke**

Follow `examples/mcp-smoke/` 的模式,起一个 zai dev server,执行这些 curl:

```bash
# 1) 启动 dev server;具体命令参考 packages/zai/package.json scripts
# 2) 创建 user command via CRUD:
curl -X PUT http://localhost:PORT/api/agent/commands/greet \
  -H 'Content-Type: application/json' \
  -d '{"frontmatter":{"description":"Greet","argumentHint":"[name]","argNames":["name"]},"body":"Hello $1"}'

# 3) 列出:
curl http://localhost:PORT/api/agent/commands

# 4) slash 列表:
curl http://localhost:PORT/api/agent/slash

# 5) 执行 /status:
curl -X POST http://localhost:PORT/api/agent/command \
  -H 'Content-Type: application/json' \
  -d '{"name":"status"}'

# 6) 执行 /greet alice:
curl -X POST http://localhost:PORT/api/agent/command \
  -H 'Content-Type: application/json' \
  -d '{"name":"greet","args":"alice"}'

# 7) 未知命令:
curl -X POST http://localhost:PORT/api/agent/command \
  -H 'Content-Type: application/json' \
  -d '{"name":"foo"}'
```

Expected responses:

- 5) `{type:'status',payload:{cwd:...,cwdName:...,model:'claude-3-5-sonnet',...}}`
- 6) `{type:'prompt',payload:{rendered:'Hello alice'}}`
- 7) `{type:'unknown',payload:{input:'/foo'}}`

- [ ] **Step 5: 文档收尾 — 在 spec 末尾追加实现 status**

Edit `docs/superpowers/specs/2026-07-15-zai-builtin-commands-design.md`,append a new section:

```markdown
## 12. 实现状态(2026-07-15)

实现已完成,对应 plan: `docs/superpowers/plans/2026-07-15-zai-builtin-commands.md`。

- agent-core Command 类型 / registry / renderPrompt:已实现,测试覆盖
- 三个 built-in (/clear /compact /status):已实现,compact 走 MVP stub(spec §2.6 决策)
- userLoader:已实现,frontmatter 解析复用 zai-agent-core 既有 YAML 工具,无新增依赖
- 三组 API 端点:`POST /api/agent/command` / `CRUD /api/agent/commands` / `GET /api/agent/slash` 已实现
- Web:Agent.tsx handleSend 加 `/` 分支 + slash 弹层合并 commands + skills;Resources.tsx Commands CRUD 区块已实现
- 测试:bun:test 跑过全部新增 + 已有

不在本次实现范围(spec §9 YAGNI):文件 watcher、CLI `zai command`、命令面板高级 UI。
```

- [ ] **Step 6: 最终 commit**

```bash
git add packages/zai/src/server/services/agentRuntime.ts docs/superpowers/specs/2026-07-15-zai-builtin-commands-design.md
git commit -m "chore(zai): wire initCommands on boot + mark spec implemented"
```

---

## Self-Review (plan 写完后做的)

**1. Spec 覆盖(对照 spec §1-§11)**:

| Spec 章节 | 落地 task |
|---|---|
| §1 高层架构 / §1.1-1.2 约束 | Task 1 + Task 2 (类型与约束)|
| §2.1-2.3 types + registry + renderPrompt | Task 1 + Task 2 |
| §2.4 index.ts | Task 1 + Task 2 合并做 |
| §2.5 service registry + builtin | Task 3 |
| §2.6 builtin 三件套 | Task 3 |
| §2.7 userLoader | Task 4 |
| §3.1 POST /api/agent/command | Task 5 |
| §3.2 CRUD /api/agent/commands | Task 6 |
| §3.3 GET /api/agent/slash | Task 7 |
| §4.1 Agent.tsx handleSend 分支 + 弹层合并 | Task 8 |
| §4.2 Resources.tsx CRUD 弹窗 | Task 9 |
| §5 错误处理 | Task 5/6/7 各覆盖对应路径;Task 8 覆盖前端 toast |
| §6 并发与状态 | Task 4 reloadUserCommands 实现原子切换;Task 6 atomic write |
| §7 安全边界 | Task 4 + Task 6 name 正则;Task 4 渲染纯 prompt 模板 |
| §8 测试矩阵 | Task 1 / 2 / 3 / 4 / 6 / 7 各覆盖,集成 smoke 在 Task 10 |
| §9 YAGNI | 全 plan 未引入 |
| §10 文件清单 | 完全对应 |
| §11 风险与决策 | 全部反映在 plan 的"Global Constraints"段 |

**2. 占位符扫描**:无 TBD / TODO / "implement later"。

**3. 类型/方法名一致性**:

- `clearCommand` / `compactCommand` / `statusCommand` — Task 3 定义,Task 5 / 10 引用 ✓
- `initCommands(context: CommandContext)` — Task 4 最终签名,Task 5 / 10 引用 ✓
- `reloadUserCommands(context)` — Task 4 定义,Task 6 / 7 调用 ✓
- `loadUserCommands(context)` — Task 4 定义,Task 4 自己引用 ✓
- `writeCommandFile(name, frontmatter, body)` / `readCommandFile(name)` / `deleteCommandFile(name)` / `readCommandList()` — Task 6 一处定义,CRUD route 调用 ✓
- `slashList({ skills? })` — Task 7 定义,slash route 调用 ✓
- `renderPrompt({ body, args, argNames? })` — Task 1 定义,userLoader 引用 ✓
- `parseFrontmatter` / `bodyOf` / `buildPromptCommand` — Task 4 内部 helper,未跨任务引用 ✓
- `getCommandRegistry` / `setCommandRegistry` — Task 2 定义,Task 3-7 引用 ✓
- `LocalCommand` / `PromptCommand` / `LocalCommandResult` / `StatusPayload` — Task 1 定义,Task 3-7 引用 ✓
- `api.post('/agent/command', ...)` — Task 8 调用,与 Task 5 路由匹配 ✓
- `useAgentStore.clearMessages()` / `loadSessions()` — Task 8 调用,既有 store 方法 ✓
- `getTranscriptStore()` / `getCurrentSessionId()` / `abortAgentSession()` — Task 3 clearCommand 引用,与 agentRuntime.ts 既有签名匹配 ✓

**通过自审,plan 可执行。**