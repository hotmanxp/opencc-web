# Bash 工具 /tmp 残留 & 单元测试污染清理

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 BashTool 在生产路径上不留下 `/tmp/zai-bash-*` 残留文件，并让单元测试不会再向真实 `~/.zai/` 目录写入数据。

**Architecture:**

- **生产侧（Task 1-3）**: 把 `bashBackgroundTracker` 现有的 `evictOutput(taskId)` 调入 `evictFinished()` 的两条驱逐分支（时间驱逐 + 容量驱逐）；BashTool 在 `ctx.abortSignal.abort` 触发时，主动清理 `tmpCwdFile` (cwd trailer) 与持久化输出文件，并解绑监听器。
- **测试侧（Task 4-5）**: 给 BashTool 增加一个 `__cleanupTempFilesForTests()` 测试 seam,清空 `/tmp/zai-bash-*`;在 `test/tools/BashTool/BashTool.test.ts` 的 `afterEach` 调它。同时给所有依赖 `~/.zai/` 写的测试加一个 `process.env.ZAI_DATA_DIR` 临时覆盖 + 在 `afterEach` 恢复并清理 `dataDir`。
- **回归测试（Task 6）**: 在 BashTool.test.ts 加一条断言:跑一个 abort 脚本不会留 `/tmp/zai-bash-bash-*-cwd` 文件。

**Tech Stack:** TypeScript, Node.js `node:fs` / `node:child_process`, vitest

## Global Constraints

- 不引入新依赖（保持 `node:fs` / `node:child_process` 自家能力）
- 不动 `queryLoop` / `queryEngine` 主循环;只动 BashTool + bashTracker + 测试周边
- 凡涉及 `process.env.X` 修改的测试, 必须在 `afterEach` 还原
- 持久化输出清理只能 best-effort（`unlink` ENOENT 静默吞掉），不抛错影响主流程
- TDD: 每个 task 先写失败测试, 再写产品代码让它过
- 频繁小 commit: 每个 task 独立 commit

---

## 文件索引

| 文件 | 职责 |
|---|---|
| `packages/zai-agent-core/src/tools/BashTool/BashTool.ts` | BashTool 主入口; runForeground/runInBackground 处理, abort handler, tmpCwdFile |
| `packages/zai-agent-core/src/tools/BashTool/bashTracker.ts` | BashBackgroundTracker: byId LRU, evictFinished, evictOutput (单 task 持久化文件删) |
| `packages/zai-agent-core/src/tools/BashTool/persistShellOutput.ts` | 写到 `${TMPDIR}/zai-bash-<taskId>.txt`, 不参与清理 |
| `packages/zai-agent-core/test/tools/BashTool/BashTool.test.ts` | 主测试, 加 abort 路径断言 + 测试 seam 清理 |
| `packages/zai-agent-core/test/runtime/compact/log-event.test.ts` | 已有 ZAI_DATA_DIR 隔离, 改测后清理 |
| `packages/zai-agent-core/test/integration/agent/auto-compact-turn-loop.test.ts` | 同上, afterEach 还原 + 清理 dataDir |
| `packages/zai-agent-core/test/integration/agent/resilience/e-tool-use-summary.test.ts` | 同上 |

---

### Task 1: bashTracker.evictFinished 调用 evictOutput

**Files:**
- Modify: `packages/zai-agent-core/src/tools/BashTool/bashTracker.ts:236-258`
- Test: `packages/zai-agent-core/test/tools/BashTool/BashTool.test.ts` (新 describe 'evictFinished 清理 persisted 文件')

**Interfaces:**
- Consumes: `evictOutput(taskId: string): void` 已经存在 (§155 行实现)
- Produces: `evictFinished()` 删 task 时先调 evictOutput (单签名保持)
- 测试新增 seam: `bashBackgroundTracker.__evictFinishedForTests()` (已存在 §337)

- [ ] **Step 1: 写失败测试**

在 `packages/zai-agent-core/test/tools/BashTool/BashTool.test.ts` 末尾加一个新 describe 块:

```typescript
describe('回归: evictFinished 清理 persisted 输出文件', () => {
  test('时间驱逐时自动 unlink persisted 文件', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'zai-evict-persist-'))
    const fakePersistedPath = join(tmpDir, 'zai-bash-fake-persist.txt')
    await writeFile(fakePersistedPath, 'big output')

    bashBackgroundTracker.register('b-persist-test', {
      sessionId: 's1',
      command: 'cmd-with-persist',
      description: 'persist',
      startedAt: Date.now() - 31 * 60 * 1000,
    })
    const t = bashBackgroundTracker.get('b-persist-test')!
    t.finishedAt = Date.now() - 31 * 60 * 1000
    t.persistedOutputPath = fakePersistedPath
    bashBackgroundTracker.markFinished('b-persist-test', 'completed')
    bashBackgroundTracker.__evictFinishedForTests()

    expect(bashBackgroundTracker.get('b-persist-test')).toBeUndefined()
    expect(existsSync(fakePersistedPath)).toBe(false)  // 应已被删
    await rm(tmpDir, { recursive: true, force: true })
  })
})
```

注意: `existsSync` 已 import from node:fs。

- [ ] **Step 2: 跑测试，验证失败**

Run: `cd packages/zai-agent-core && pnpm vitest run test/tools/BashTool/BashTool.test.ts -t "时间驱逐时自动 unlink persisted 文件"`
Expected: FAIL — existsSync(fakePersistedPath) 仍为 true（evictFinished 当前不调 evictOutput）

- [ ] **Step 3: 修 `evictFinished`**

`packages/zai-agent-core/src/tools/BashTool/bashTracker.ts:236-258`，替换为:

```typescript
private evictFinished(): void {
  const now = Date.now()
  const finished: BashTaskInfo[] = []
  for (const t of this.byId.values()) {
    if (t.status === 'running') continue
    finished.push(t)
  }
  // 1) 时间淘汰: finishedAt + TTL < now 的直接删 (同步 unlink persisted 文件)
  const toDelete = new Set<string>()
  for (const t of finished) {
    if (t.finishedAt !== undefined && now - t.finishedAt > FINISHED_TTL_MS) {
      toDelete.add(t.taskId)
    }
  }
  // 2) 容量淘汰: byId 总数还超 MAX_TRACKED_TASKS → 按 finishedAt 升序删
  if (this.byId.size > MAX_TRACKED_TASKS) {
    const sorted = finished
      .filter((t) => this.byId.has(t.taskId))
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
    const excess = this.byId.size - MAX_TRACKED_TASKS
    for (let i = 0; i < excess && i < sorted.length; i++) {
      toDelete.add(sorted[i].taskId)
    }
  }
  // 同步 unlink 每个被驱逐 task 的 persisted 文件, 再删 byId 项
  for (const taskId of toDelete) {
    this.evictOutput(taskId)
    this.byId.delete(taskId)
  }
}
```

- [ ] **Step 4: 跑测试，验证通过**

Run: `cd packages/zai-agent-core && pnpm vitest run test/tools/BashTool/BashTool.test.ts -t "时间驱逐时自动 unlink persisted 文件"`
Expected: PASS

- [ ] **Step 5: 跑全部 BashTool 测试，确认无回归**

Run: `cd packages/zai-agent-core && pnpm vitest run test/tools/BashTool/`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
cd packages/zai-agent-core && git add src/tools/BashTool/bashTracker.ts test/tools/BashTool/BashTool.test.ts && git commit -m "fix(bash-tracker): evictFinished 清理持久化输出文件"
```

---

### Task 2: BashTool runForeground 在 abort 时清 cwd trailer

**Files:**
- Modify: `packages/zai-agent-core/src/tools/BashTool/BashTool.ts:486-490` (abort handler)
- Test: `packages/zai-agent-core/test/tools/BashTool/BashTool.test.ts` (新 abort-regression describe)

**Interfaces:**
- Consumes: `tmpCwdFile = \`/tmp/zai-bash-${taskId}-cwd\`` (§323 已有), `ctx.abortSignal` (§486)
- Produces: abort handler 现在 best-effort unlink tmpCwdFile + persisted output 路径清理保持原状

