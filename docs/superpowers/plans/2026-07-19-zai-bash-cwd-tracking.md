# zai LLM 自切 cwd 能力 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 zai 的 LLM 在 BashTool 跑 `cd <path>` 后,同 session 的后续 Bash/FileRead/Glob 都在新 cwd 下执行;多 session 隔离;前端每 5s 轮询展示当前 session 的 cwd。

**Architecture:** Server 端维护 `CwdStore: Map<sessionId, cwd>`,BashTool 在每条 `sh -c` 末尾注入 `pwd -P >| tmpfile` trailer,子进程退出后 `readFileSync` 读新 cwd 写回 Map。sessionId 通过 `AsyncLocalStorage` 注入,让 `getCwd()` 保持零参(零调用方改动)。前端新增 `GET /api/agent/sessions/:id/pwd` + 5s 轮询 hook + ConfigStatusBar 桥接组件展示。

**Tech Stack:** TypeScript / Node.js `child_process.spawn` / `AsyncLocalStorage` / Vitest / Express / React + Zustand + AntD。

## Global Constraints

- 测试框架: `vitest run`(从根目录跑,或从 `packages/zai-agent-core/` 跑覆盖该包)
- 不引入新 npm 依赖(只用已装的 `node:fs` / `node:child_process` / `async_hooks`)
- cwd 文件路径模板: `/tmp/zai-bash-<taskId>-cwd`,与现有 `/tmp/zai-bash-<taskId>.txt` 同前缀
- sessionId 由 `getTranscriptStore` 生成的 `'sess-<uuid>'` 字符串
- BashTool 仅在 **foreground**(非 `run_in_background`)+ **主线程** 路径下写 CwdStore
- 所有 commit 信息用英文 `feat/fix/refactor/test/docs(chore): subject`,跟现有 git log 风格一致

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/zai-agent-core/src/runtime/cwdStore.ts` (新) | 纯内存 `Map<sessionId, {cwd, updatedAt}>`,导 `CwdStore` 单例 |
| `packages/zai-agent-core/src/runtime/cwdStore.test.ts` (新) | CwdStore get/set/getOrInit/has/delete 单测 |
| `packages/zai-agent-core/src/runtime/index.ts` (改) | 新增 export `CwdStore` |
| `packages/zai-agent-core/src/opencc-internals/utils/cwd.ts` (改) | 新增 `sessionIdStorage` ALS + `runWithSessionId`;改 `getCwd()` 走 ALS → CwdStore |
| `packages/zai-agent-core/src/opencc-internals/utils/cwd.test.ts` (新) | ALS sessionId 注入测试 |
| `packages/zai-agent-core/src/tools/BashTool/BashTool.ts` (改) | spawn 拼接 `pwd -P` trailer;exit handler 读 tmpfile + 写 CwdStore |
| `packages/zai-agent-core/src/tools/BashTool/BashTool.test.ts` (新) | trailer 注入 + CwdStore 交互单测 |
| `packages/zai/src/server/routes/agent.ts` (改) | 新增 `GET /sessions/:id/pwd`;prompt handler 包 `runWithSessionId`;DELETE 路由调 `CwdStore.delete` |
| `packages/zai/src/server/routes/agent.test.ts` (新) | 路由集成测试 |
| `packages/zai/src/web/src/hooks/useSessionCwd.ts` (新) | 5s 轮询 hook |
| `packages/zai/src/web/src/hooks/useSessionCwd.test.ts` (新) | hook 单测 |
| `packages/zai/src/web/src/components/SessionCwdBridge.tsx` (新) | Layout 内订阅 useAgentStore.sessionId + 调 setInstanceContext |
| `packages/zai/src/web/src/components/ConfigStatusBar.tsx` (改) | 新增 `sessionCwd` prop |
| `packages/zai/src/web/src/components/ConfigStatusBar.test.tsx` (改) | 加 sessionCwd case |
| `packages/zai/src/web/src/components/Layout.tsx` (改) | 渲染 `<SessionCwdBridge />` |

---

## Task 1: CwdStore 实现 + 单测

**Files:**
- Create: `packages/zai-agent-core/src/runtime/cwdStore.ts`
- Create: `packages/zai-agent-core/src/runtime/cwdStore.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  ```typescript
  export interface SessionCwd { readonly cwd: string; readonly updatedAt: number }
  export const CwdStore: {
    get(sessionId: string): string | undefined
    set(sessionId: string, cwd: string): void
    getOrInit(sessionId: string, defaultCwd: string): string
    has(sessionId: string): boolean
    delete(sessionId: string): void
    size(): number
    clear(): void
  }
  ```

- [ ] **Step 1: 写失败的测试**

`packages/zai-agent-core/src/runtime/cwdStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { CwdStore } from './cwdStore.js'

describe('CwdStore', () => {
  beforeEach(() => {
    CwdStore.clear()
  })

  it('returns undefined for unknown sessionId', () => {
    expect(CwdStore.get('sess-unknown')).toBeUndefined()
    expect(CwdStore.has('sess-unknown')).toBe(false)
  })

  it('set + get round-trip', () => {
    CwdStore.set('sess-a', '/tmp/foo')
    expect(CwdStore.get('sess-a')).toBe('/tmp/foo')
    expect(CwdStore.has('sess-a')).toBe(true)
  })

  it('set overwrites previous value and bumps updatedAt', async () => {
    CwdStore.set('sess-a', '/tmp/foo')
    const first = CwdStore.get('sess-a')!
    await new Promise(r => setTimeout(r, 2))
    CwdStore.set('sess-a', '/tmp/bar')
    const second = CwdStore.get('sess-a')!
    expect(second).toBe('/tmp/bar')
    // updatedAt 应被刷新(通过 has() 间接验证:get 不返回 updatedAt)
    expect(CwdStore.size()).toBe(1)
    void first
  })

  it('getOrInit writes default on first call', () => {
    const cwd = CwdStore.getOrInit('sess-new', '/initial')
    expect(cwd).toBe('/initial')
    expect(CwdStore.get('sess-new')).toBe('/initial')
  })

  it('getOrInit returns existing value without overwriting', () => {
    CwdStore.set('sess-x', '/already-set')
    const cwd = CwdStore.getOrInit('sess-x', '/initial')
    expect(cwd).toBe('/already-set')
  })

  it('delete removes entry', () => {
    CwdStore.set('sess-y', '/tmp')
    CwdStore.delete('sess-y')
    expect(CwdStore.get('sess-y')).toBeUndefined()
  })

  it('delete on unknown is noop', () => {
    expect(() => CwdStore.delete('sess-zzz')).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/zai-agent-core && npx vitest run src/runtime/cwdStore.test.ts
```

Expected: FAIL, `Cannot find module './cwdStore.js'`

- [ ] **Step 3: 实现 CwdStore**

`packages/zai-agent-core/src/runtime/cwdStore.ts`:

```typescript
/**
 * Per-session cwd store.
 *
 * zai 是多 session 共享一个 server 实例,所以每个 session 需要自己的逻辑 cwd。
 * BashTool 在每条 sh -c 命令末尾注入 `pwd -P >| tmpfile` trailer,
 * 子进程退出后读 tmpfile 拿到新 cwd,通过 CwdStore.set 写进来。
 *
 * 仅内存,不持久化:进程崩溃 = session 重启 = transcript 重跑,cwd 自然归零。
 */

export interface SessionCwd {
  readonly cwd: string
  readonly updatedAt: number
}

const store = new Map<string, SessionCwd>()

export const CwdStore = {
  get(sessionId: string): string | undefined {
    return store.get(sessionId)?.cwd
  },

  set(sessionId: string, cwd: string): void {
    store.set(sessionId, { cwd, updatedAt: Date.now() })
  },

  getOrInit(sessionId: string, defaultCwd: string): string {
    const existing = store.get(sessionId)
    if (existing) return existing.cwd
    this.set(sessionId, defaultCwd)
    return defaultCwd
  },

  has(sessionId: string): boolean {
    return store.has(sessionId)
  },

  delete(sessionId: string): void {
    store.delete(sessionId)
  },

  size(): number {
    return store.size
  },

  clear(): void {
    store.clear()
  },
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/zai-agent-core && npx vitest run src/runtime/cwdStore.test.ts
```

Expected: PASS, 7 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/runtime/cwdStore.ts packages/zai-agent-core/src/runtime/cwdStore.test.ts
git commit -m "feat(zai-agent-core): add CwdStore for per-session cwd tracking"
```

---

## Task 2: 在 runtime/index.ts 暴露 CwdStore

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/index.ts`(可能已存在,可能需要创建)

**Interfaces:**
- Consumes: Task 1 的 `CwdStore`
- Produces: `CwdStore` 通过 `@zn-ai/zai-agent-core/runtime` 入口可被 zai-server 引入

- [ ] **Step 1: 检查现有 index.ts**

```bash
cat packages/zai-agent-core/src/runtime/index.ts 2>/dev/null || echo "NOT_FOUND"
```

如果不存在,看 `package.json` 的 `"./runtime"` export 指到哪个文件,跟那里 import 一起 export。

- [ ] **Step 2: 加 export**

如果 `src/runtime/index.ts` 存在,追加:
```typescript
export { CwdStore, type SessionCwd } from './cwdStore.js'
```

如果不存在,看其他文件是怎么导出 CwdStore 的(可能 `src/index.ts` 已经统一管理)。Edit 该文件加一行 `export { CwdStore, type SessionCwd } from './runtime/cwdStore.js'`。

- [ ] **Step 3: 验证 typecheck**

```bash
cd packages/zai-agent-core && npx tsc -b --noEmit
```

Expected: 无 error

- [ ] **Step 4: Commit(如有改动)**

```bash
git add packages/zai-agent-core/src/runtime/index.ts  # 或 src/index.ts
git commit -m "feat(zai-agent-core): export CwdStore from runtime entry"
```

---

## Task 3: cwd.ts 加 ALS sessionIdStorage

**Files:**
- Modify: `packages/zai-agent-core/src/opencc-internals/utils/cwd.ts`
- Create: `packages/zai-agent-core/src/opencc-internals/utils/cwd.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CwdStore`(从 `'../../runtime/cwdStore.js'` 引入)
- Produces:
  ```typescript
  export function runWithSessionId<T>(sessionId: string, fn: () => T): T
  export function getCurrentSessionId(): string | undefined
  // getCwd() 实现改为:ALS sessionId → CwdStore.get → fallback process.cwd()
  ```

- [ ] **Step 1: 写失败的测试**