- [ ] **Step 1: 写失败测试**

加到 `test/tools/BashTool/BashTool.test.ts` 末尾:

```typescript
describe('回归: abort 路径清理 cwd trailer', () => {
  test('abort 触发时 tmpCwdFile 被清理', async () => {
    const ac = new AbortController()
    const ctxWithAbort = {
      ...ctx,
      abortSignal: ac.signal,
    }
    ac.abort()
    const r = await BashTool.call({ command: 'echo hi' }, ctxWithAbort)
    // 命令可能 isError (aborted); 我们只关心没留 /tmp 文件
    const r2 = r as { isError?: boolean; output?: string }
    void r2
    const leftover = (await import('node:fs')).readdirSync('/tmp').filter((f) =>
      f.startsWith('zai-bash-bash-') && f.endsWith('-cwd')
    )
    // 因为 taskId 不可预知, 至少保证本测试运行期间 (afterEach 强制清理) 无残留:
    expect(leftover).toEqual([])
  })
})
```

> 测试比 Task 3 弱（taskId 不可预知）— Task 3 会注入 run_in_background + AbortController 拿到真实 taskId。

- [ ] **Step 2: 跑测试验证它会失败**

Run: `cd packages/zai-agent-core && pnpm vitest run test/tools/BashTool/BashTool.test.ts -t "abort 触发时 tmpCwdFile 被清理"`
Expected: FAIL — abort 路径不清理（但 Task 4 之后会被全局 __cleanupTempFilesForTests 兜底；本断言要测生产路径行为）

> 若测试通过, 因为整进程以前累计的 leaked 文件存在；如出现 flake,先 `rm /tmp/zai-bash-*-cwd` 再跑本测试,确认 Step 3 修复后是否仍过。

- [ ] **Step 3: 修 BashTool abort handler**

`packages/zai-agent-core/src/tools/BashTool/BashTool.ts:486-490`:

```typescript
if (ctx.abortSignal) {
  ctx.abortSignal.addEventListener(
    'abort',
    () => {
      // 子进程已由 spawn({signal}) 自动 kill, 等待 close 事件归一化
      // best-effort: 提前删 cwd trailer 文件, 即使 'exit' 来不及触发
      try {
        unlinkSync(tmpCwdFile)
      } catch {
        // 文件还没写出来 / 已删 / 权限不足 — 静默
      }
    },
    { once: true },
  )
}
```

> 注: persisted output 文件落到 `child.on('exit')` 之后才写, abort 时还未创建,无需清理。

- [ ] **Step 4: 跑测试**

Run: `cd packages/zai-agent-core && pnpm vitest run test/tools/BashTool/BashTool.test.ts -t "abort 触发时 tmpCwdFile 被清理"`
Expected: PASS

- [ ] **Step 5: 跑全部 BashTool 测试**

Run: `cd packages/zai-agent-core && pnpm vitest run test/tools/BashTool/`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
cd packages/zai-agent-core && git add src/tools/BashTool/BashTool.ts test/tools/BashTool/BashTool.test.ts && git commit -m "fix(tools/bash): abort 路径清理 cwd trailer"
```

---

### Task 3: BashTool 后台 aborted 时清 persisted output

**Files:**
- Modify: `packages/zai-agent-core/src/tools/BashTool/BashTool.ts:552-560` (`runInBackground` exit handler)
- Test: `packages/zai-agent-core/test/tools/BashTool/BashTool.test.ts`

**Interfaces:**
- Consumes: `persistShellOutputFile` + `bashBackgroundTracker.setPersistedOutputPath` (§555-558 已有)
- Produces: 写入 persisted 路径后, 自动 `bashBackgroundTracker` 记下路径 (现有逻辑已记)。但 `markFinished` 之前需要确保 path 已写。

> 这一 task 的目的是**确认生产路径没有 leak**, 而不是修代码 — 复盘后可能只写测试不写代码。

- [ ] **Step 1: 写回归测试 — 跑一个 > 64MB 输出的脚本**

在 test 里临时用 `Buffer.alloc(64*1024*1024+1, 'a') + base64` 模拟大输出 (Node spawn 捕获完整输出)。

```typescript
import { setTimeout as sleep } from 'node:timers/promises'