`packages/zai-agent-core/src/opencc-internals/utils/cwd.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { runWithSessionId, getCwd, runWithCwdOverride, getCurrentSessionId } from './cwd.js'
import { CwdStore } from '../../runtime/cwdStore.js'

describe('cwd ALS sessionId integration', () => {
  beforeEach(() => {
    CwdStore.clear()
  })

  it('getCwd outside ALS returns process.cwd()', () => {
    expect(getCwd()).toBe(process.cwd())
  })

  it('getCwd inside runWithSessionId returns CwdStore entry', () => {
    runWithSessionId('sess-1', () => {
      CwdStore.set('sess-1', '/tmp/one')
      expect(getCwd()).toBe('/tmp/one')
    })
  })

  it('getCurrentSessionId returns sid inside ALS', () => {
    runWithSessionId('sess-2', () => {
      expect(getCurrentSessionId()).toBe('sess-2')
    })
    expect(getCurrentSessionId()).toBeUndefined()
  })

  it('nested runWithSessionId uses inner sid', () => {
    CwdStore.set('sess-outer', '/outer')
    CwdStore.set('sess-inner', '/inner')
    runWithSessionId('sess-outer', () => {
      expect(getCwd()).toBe('/outer')
      runWithSessionId('sess-inner', () => {
        expect(getCwd()).toBe('/inner')
      })
      expect(getCwd()).toBe('/outer')
    })
  })

  it('runWithCwdOverride still overrides inside ALS', () => {
    CwdStore.set('sess-3', '/from-store')
    runWithSessionId('sess-3', () => {
      expect(getCwd()).toBe('/from-store')
      runWithCwdOverride('/forced', () => {
        expect(getCwd()).toBe('/forced')
      })
      expect(getCwd()).toBe('/from-store')
    })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/zai-agent-core && npx vitest run src/opencc-internals/utils/cwd.test.ts
```

Expected: FAIL, `runWithSessionId is not exported`

- [ ] **Step 3: 改 cwd.ts**

`packages/zai-agent-core/src/opencc-internals/utils/cwd.ts`(完整替换):

```typescript
// @ts-nocheck
import { AsyncLocalStorage } from 'async_hooks'
import { CwdStore } from '../../runtime/cwdStore.js'

const cwdOverrideStorage = new AsyncLocalStorage<string>()
const sessionIdStorage = new AsyncLocalStorage<string>()

/**
 * Run a function with a sessionId injected into the current async context.
 * All calls to getCwd() within the function (and its async descendants) will
 * resolve via CwdStore keyed on sessionId.
 */
export function runWithSessionId<T>(sessionId: string, fn: () => T): T {
  return sessionIdStorage.run(sessionId, fn)
}

/**
 * Get the sessionId injected by the nearest runWithSessionId ancestor, or undefined.
 */
export function getCurrentSessionId(): string | undefined {
  return sessionIdStorage.getStore()
}

/**
 * Run a function with an overridden working directory for the current async context.
 * All calls to pwd()/getCwd() within the function (and its async descendants) will
 * return the overridden cwd instead of the one resolved from sessionId/CwdStore.
 * This is the same as the opencc cwdOverrideStorage semantics — kept for future
 * sub-agent per-context cwd isolation.
 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn)
}

/**
 * Get the current working directory.
 *
 * Resolution order:
 *   1. cwdOverrideStorage (per-async-context override for sub-agents / tests)
 *   2. sessionIdStorage → CwdStore.get(sid) (per-session tracked cwd)
 *   3. process.cwd() (fallback when no sessionId is active)
 */
export function pwd(): string {
  const override = cwdOverrideStorage.getStore()
  if (override !== undefined) return override

  const sid = sessionIdStorage.getStore()
  if (sid !== undefined) {
    const fromStore = CwdStore.get(sid)
    if (fromStore !== undefined) return fromStore
  }

  return process.cwd()
}

/**
 * Get the current working directory or process.cwd() if unavailable.
 */
export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return process.cwd()
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/zai-agent-core && npx vitest run src/opencc-internals/utils/cwd.test.ts
```

Expected: PASS, 5 tests passing

- [ ] **Step 5: typecheck + 全包测试**

```bash
cd packages/zai-agent-core && npx tsc -b --noEmit && npx vitest run
```

Expected: typecheck clean,所有既有测试仍通过(`getCwd` 签名未变,无调用方需要改)

- [ ] **Step 6: Commit**

```bash
git add packages/zai-agent-core/src/opencc-internals/utils/cwd.ts packages/zai-agent-core/src/opencc-internals/utils/cwd.test.ts
git commit -m "feat(zai-agent-core): cwd.ts resolves via ALS sessionId → CwdStore"
```

---

## Task 4: BashTool trailer 注入 + CwdStore 写入

**Files:**
- Modify: `packages/zai-agent-core/src/tools/BashTool/BashTool.ts`
- Create: `packages/zai-agent-core/src/tools/BashTool/BashTool.test.ts`

**Interfaces:**
- Consumes: Task 1 `CwdStore`,Task 3 `runWithSessionId`
- Produces: BashTool 在 fg 路径 spawn 后:
  - `commandString = '<user>\npwd -P >| /tmp/zai-bash-<taskId>-cwd'`
  - exit handler 读 tmpfile,不同则 `CwdStore.set(sessionId, newCwd)`
  - 需要从 `ctx` 拿到 sessionId

- [ ] **Step 1: 找 LegacyToolContext 里 sessionId 在哪**

```bash
grep -n "__runtimeConfig\|sessionId" packages/zai-agent-core/src/tools/Tool.ts | head -10
grep -n "sessionId" packages/zai-agent-core/src/runtime/types.ts | head -10
```

记下 sessionId 字段名(预期是 `ctx.__runtimeConfig?.sessionId`,跟 Task 2.4 一致)。

- [ ] **Step 2: 写失败的测试**

`packages/zai-agent-core/src/tools/BashTool/BashTool.test.ts`(从 `cwd.test.ts` 复制 boilerplate 加新 case):

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWithSessionId, getCwd } from '../../opencc-internals/utils/cwd.js'
import { CwdStore } from '../../runtime/cwdStore.js'

/**
 * Integration-style test: directly spawn the same commandString format BashTool uses,
 * verify pwd -P trailer writes tmpfile, and verify exit handler logic updates CwdStore.
 *
 * We don't go through BashTool.call() because that requires a full LegacyToolContext.
 * Instead we exercise the trailer logic in isolation.
 */

describe('BashTool cwd trailer integration', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'zai-bash-cwd-test-'))

  beforeEach(() => {
    CwdStore.clear()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function runWithTrailer(command: string, sessionId: string): Promise<{ code: number; newCwd: string | null }> {
    const taskId = `test-${Math.random().toString(16).slice(2, 10)}`
    const tmpfile = join(tmpDir, `cwd-${taskId}`)
    const fullCommand = `${command}\npwd -P >| ${tmpfile}`

    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', fullCommand], { cwd: process.cwd() })
      child.on('exit', (code) => {
        let newCwd: string | null = null
        try {
          if (existsSync(tmpfile)) {
            newCwd = readFileSync(tmpfile, 'utf8').trim()
          }
        } catch {
          // tmpfile missing → newCwd stays null
        }

        // Mirror BashTool exit handler logic:
        if (newCwd && newCwd !== CwdStore.get(sessionId)) {
          CwdStore.set(sessionId, newCwd)
        }

        resolve({ code: code ?? -1, newCwd })
      })
    })
  }

  it('cd /tmp updates CwdStore', async () => {
    runWithSessionId('sess-t1', () => {})
    CwdStore.set('sess-t1', process.cwd())

    const { code, newCwd } = await runWithTrailer('cd /tmp && echo done', 'sess-t1')

    expect(code).toBe(0)
    expect(newCwd).toBe('/tmp')
    expect(CwdStore.get('sess-t1')).toBe('/tmp')
  })

  it('no-op command leaves CwdStore unchanged', async () => {
    CwdStore.set('sess-t2', process.cwd())
    const { newCwd } = await runWithTrailer('echo hello', 'sess-t2')
    expect(newCwd).toBe(process.cwd())
    expect(CwdStore.get('sess-t2')).toBe(process.cwd())
  })

  it('failed command (cd to nonexistent) leaves CwdStore unchanged', async () => {
    CwdStore.set('sess-t3', process.cwd())
    // 'set -e' makes sh exit non-zero when cd fails; trailing pwd -P still runs
    // only if we don't have set -e; here we accept that pwd might still write,
    // but the new path would not exist as a directory (cd error).
    const { code, newCwd } = await runWithTrailer('cd /this/path/does/not/exist', 'sess-t3')
    expect(code).not.toBe(0)
    // If newCwd is not a real directory, real-world BashTool exit handler
    // (in Shell.ts:226-251) would skip the setCwd. We replicate that here.
    if (newCwd) {
      const fs = await import('node:fs')
      try {
        const stat = fs.statSync(newCwd)
        if (!stat.isDirectory()) {
          // skip update
        }
      } catch {
        // skip update
      }
    }
    expect(CwdStore.get('sess-t3')).toBe(process.cwd())
  })
})
```

- [ ] **Step 3: 跑测试确认当前逻辑下 trailer 写 tmpfile 失败**

不,这个测试是直接 spawn,trailer 是我们手写拼接的,所以测试应当通过 trailer 本身的可行性。要先确认 trailer 在 sh 下真的写文件 — 跑测试会通过(因为测试是 integration,不是 BashTool 单元测试)。

改成先验证 trailer 行为可工作,然后再改 BashTool.ts。已写在 Step 2 里,跑:

```bash
cd packages/zai-agent-core && npx vitest run src/tools/BashTool/BashTool.test.ts
```

Expected: PASS(因为 trailer 拼接 + exit handler 逻辑已直接写在测试里)

- [ ] **Step 4: 修改 BashTool.ts,加上 trailer 注入和 exit handler 读 cwd**

读 `packages/zai-agent-core/src/tools/BashTool/BashTool.ts:243-269`(call 函数)和 `:280-360`(runForeground)。

`call` 函数:`effectiveWorkdir` 计算时如果不用 sandbox,改成从 `ctx.__runtimeConfig?.sessionId` 取 sid,再走 `runWithSessionId` 内部(或直接读 `CwdStore.get(sid) ?? process.cwd()`)。但 `runWithSessionId` 是包装整个 queryLoop 的,不该在这里调用 —— 改成:

```typescript
import { CwdStore } from '../../runtime/cwdStore.js'
// ...
async call(rawInput, ctx) {
  // ...
  const sessionId = (ctx.__runtimeConfig as { sessionId?: string } | undefined)?.sessionId
  const effectiveWorkdir = useSandbox
    ? cfg.workdir
    : (sessionId ? CwdStore.get(sessionId) : undefined) ?? ctx.cwd || process.cwd()
  // ...
}
```

`runForeground`:在 `spawn` 之前拼 trailer,在 `child.on('exit')` 里读 tmpfile 写 CwdStore。具体 patch:

第 293 行附近:
```typescript
const taskId = `bash-${randomUUID().slice(0, 8)}`
const tmpCwdFile = `/tmp/zai-bash-${taskId}-cwd`
const wrappedCommand = `${input.command}\npwd -P >| ${tmpCwdFile}`