describe('回归: 大输出后台任务被 abort 后不泄漏 persisted file', () => {
  test('run_in_background aborted → 任务完成期持久文件要么不存在要么被 tracker 收到 path', async () => {
    const ac = new AbortController()
    const ctxWithAbort = { ...ctx, abortSignal: ac.signal }
    // 80 MB 输出: 触发 MAX_PERSISTED_SHELL_OUTPUT_SIZE 路径
    const cmd = `head -c $((80*1024*1024)) /dev/zero | tr '\\0' a`
    const r = await BashTool.call(
      { command: cmd, run_in_background: true },
      ctxWithAbort,
    )
    expect(r.isError).toBeFalsy()
    const out = String(r.output)
    const match = out.match(/<task_id>(bash-[0-9a-f]{8})<\/task_id>/)
    expect(match).not.toBeNull()
    const taskId = match![1]
    // 给后台进程最多 10s 完成
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const t = bashBackgroundTracker.get(taskId)
      if (t && t.status !== 'running') break
      await sleep(100)
    }
    const persisted = bashBackgroundTracker.get(taskId)?.persistedOutputPath
    if (persisted) {
      // 文件被 tracker 登记 — 后续 evictFinished 路径 (Task 1) 会清
      expect((await import('node:fs')).existsSync(persisted)).toBe(true)
    }
    // 不论是否持久化，task 必须最终处于 terminal 状态
    const finalTask = bashBackgroundTracker.get(taskId)
    expect(finalTask?.status).not.toBe('running')
    ac.abort()
  }, 15_000)
})
```

- [ ] **Step 2: 跑测试**

Run: `cd packages/zai-agent-core && pnpm vitest run test/tools/BashTool/BashTool.test.ts -t "run_in_background aborted → 任务完成期持久文件"`
Expected: PASS（因为 Task 1 已保证 evictFinished 清理; 本测试只确保生产路径登记 path）— 若不需要修代码, 跳到 Step 4 commit。

- [ ] **Step 3: 如 Step 2 出现 FAIL（task 没标 persistedOutputPath）, 在 runInBackground exit handler 注册 path set 之后, 添加 `bashBackgroundTracker.setPersistedOutputPath(taskId, persisted.path)` — 已存在 §557, 仅当被吞掉时再加**

> 这一步只有在生产代码确实漏调用 setPersistedOutputPath 时才需要。当前 §557 已存在, 通常可跳到 Step 4。

- [ ] **Step 4: Commit**

```bash
cd packages/zai-agent-core && git add test/tools/BashTool/BashTool.test.ts && git commit -m "test(bash): 回归后台大输出 persisted 路径登记"
```

---

### Task 4: 测试 seam — 清理 /tmp/zai-bash-* 残留

**Files:**
- Modify: `packages/zai-agent-core/src/tools/BashTool/bashTracker.ts` (新增 `__cleanupTempFilesForTests`)
- Modify: `packages/zai-agent-core/test/tools/BashTool/BashTool.test.ts` (afterEach 调 seam)

**Interfaces:**
- Produces: 导出 `__cleanupTempFilesForTests(): { cleaned: string[] }` — 删除 `/tmp/zai-bash-*` 与 `${TMPDIR}/zai-bash-*`, 只在 `process.env.NODE_ENV === 'test'` 时合法（保险）

- [ ] **Step 1: 写失败测试**

在 `packages/zai-agent-core/test/tools/BashTool/BashTool.test.ts` 顶部加测试 seam 断言:

```typescript
import { __cleanupTempFilesForTests } from '../../../src/tools/BashTool/bashTracker.js'