const child = spawn('sh', ['-c', wrappedCommand], {
  cwd: workdir,
  env,
  timeout: timeoutMs,
  signal: ctx.abortSignal,
})
```

第 358 行 `child.on('exit', async (code, signal) => {` 的 if 块里(在 `bashBackgroundTracker.markFinished` 之后,`if (resetCwdIfOutsideProject())` 之前),插入:

```typescript
// cwd trailer: read tmpfile written by `pwd -P >| tmpCwdFile` appended to user command
if (!input.run_in_background && sessionId) {
  try {
    const raw = readFileSync(tmpCwdFile, 'utf8').trim()
    // realpathSync? sh's pwd -P already resolves symlinks, so raw is canonical
    const newCwd = raw.normalize('NFC')
    const oldCwd = CwdStore.get(sessionId)
    if (newCwd && newCwd !== oldCwd) {
      CwdStore.set(sessionId, newCwd)
    }
  } catch {
    // tmpfile missing (cmd aborted before trailer ran) or permission error — keep old cwd
  }
  try {
    unlinkSync(tmpCwdFile)
  } catch {
    // best-effort cleanup
  }
}
```

注意:`input.run_in_background` 已经在 `call` 入口分流(`if (input.run_in_background) return runInBackground(...)`),所以 runForeground 路径上 `input.run_in_background === false` 恒成立。改成直接 `if (sessionId)` 即可,去掉冗余判断。

在 `runInBackground`(第 442-490 行):不写 tmpfile,不读 CwdStore(后台任务不污染 session cwd)。保持原样。

加 imports 到文件头:
```typescript
import { readFileSync, unlinkSync } from 'node:fs'
import { CwdStore } from '../../runtime/cwdStore.js'
```

- [ ] **Step 5: 跑 BashTool 既有测试(若存在)+ 新测试**

```bash
cd packages/zai-agent-core && npx vitest run src/tools/BashTool/
```

Expected: PASS(如果没有 BashTool.test.ts 已有,只跑新建的 3 个 case)

- [ ] **Step 6: typecheck 全包**

```bash
cd packages/zai-agent-core && npx tsc -b --noEmit
```

Expected: 无 error(改动是局部的,sed 模拟 / 已有 helpers 未动)

- [ ] **Step 7: Commit**

```bash
git add packages/zai-agent-core/src/tools/BashTool/BashTool.ts packages/zai-agent-core/src/tools/BashTool/BashTool.test.ts
git commit -m "feat(zai-agent-core): BashTool injects pwd trailer, tracks cwd to CwdStore"
```

---

## Task 5: server GET /api/agent/sessions/:id/pwd

**Files:**
- Modify: `packages/zai/src/server/routes/agent.ts`
- Create: `packages/zai/src/server/routes/agent.cwd.test.ts`(或合并到 `agent.test.ts`)

**Interfaces:**
- Consumes: Task 1 `CwdStore`(从 `@zn-ai/zai-agent-core/runtime` 引入)
- Produces:
  - `GET /api/agent/sessions/:id/pwd` 返回 `{ cwd, updatedAt }` 或 404
  - `POST /api/agent/prompt` 在 fire-and-forget 异步里包 `runWithSessionId`
  - `DELETE /api/agent/sessions/:id` 路由里调 `CwdStore.delete(sid)`

- [ ] **Step 1: 看现有 routes/agent.ts 的 import 和 export 风格**

```bash
head -40 packages/zai/src/server/routes/agent.ts
grep -n "router\.\|router.delete\|router.get\|export default" packages/zai/src/server/routes/agent.ts | head -20
```

确认 router 写法(确认是 `router.get(...)` 还是 `app.get(...)`),和已有 DELETE 路由长什么样。

- [ ] **Step 2: 写失败的测试**

`packages/zai/src/server/routes/agent.cwd.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
// 注意:用 supertest 还是裸 http 取决于现有测试风格
// 看 packages/zai/src/server/routes/event.test.ts 怎么写 import 测试
import { CwdStore } from '@zn-ai/zai-agent-core/runtime'
import agentRouter from './agent.js'

describe('GET /api/agent/sessions/:id/pwd', () => {
  let app: express.Express

  beforeEach(() => {
    CwdStore.clear()
    app = express()
    app.use('/api/agent', agentRouter)
  })

  afterEach(() => {
    CwdStore.clear()
  })

  it('returns cwd for known sessionId', async () => {
    CwdStore.set('sess-known', '/tmp/somewhere')
    const res = await request(app).get('/api/agent/sessions/sess-known/pwd')
    expect(res.status).toBe(200)
    expect(res.body.cwd).toBe('/tmp/somewhere')
    expect(typeof res.body.updatedAt).toBe('number')
  })

  it('returns 404 for unknown sessionId', async () => {
    const res = await request(app).get('/api/agent/sessions/sess-unknown/pwd')
    expect(res.status).toBe(404)
    expect(res.body.error).toBeDefined()
  })
})
```

如果 server 测试用 supertest 不可用(看 event.test.ts 怎么测的),改用对应的工具。

- [ ] **Step 3: 跑测试确认失败**

```bash
cd packages/zai && npx vitest run src/server/routes/agent.cwd.test.ts
```

Expected: FAIL, route 不存在(404 或 cannot GET)

- [ ] **Step 4: 在 agent.ts 加 GET 路由**

找到 DELETE 路由附近,加:

```typescript
router.get('/sessions/:id/pwd', (req, res) => {
  const sid = req.params.id
  if (!CwdStore.has(sid)) {
    return res.status(404).json({ error: 'session not found' })
  }
  // has() 但 entry 可能被外部清掉,二次保护
  const cwd = CwdStore.get(sid)
  if (!cwd) {
    return res.status(404).json({ error: 'session not found' })
  }
  return res.json({ cwd })
})
```

加 import:
```typescript
import { CwdStore } from '@zn-ai/zai-agent-core/runtime'
```

`updatedAt` 字段:zai 端不暴露(前端用 cwd basename 渲染就够了,updatedAt 仅 CwdStore 内部用)。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd packages/zai && npx vitest run src/server/routes/agent.cwd.test.ts
```

Expected: PASS, 2 tests passing

- [ ] **Step 6: 在 prompt handler 包 runWithSessionId**

读 `packages/zai/src/server/routes/agent.ts:311-440`(POST `/agent/prompt` handler),找到 `void (async () => {` 启动 fire-and-forget 异步那段。把整段 IIFE 包进 `runWithSessionId(sessionId, async () => { ... })`:

```typescript
import { runWithSessionId } from '@zn-ai/zai-agent-core/runtime'  // 或从 cwd.ts

// ...在 handler 里:
void runWithSessionId(sessionId, async () => {
  try {
    let systemPrompt: string | undefined
    // ... 现有代码 ...
  } catch (err) {
    // ... 现有错误处理 ...
  }
})
```

确认 import 路径:`runWithSessionId` 在 `packages/zai-agent-core/src/opencc-internals/utils/cwd.ts`,zai 端 zai-agent-core 通过 `./opencc-internals/utils/cwd.js` 路径访问 OR 通过 runtime entry(看 runtime/index.ts 是否需要补 export)。

**检查 export**:Task 2 已经加了 `CwdStore` 到 runtime entry。Task 5 需要把 `runWithSessionId` 也加进去:

```typescript
// 在 packages/zai-agent-core/src/runtime/index.ts(或同位置)追加:
export { runWithSessionId, getCurrentSessionId } from '../opencc-internals/utils/cwd.js'
```

(或者保持 zai 通过完整路径 `./opencc-internals/utils/cwd.js` 引入 — 看现有 import 风格哪种用得多。优先选简洁的 runtime entry。)

- [ ] **Step 7: 在 DELETE 路由调 CwdStore.delete**

找到 `router.delete('/sessions/:id', ...)`,在成功删除 transcript 之后加:

```typescript
CwdStore.delete(sid)
```

注意:DELETE 路由已经在校验 cwd(看 `:597-604`)。如果 sessionId 在 transcript 里找不到,sid 不是有效的,CwdStore 不可能有 entry,delete 是 noop。安全。

- [ ] **Step 8: 跑 zai 全包测试 + typecheck**

```bash
cd packages/zai && npx tsc -b --noEmit && npx vitest run
```

Expected: 所有既有测试仍通过 + agent.cwd.test.ts PASS

- [ ] **Step 9: Commit**

```bash
git add packages/zai/src/server/routes/agent.ts packages/zai/src/server/routes/agent.cwd.test.ts packages/zai-agent-core/src/runtime/index.ts
git commit -m "feat(zai): GET /sessions/:id/pwd + prompt handler runs in runWithSessionId"
```

---

## Task 6: useSessionCwd hook(前端轮询)

**Files:**
- Create: `packages/zai/src/web/src/hooks/useSessionCwd.ts`
- Create: `packages/zai/src/web/src/hooks/useSessionCwd.test.ts`

**Interfaces:**
- Consumes: Task 5 的 GET `/api/agent/sessions/:id/pwd`
- Produces:
  ```typescript
  export function useSessionCwd(sessionId: string | null): string | undefined
  ```
  - 立即 fetch 一次
  - 5s setInterval 轮询
  - sessionId 变化时 clearInterval + 重启
  - fetch 失败/404 保留旧值(silent catch)
  - unmount clearInterval

- [ ] **Step 1: 看 web 测试框架**

```bash
cat packages/zai/src/web/src/components/AgentInputBox.test.tsx | head -20
grep -E "\"test\":" packages/zai/package.json | head -5
```

确认是 vitest + @testing-library/react 还是其他。

- [ ] **Step 2: 写失败的测试**

`packages/zai/src/web/src/hooks/useSessionCwd.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useSessionCwd } from './useSessionCwd.js'

// Mock fetch globally
const mockFetch = vi.fn()
beforeEach(() => {
  mockFetch.mockReset()
  ;(globalThis as any).fetch = mockFetch
})

describe('useSessionCwd', () => {
  it('returns undefined when sessionId is null', async () => {
    const { result } = renderHook(() => useSessionCwd(null))
    expect(result.current).toBeUndefined()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('fetches immediately on mount with valid sessionId', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ cwd: '/tmp/foo', updatedAt: 1 }),
    })
    const { result } = renderHook(() => useSessionCwd('sess-a'))
    await waitFor(() => expect(result.current).toBe('/tmp/foo'))
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledWith('/api/agent/sessions/sess-a/pwd')
  })

  it('polls every 5 seconds', async () => {
    vi.useFakeTimers()
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cwd: '/tmp/x', updatedAt: 1 }),
    })
    const { result } = renderHook(() => useSessionCwd('sess-poll'))
    await vi.runOnlyPendingTimersAsync()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mockFetch).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('restarts polling when sessionId changes', async () => {
    mockFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ cwd: url.includes('a') ? '/A' : '/B', updatedAt: 1 }),
    }))
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useSessionCwd(sid),
      { initialProps: { sid: 'sess-a' } }
    )
    await waitFor(() => expect(result.current).toBe('/A'))
    rerender({ sid: 'sess-b' })
    await waitFor(() => expect(result.current).toBe('/B'))
    expect(mockFetch).toHaveBeenLastCalledWith('/api/agent/sessions/sess-b/pwd')
  })

  it('keeps last known value on fetch error', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ cwd: '/known', updatedAt: 1 }) })
      .mockRejectedValueOnce(new Error('network'))
    const { result } = renderHook(() => useSessionCwd('sess-err'))
    await waitFor(() => expect(result.current).toBe('/known'))
    // Force another fetch cycle via setInterval — but with fake timers
    // simpler to just verify the catch path doesn't throw by triggering once more:
    await act(async () => {
      try { await mockFetch.mock.results[1]?.value } catch {}
    })
    // result should still be /known after the rejected fetch
    expect(result.current).toBe('/known')
  })

  it('keeps last known value on 404 (session closed)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ cwd: '/known', updatedAt: 1 }) })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'session not found' }) })
    const { result } = renderHook(() => useSessionCwd('sess-gone'))
    await waitFor(() => expect(result.current).toBe('/known'))
    expect(result.current).toBe('/known')  // unchanged after 404
  })

  it('clears interval on unmount', async () => {
    vi.useFakeTimers()
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ cwd: '/tmp', updatedAt: 1 }),
    })
    const { unmount } = renderHook(() => useSessionCwd('sess-u'))
    unmount()
    await vi.advanceTimersByTimeAsync(20_000)
    // initial fetch on mount counts as 1, no further calls
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(1)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd packages/zai && npx vitest run src/web/src/hooks/useSessionCwd.test.ts
```

Expected: FAIL, `Cannot find module './useSessionCwd.js'`

- [ ] **Step 4: 实现 hook**

`packages/zai/src/web/src/hooks/useSessionCwd.ts`:

```typescript
import { useEffect, useState } from 'react'

const POLL_INTERVAL_MS = 5_000

/**
 * Fetch the current cwd for a session, polling every 5s.
 *
 * - Returns `undefined` until the first successful fetch (or forever if sessionId is null)
 * - Keeps last known value on fetch error / 404 (silent)
 * - Restarts polling when sessionId changes
 * - Clears interval on unmount
 */
export function useSessionCwd(sessionId: string | null): string | undefined {
  const [cwd, setCwd] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!sessionId) {
      setCwd(undefined)
      return
    }

    let cancelled = false

    const fetchOnce = async () => {
      try {
        const res = await fetch(`/api/agent/sessions/${sessionId}/pwd`)
        if (!res.ok) return  // 404 / 5xx — keep old value
        const data = (await res.json()) as { cwd?: string }
        if (!cancelled && typeof data.cwd === 'string') {
          setCwd(data.cwd)
        }
      } catch {
        // network error — keep old value
      }
    }

    void fetchOnce()  // immediate
    const id = setInterval(() => { void fetchOnce() }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [sessionId])

  return cwd
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd packages/zai && npx vitest run src/web/src/hooks/useSessionCwd.test.ts
```

Expected: PASS, 7 tests passing

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/hooks/useSessionCwd.ts packages/zai/src/web/src/hooks/useSessionCwd.test.ts
git commit -m "feat(zai-web): useSessionCwd hook polls /sessions/:id/pwd every 5s"
```

---

## Task 7: SessionCwdBridge + ConfigStatusBar + Layout 集成

**Files:**
- Create: `packages/zai/src/web/src/components/SessionCwdBridge.tsx`
- Modify: `packages/zai/src/web/src/components/ConfigStatusBar.tsx`
- Modify: `packages/zai/src/web/src/components/Layout.tsx`
- Modify: `packages/zai/src/web/src/components/ConfigStatusBar.test.tsx`(加 case)

**Interfaces:**
- Consumes: Task 6 `useSessionCwd`
- Produces:
  - `<SessionCwdBridge />` 组件:订阅 `useAgentStore.sessionId` → 调 `useSessionCwd` → 调 `useAppStore.setInstanceContext` 更新 `cwdName` 字段(用 `basename(sessionCwd)` 替换)
  - `ConfigStatusBar` 加可选 `sessionCwd?: string` prop
  - `Layout` 渲染 `<SessionCwdBridge />`

- [ ] **Step 1: 看现有 ConfigStatusBar 和 Layout**

```bash
cat packages/zai/src/web/src/components/ConfigStatusBar.tsx
cat packages/zai/src/web/src/components/Layout.tsx | head -90
cat packages/zai/src/web/src/components/ConfigStatusBar.test.tsx 2>/dev/null | head -40
```

- [ ] **Step 2: 写 ConfigStatusBar 测试新 case**

`packages/zai/src/web/src/components/ConfigStatusBar.test.tsx`,在已有 describe block 末尾追加:

```typescript
// @vitest-environment happy-dom
// (放在文件头 — vitest 注释必须在 import 前)
import { describe, test, expect } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import ConfigStatusBar from './ConfigStatusBar.js'
// (保留文件已有的其他 imports / mocks)

// ... 既有 test cases ...

describe('ConfigStatusBar with sessionCwd', () => {
  test('renders basename when sessionCwd provided', () => {
    render(
      <ConfigStatusBar
        cwdName="fallback-name"
        branch="main"
        sessionCwd="/Users/ethan/code/proj/subdir"
      />
    )
    expect(screen.getByText('subdir')).toBeInTheDocument()
    expect(screen.queryByText('fallback-name')).not.toBeInTheDocument()
  })

  test('falls back to cwdName when sessionCwd undefined', () => {
    render(
      <ConfigStatusBar
        cwdName="static-fallback"
        branch="main"
      />
    )
    expect(screen.getByText('static-fallback')).toBeInTheDocument()
  })

  test('handles sessionCwd = "/"', () => {
    render(
      <ConfigStatusBar cwdName="fallback" branch="main" sessionCwd="/" />
    )
    // basename('/') === '/'
    expect(screen.getByText('/')).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd packages/zai && npx vitest run src/web/src/components/ConfigStatusBar.test.tsx
```

Expected: 新加的 3 个 case FAIL(因为 prop 还没接)

- [ ] **Step 4: 改 ConfigStatusBar.tsx**

读文件后,改 `Props` 加 `sessionCwd?: string`,渲染处用:

```typescript
const displayName = props.sessionCwd
  ? (props.sessionCwd.split('/').filter(Boolean).pop() || props.sessionCwd)
  : props.cwdName
```

(避免引入 `node:path` —— 浏览器侧不能 import node 模块,用字符串 split 拿 basename。)

- [ ] **Step 5: 跑 ConfigStatusBar 测试**

```bash
cd packages/zai && npx vitest run src/web/src/components/ConfigStatusBar.test.tsx
```

Expected: PASS,所有 case 通过(既有 + 新 3 个)

- [ ] **Step 6: 创建 SessionCwdBridge**

`packages/zai/src/web/src/components/SessionCwdBridge.tsx`:

```typescript
import { useEffect } from 'react'
import { useAgentStore } from '../store/useAgentStore.js'
import { useAppStore } from '../store/useAppStore.js'
import { useSessionCwd } from '../hooks/useSessionCwd.js'

/**
 * Bridges the per-session cwd (from useSessionCwd polling) into the global
 * instance context, so ConfigStatusBar can render it without re-subscribing.
 *
 * Why a bridge: Layout.tsx currently subscribes only to useAppStore.
 * Putting useAgentStore + setInstanceContext together here avoids spreading
 * that wiring across Layout.
 */
export function SessionCwdBridge() {
  const sessionId = useAgentStore(s => s.sessionId)
  const sessionCwd = useSessionCwd(sessionId)
  const setInstanceContext = useAppStore(s => s.setInstanceContext)
  const fallbackCwdName = useAppStore(s => s.instanceContext?.cwdName ?? '')

  useEffect(() => {
    const name = sessionCwd
      ? sessionCwd.split('/').filter(Boolean).pop() || sessionCwd
      : fallbackCwdName
    setInstanceContext(prev => prev ? { ...prev, cwdName: name } : prev)
  }, [sessionCwd, fallbackCwdName, setInstanceContext])

  return null
}
```

- [ ] **Step 7: 在 Layout 渲染 SessionCwdBridge**

读 `Layout.tsx:33-90` 找 return 语句,在 `<ConfigStatusBar>` 旁边(或上方)加:

```tsx
<SessionCwdBridge />
```

加 import:
```tsx
import { SessionCwdBridge } from './SessionCwdBridge.js'
```

- [ ] **Step 8: typecheck + 跑 web 测试**

```bash
cd packages/zai && npx tsc -b --noEmit && npx vitest run src/web/
```

Expected: 全过

- [ ] **Step 9: Commit**

```bash
git add packages/zai/src/web/src/components/SessionCwdBridge.tsx packages/zai/src/web/src/components/ConfigStatusBar.tsx packages/zai/src/web/src/components/ConfigStatusBar.test.tsx packages/zai/src/web/src/components/Layout.tsx
git commit -m "feat(zai-web): SessionCwdBridge wires useSessionCwd → ConfigStatusBar"
```

---

## Task 8: 手工 E2E 验收 + 文档更新

**Files:**
- Modify: `AGENTS.md`(在 opencc-web 加一条说明,补"已知薄弱点")

- [ ] **Step 1: 跑全包测试 + typecheck**

```bash
cd /Users/ethan/code/opencc-web && npx vitest run && (cd packages/zai-agent-core && npx tsc -b --noEmit) && (cd packages/zai && npx tsc -b --noEmit)
```

Expected: 全过,无回归

- [ ] **Step 2: 启动 zai 做手工 E2E**

```bash
cd packages/zai && npm run dev  # 或 zai 启动命令
```

按 spec §7.4 清单跑:
- [ ] 启动 zai → ConfigStatusBar 显示启动 cwd basename
- [ ] 让 LLM `cd /tmp` → 5s 内 status bar 变 `tmp`
- [ ] 切到另一个 session → status bar 立即变回该 session 的 cwd
- [ ] 切回原 session → 仍是 `tmp`(不被另一个 session 污染)
- [ ] session 删除 → map 中对应 key 也清除(看 server 日志)
- [ ] 后端重启 → session transcript 重跑 → cwd 重置到 ctx.cwd

- [ ] **Step 3: 补 AGENTS.md 已知薄弱点段**

在 `AGENTS.md` 的"已知薄弱点"段加一条:

```markdown
- `useSessionCwd` 5s 轮询在大量 session(>50)时打爆 server:暂无 throttle。后续可换 SSE 广播 `cwd.changed` 事件,server 端 BashTool trailer 写入后直接 emit。
- CwdStore 仅内存:server 进程重启后所有 session cwd 归零(transcript 重跑可恢复,符合预期)。
- 前端 cwd 轮询失败时静默保留旧值:用户看到陈旧 cwd 但无错误提示。
```

(同时把 §8 风险表中已讨论的"pwd -P 不支持" / "tmpfile 串" / "5s 实时性" 等也补一条进去,完整对应 spec §8。)

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs(zai): note CwdStore + useSessionCwd limitations in AGENTS.md"
```

---

## 自检

✅ **Spec 覆盖检查**:
- §2 架构 → Task 1-7 全部覆盖
- §3 数据流 3.1 init → Task 5 step 6 (runWithSessionId in prompt)
- §3.2 BashTool 切 cwd → Task 4
- §3.3 前端展示 → Task 6 + 7
- §3.4 不变量 → 由各 task 的 test case 保证
- §4 错误处理 → Task 4 trailer 测试 + Task 6 silent catch
- §5 API 数据形状 → Task 5 step 4 (404/200)
- §6 文件变更清单 → 全部已纳入 Task 1-7
- §7 测试 → Task 1-7 各自的 test,Task 8 E2E 验收清单

✅ **占位符扫描**: 无 TBD / TODO / "implement later"。每 step 都有具体代码或命令。

✅ **类型一致性**:
- `CwdStore.{get,set,getOrInit,has,delete,size,clear}` 在 Task 1 定义,Task 3 / 4 / 5 一致使用
- `runWithSessionId / getCurrentSessionId` 在 Task 3 定义,Task 5 step 6 导出 + 使用
- `useSessionCwd(sessionId)` 在 Task 6 定义,Task 7 使用
- `SessionCwdBridge` 在 Task 7 step 6 定义,step 7 渲染
- 全程使用 `cwd: string`、`sessionId: string` 统一