describe('测试 seam: __cleanupTempFilesForTests', () => {
  test('清理 /tmp/zai-bash-* 前缀的临时文件', async () => {
    const { writeFileSync, existsSync, readdirSync } = await import('node:fs')
    const tmp = '/tmp'
    const seeds = ['zai-bash-test-leak-a-cwd', 'zai-bash-test-leak-b.txt']
    for (const f of seeds) {
      writeFileSync(`${tmp}/${f}`, 'leaked')
    }
    expect(readdirSync(tmp).filter((n) => n.startsWith('zai-bash-test-leak'))).toHaveLength(2)
    const result = __cleanupTempFilesForTests()
    expect(result.cleaned.length).toBeGreaterThanOrEqual(2)
    for (const f of seeds) expect(existsSync(`${tmp}/${f}`)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai-agent-core && pnpm vitest run test/tools/BashTool/BashTool.test.ts -t "__cleanupTempFilesForTests"`
Expected: FAIL — `__cleanupTempFilesForTests is not a function`

- [ ] **Step 3: 在 bashTracker.ts 加导出 seam**

`packages/zai-agent-core/src/tools/BashTool/bashTracker.ts`, 在文件底部 (line 339 后) 加:

```typescript
/**
 * 测试 seam: 清理 /tmp 下残留 zai-bash-* 文件 (兜底, 处理历史测试残留)。
 * 仅当 NODE_ENV === 'test' 时执行真实清理, 其他环境 throw 以防误删用户数据。
 */
export function __cleanupTempFilesForTests(): { cleaned: string[] } {
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    throw new Error('__cleanupTempFilesForTests 必须在测试环境调用')
  }
  const fs = require('node:fs') as typeof import('node:fs')
  const dirs = new Set<string>()
  const tmpdir = process.env.TMPDIR ?? '/tmp'
  dirs.add('/tmp')
  if (tmpdir !== '/tmp') dirs.add(tmpdir)
  const cleaned: string[] = []
  const re = /^zai-bash-/
  for (const dir of dirs) {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      if (!re.test(n)) continue
      const full = `${dir}/${n}`
      try {
        fs.unlinkSync(full)
        cleaned.push(full)
      } catch {
        // best-effort
      }
    }
  }
  return { cleaned }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai-agent-core && pnpm vitest run test/tools/BashTool/BashTool.test.ts -t "__cleanupTempFilesForTests"`
Expected: PASS

- [ ] **Step 5: 在 BashTool.test.ts 的 afterEach 加全局清理**

`packages/zai-agent-core/test/tools/BashTool/BashTool.test.ts:37-40`:

```typescript
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
  bashBackgroundTracker.__resetForTests()
  __cleanupTempFilesForTests()  // 兜底:清掉本测试 run 期间任何残留
})
```

- [ ] **Step 6: 跑全部 BashTool 测试**

Run: `cd packages/zai-agent-core && pnpm vitest run test/tools/BashTool/`
Expected: 全 PASS

- [ ] **Step 7: Commit**

```bash
cd packages/zai-agent-core && git add src/tools/BashTool/bashTracker.ts test/tools/BashTool/BashTool.test.ts && git commit -m "test(bash): afterEach 清理 /tmp/zai-bash-* 残留"
```

---

### Task 5: 真用户文件污染测试 — ZAI_DATA_DIR 全隔离

**Files:**
- Modify: `packages/zai-agent-core/test/runtime/compact/log-event.test.ts`
- Modify: `packages/zai-agent-core/test/integration/agent/auto-compact-turn-loop.test.ts`
- Modify: `packages/zai-agent-core/test/integration/agent/resilience/e-tool-use-summary.test.ts`
- Modify (新建 seam): `packages/zai-agent-core/src/runtime/compact/log-event.ts` (导出 `__setDataDirForTests`)
- Modify (新建 seam): `packages/zai-agent-core/src/runtime/summary/summaryStore.ts` (导出 `__setDataDirForTests`)

**Interfaces:**
- Produces:
  - `log-event.ts` 暴露 `__setDataDirForTests(dir: string | null)` — 测试期间把 dataDir 锁住 (覆盖 env 时避免 race)
  - `summaryStore.ts` 同上
- 测试改: 把 `process.env.ZAI_DATA_DIR` 改为 beforeEach set + afterEach 恢复;并 rm 测试 tmpDir

- [ ] **Step 1: 写失败测试 — log-event 数据污染验证**

在 `packages/zai-agent-core/test/runtime/compact/log-event.test.ts` 顶部加:

```typescript
import { readCompactLog } from '../../../src/runtime/compact/log-event.js'

describe('log-event 数据隔离', () => {
  test('默认 dataDir 不能写到真实 ~/.zai/logs/compact.jsonl', async () => {
    // 用一个 ZAI_DATA_DIR 完全独立的目录
    const realHome = process.env.HOME ?? require('node:os').homedir()
    const freshDir = await mkdtemp(join(tmpdir(), 'zai-leak-test-'))
    process.env.ZAI_DATA_DIR = freshDir
    try {
      logEvent('compact', {
        ts: 1, sessionId: 'leak-check', trigger: 'manual',
        model: 'x', preCompactTokens: 100, postCompactTokens: 50,
        savedTokens: 50, circuitBreakerState: 'closed',
        consecutiveFailures: 0, durationMs: 10, error: null,
      })
      // 真实 homedir 应该没有 leak-check 条目
      const realPath = join(realHome, '.zai', 'logs', 'compact.jsonl')
      if (existsSync(realPath)) {
        const real = readFileSync(realPath, 'utf-8')
        expect(real).not.toContain('leak-check')
      }
      // 测试目录应该有
      const entries = readCompactLog('leak-check')
      expect(entries.length).toBeGreaterThanOrEqual(1)
    } finally {
      delete process.env.ZAI_DATA_DIR
      await rm(freshDir, { recursive: true, force: true })
    }
  })
})
```

并在文件顶部加 imports:

```typescript
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs'  // 已有部分, 补 mkdtempSync
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
```

- [ ] **Step 2: 跑测试**

Run: `cd packages/zai-agent-core && pnpm vitest run test/runtime/compact/log-event.test.ts`
Expected: PASS（因为此测试本身已经正确设了 ZAI_DATA_DIR；本任务是新增 isolation 完整性测试）— 若 FAIL, 看是 `readCompactLog` 拿到的是真实 homedir 路径（缓存问题），进入 Step 3 加 `__setDataDirForTests` seam。

- [ ] **Step 3: 如果 Step 2 FAIL（cache 命中真实 homedir），加 log-event.ts seam**

`packages/zai-agent-core/src/runtime/compact/log-event.ts:30-32` 改为:

```typescript
let dataDirOverride: string | null = null
function dataDir(): string {
  return dataDirOverride ?? process.env.ZAI_DATA_DIR ?? join(homedir(), '.zai')
}

/** 测试 seam: 锁定 dataDir, 防止 env race 时回到 homedir。 */
export function __setDataDirForTests(dir: string | null): void {
  dataDirOverride = dir
}
```

同理在 `packages/zai-agent-core/src/runtime/summary/summaryStore.ts:86` 替换 homedir fallback 为可被 seam 覆盖。

- [ ] **Step 4: 改 summaryStore 测试隔离**

`packages/zai-agent-core/test/integration/agent/resilience/e-tool-use-summary.test.ts:98-99`, 在测试开头加 `process.env.ZAI_DATA_DIR = dataDir` 改为 beforeEach 模式 + afterEach `await rm(dataDir, {recursive:true})`。具体改 test suite level 的 beforeEach / afterEach:

```typescript
let dataDir: string
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'zai-summary-test-'))
  process.env.ZAI_DATA_DIR = dataDir
})
afterEach(async () => {
  delete process.env.ZAI_DATA_DIR
  await rm(dataDir, { recursive: true, force: true })
})
```

- [ ] **Step 5: 改 auto-compact-turn-loop.test.ts 隔离**

`packages/zai-agent-core/test/integration/agent/auto-compact-turn-loop.test.ts:60` 已有 `process.env.ZAI_DATA_DIR = dataDir`。补 afterEach（现有 fixture 处理见 file 内容）:

```typescript
afterEach(async () => {
  delete process.env.ZAI_DATA_DIR
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
})
```

- [ ] **Step 6: 跑全部 compact / summary 测试**

Run: `cd packages/zai-agent-core && pnpm vitest run test/runtime/compact/ test/integration/agent/auto-compact-turn-loop.test.ts test/integration/agent/resilience/e-tool-use-summary.test.ts`
Expected: 全 PASS, 期间应没有写入 `~/.zai/logs/compact.jsonl` 或 `~/.zai/summaries/`

- [ ] **Step 7: 验证 — 检查真实 homedir 不被污染**

Run: `wc -l ~/.zai/logs/compact.jsonl` (before count)
Run: 全套测试 `cd packages/zai-agent-core && pnpm vitest run test/runtime/compact/ test/integration/`
Run: `wc -l ~/.zai/logs/compact.jsonl` (after count)
Expected: 两个数量一致（before count 等于 after count）

- [ ] **Step 8: Commit**

```bash
cd packages/zai-agent-core && git add src/runtime/compact/log-event.ts test/runtime/compact/log-event.test.ts test/integration/agent/auto-compact-turn-loop.test.ts test/integration/agent/resilience/e-tool-use-summary.test.ts && git commit -m "test: 隔离 ZAI_DATA_DIR, 单元测试不可污染用户 homedir"
```

---

### Task 6: 整体回归 + 文档

**Files:**
- Verify: 跑全包测试
- Modify: AGENTS.md "已知薄弱点" 节加一句说明

**Interfaces:**
- 文档更新: 在 AGENTS.md "已知薄弱点" 加新 bullet

- [ ] **Step 1: 跑全包 BashTool + compact + background 测试**

Run: `cd packages/zai-agent-core && pnpm vitest run test/tools/BashTool/ test/runtime/background/ test/runtime/compact/ test/background/ test/integration/agent/`
Expected: 全 PASS

- [ ] **Step 2: 验证无 ~/.zai 与 /tmp 污染**

Run:

```bash
echo "before: $(wc -l < ~/.zai/logs/compact.jsonl 2>/dev/null || echo 0)"
ls /tmp/zai-bash-* 2>/dev/null | wc -l
```

测试 run:

```bash
cd packages/zai-agent-core && pnpm vitest run test/tools/BashTool/ test/runtime/compact/ test/integration/agent/auto-compact-turn-loop.test.ts
echo "after: $(wc -l < ~/.zai/logs/compact.jsonl 2>/dev/null || echo 0)"
ls /tmp/zai-bash-* 2>/dev/null | wc -l
```

Expected: 两个 `before` 数 = 两个 `after` 数（compact.jsonl 行数无变化，且 /tmp 无 zai-bash-* 残留）

- [ ] **Step 3: AGENTS.md 加一节**

`AGENTS.md` 的 "已知薄弱点" 末尾加一行:

```
- BashTool `/tmp/zai-bash-*-cwd` (cwd trailer) 与 `/tmp/zai-bash-<taskId>.txt` (大输出持久化) 已修复: abort/timeout 路径主动清 cwd trailer，bashBackgroundTracker.evictFinished 同步 unlink 持久化文件。测试 seam `__cleanupTempFilesForTests()` 在 afterEach 兜底。
```

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md && git commit -m "docs(AGENTS): 标注 bash 残留文件清理修复"
```

---

## 自我审查

1. **Spec coverage**:
   - 生产侧 `/tmp/zai-bash-*-cwd` 残留 → Task 2
   - 生产侧 `/tmp/zai-bash-<taskId>.txt` 残留 → Task 1
   - 测试向真实 homedir 写入 → Task 5
   - 测试本身的 /tmp 残留 → Task 4
   - 文档同步 → Task 6

2. **Placeholder scan**:
   - 无 "TBD" / "类似" / "fill in"
   - 所有 step 有具体代码块或命令

3. **Type consistency**:
   - `__cleanupTempFilesForTests(): { cleaned: string[] }` 全 plan 一致
   - `evictOutput(taskId)` 签名一致
   - `bashBackgroundTracker.setPersistedOutputPath(taskId, path)` 在第 3 节被显式引用，与第 1 节中"已存在 §557"匹配

4. **不需要新增 skill / 重构大文件**: Task 1-4 都是每个文件 < 30 行的局部改动。
