# zai 会话归档 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一工作目录下超出保留阈值（默认最近 20 条 / 3 天）的会话 transcript 在服务启动时（或手动触发时）移入 `~/.zai/archive/projects/<encoded-cwd>/`。

**Architecture:** zai 层新增一个独立 service（`sessionArchive.ts`）。`sanitizePath` **不内联第 4 份副本** —— 改为从 `@zn-ai/zn-agent-core` 导出 `legacyTranscriptStore` 现有的那份（Task 0），zai 侧 import 单一实现。归档逻辑本身对齐同目录既有先例 `historyArchive.ts` 的约定（单条失败只 warn、同名跳过、永不抛、模块级 in-flight 去重）。启动钩子插在 `initAgentRuntime()` 里 `restoreAllSessions` 之前；手动触发走一个独立 router（避免动 2300 行的 `routes/agent.ts`）。

**Tech Stack:** TypeScript 5.6 / Node ≥20 / Express 4 / Vitest 4 + supertest / React 18 + Zustand + AntD 5

**Spec:** `docs/superpowers/specs/2026-09-23-zai-session-archive-design.md`（本计划实现它；如有冲突以 spec 为准并回改 spec）

## Global Constraints

- **系统提示词一律用英文** —— 本计划不新增任何系统提示词 / LLM 指令字符串，无需处理。
- **样式规范**：新写/修改组件一律用 Tailwind utility class，不写 `style={{...}}`。仅允许 7 类例外（运行时计算值、`calc()`/`env()`、AntD `styles` 语义槽位、事件驱动 DOM 修改、keyframes、`writingMode`/复杂 `backdropFilter`/SVG fill、AntD 单组件 `style` prop）。
- **测试粒度**：只跑直接受影响的测试文件（路径过滤），**禁止**把 `pnpm -r test` 全量当完成门禁。
- **`packages/zn-agent-core/` 本计划只改一处**（Task 0：把 `legacyTranscriptStore` 里模块私有的 `sanitizePath` 加 `export` 并在主入口 re-export）。Task 0 完成后**必须**跑 `pnpm run build:core` —— zai 通过 `node_modules/@zn-ai/zn-agent-core/dist/` 加载，改源不重建就不生效，后续任务的 ego 验证会跑到旧行为。**除 Task 0 外，任何任务都不该再碰 core**；若实施中发现需要，停下来回到 spec 重新评估。
- **端口纪律**：起 dev server 前先 `lsof -i :<port>`；显式 `--port` 被占用必须报错退出，**禁止**静默换端口。920x 是正式服务端口，**绝不可 kill**。
- **提交格式**：`HRMSV3-ZN-WEBSITE#668 <type>(scope): 描述`，例如 `HRMSV3-ZN-WEBSITE#668 feat(zai): 启动时归档过期会话 transcript`。
- **常量值（spec §5.2，必须逐字一致）**：`ARCHIVE_KEEP_COUNT_DEFAULT = 20`、`ARCHIVE_KEEP_COUNT_MIN = 1`、`ARCHIVE_KEEP_COUNT_MAX = 1000`、`ARCHIVE_KEEP_DAYS = 3`、`ARCHIVE_PROTECT_WINDOW_MS = 10 * 60_000`。
- **路径（spec §3，必须逐字一致）**：源 `<dataDir>/projects/<sanitizePath(cwd)>/`，目标 `<dataDir>/archive/projects/<sanitizePath(cwd)>/`。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/zn-agent-core/src/compat/runtime/legacyTranscriptStore.ts` | Modify | 给模块私有的 `sanitizePath` 加 `export` |
| `packages/zn-agent-core/src/index.ts` | Modify | 主入口 re-export `sanitizePath` |
| `packages/zn-agent-core/test/unit/runtime/legacyTranscriptStore.test.ts` | Modify | 补 `sanitizePath` 的导出与编码断言 |
| `packages/zai/src/server/services/sessionArchive.ts` | Create | 归档判定 + 移动的全部逻辑；常量；路径派生；配置解析 |
| `packages/zai/test/server/services/sessionArchive.test.ts` | Create | 上者的单元测试（临时 dataDir + 注入 mtime/now） |
| `packages/zai/src/server/services/agentRuntime.ts` | Modify | `initAgentRuntime` 启动时调用一次 sweep |
| `packages/zai/src/server/routes/sessionArchive.ts` | Create | `POST /agent/sessions/archive` 手动触发端点 |
| `packages/zai/src/server/index.ts` | Modify | 挂载上面这个 router |
| `packages/zai/test/server/routes/sessionArchive.test.ts` | Create | 上者的路由测试 |
| `packages/zai/src/shared/settings.ts` | Modify | `ZaiSettings.archive.keepCount` 字段声明 |
| `packages/zai/src/server/routes/agentSettings.ts` | Modify | `GET /agent/settings` 增补字段 + `PUT /agent/settings/archive-keep-count` |
| `packages/zai/test/server/agentSettings-archive.test.ts` | Create | 上者的测试 |
| `packages/zai/src/web/src/lib/settingsHydrate.ts` | Create | `clampSettingNumber` —— Layout/MobileLayout 共用的 hydrate 钳位 |
| `packages/zai/test/web/lib/settingsHydrate.test.ts` | Create | 上者的单元测试 |
| `packages/zai/src/web/src/store/useAppStore.ts` | Modify | `archiveKeepCount` state + setter |
| `packages/zai/test/web/store/useAppStore-archive.test.ts` | Create | store 默认值 + setter 的单元测试 |
| `packages/zai/src/web/src/components/Layout.tsx` | Modify | mount 时从 `GET /api/agent/settings` hydrate |
| `packages/zai/src/web/src/components/MobileLayout.tsx` | Modify | 同上 |
| `packages/zai/src/web/src/lib/agentSessionApi.ts` | Modify | `archiveSessions()` 前端调用 |
| `packages/zai/src/web/src/components/SettingsDrawer.tsx` | Modify | 「会话归档」number 行 + 「立即归档」按钮 |
| `packages/zai/src/web/src/components/SettingsDrawer.test.tsx` | Modify | 补断言 |

---

## Task 0: 从 core 导出 `sanitizePath`（单一实现）

zai 侧需要「cwd → project 目录名」这个编码。仓库里有三份实现，只有 `legacyTranscriptStore.ts` 那份（阈值 200 + djb2）与 zai 实际落盘目录一致。与其内联第 4 份副本，不如把这一份导出。

**Files:**
- Modify: `packages/zn-agent-core/src/compat/runtime/legacyTranscriptStore.ts`
- Modify: `packages/zn-agent-core/src/index.ts`
- Test: `packages/zn-agent-core/test/unit/runtime/legacyTranscriptStore.test.ts`

**Interfaces:**
- Produces（Task 1 依赖）：`sanitizePath(name: string): string`，从 `@zn-ai/zn-agent-core` 主入口可导入

- [ ] **Step 1: 写失败测试**

在 `packages/zn-agent-core/test/unit/runtime/legacyTranscriptStore.test.ts` 末尾追加（该文件已 import `TranscriptStore`，若缺 `sanitizePath` 的 import 一并补）：

```ts
describe('sanitizePath (跨包导出)', () => {
  it('非字母数字全部替换为 -', () => {
    expect(sanitizePath('/Users/foo/code/bar')).toBe('-Users-foo-code-bar')
    expect(sanitizePath('/private/tmp/zai-nongit-verify')).toBe(
      '-private-tmp-zai-nongit-verify',
    )
  })

  it('超长路径截断到 200 并追加 djb2 后缀，且同一输入稳定', () => {
    const long = `/${'a'.repeat(400)}`
    const a = sanitizePath(long)
    const b = sanitizePath(long)
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(200)
    expect(a.startsWith(`-${'a'.repeat(199)}`)).toBe(true)
  })

  it('TranscriptStore 落盘目录 == <dataDir>/projects/<sanitizePath(cwd)>', async () => {
    // 这条是给 zai 侧归档服务用的契约：归档目标目录必须用同一个编码，
    // 否则归档到错误目录（表现为"归档不生效"而非数据损坏）。
    const dir = await mkdtemp(join(tmpdir(), 'core-sanitize-'))
    try {
      const cwd = '/Users/foo/code/contract'
      const store = new TranscriptStore(dir)
      await store.create({ cwd, model: 'm' }, { cwd })
      expect(existsSync(join(dir, 'projects', sanitizePath(cwd)))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
```

测试文件顶部按现有风格补 `import { mkdtemp, rm } from 'node:fs/promises'`、`import { tmpdir } from 'node:os'`、`import { join } from 'node:path'`、`import { existsSync } from 'node:fs'`（该文件已有的不要重复）。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/runtime/legacyTranscriptStore.test.ts
```

Expected: FAIL —— `sanitizePath is not defined`（它是模块私有，测试文件 import 不到）。

- [ ] **Step 3: 加 export**

`packages/zn-agent-core/src/compat/runtime/legacyTranscriptStore.ts`，在 `sanitizePath` 前加 `export`，并补一行导出意图注释：

```ts
/**
 * cwd → project 目录名。**导出给 zai 侧会话归档服务复用**
 * （packages/zai/src/server/services/sessionArchive.ts）—— 归档目标目录必须
 * 用与落盘完全相同的编码，否则归档到错误目录。不要再在别处内联第 4 份副本：
 * 本仓库另两份同名函数阈值不同（compat/transcript/paths.ts 是 80、
 * opencc-src/utils/sessionStoragePortable.ts 优先用 Bun.hash），复制错哪一份
 * 都会静默错位。
 */
export function sanitizePath(name: string): string {
```

`packages/zn-agent-core/src/index.ts`，把 `:61` 那行改为两行：

```ts
export { TranscriptStore } from './compat/runtime/legacyTranscriptStore.js'
// zai 侧会话归档服务用同一个路径编码（见该文件的 sanitizePath 注释）。
export { sanitizePath } from './compat/runtime/legacyTranscriptStore.js'
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @zn-ai/zn-agent-core test test/unit/runtime/legacyTranscriptStore.test.ts
```

Expected: PASS（原有用例 + 新增 3 个）。

- [ ] **Step 5: 重建 core 并验证导出可见**

```bash
pnpm run build:core
```

Expected: 构建成功（`dist/opencc-core.mjs` 与 `dist/bundle-entry.d.ts` 重新生成）。

然后确认 zai 侧真的能拿到这个符号：

```bash
node --input-type=module -e "import('@zn-ai/zn-agent-core').then(m => console.log(typeof m.sanitizePath, m.sanitizePath('/a/b')))"
```

在 `packages/zai/` 目录下跑，Expected: 输出 `function -a-b`。

- [ ] **Step 6: 跑 zai 侧既有测试确认没打破 core 契约**

```bash
pnpm --filter @zn-ai/zn-agent-core test
```

Expected: PASS（core 全量测试，此处是全量改动后的必要 sanity check）。

- [ ] **Step 7: 提交**

```bash
git add packages/zn-agent-core/src/compat/runtime/legacyTranscriptStore.ts \
        packages/zn-agent-core/src/index.ts \
        packages/zn-agent-core/test/unit/runtime/legacyTranscriptStore.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(core): 导出 sanitizePath 供 zai 会话归档复用"
```

---

## Task 1: 服务骨架 —— 常量、路径派生、配置解析

先把「算路径」和「读配置」这两件不需要扫目录的事做完并锁死。

**Files:**
- Create: `packages/zai/src/server/services/sessionArchive.ts`
- Test: `packages/zai/test/server/services/sessionArchive.test.ts`

**Interfaces:**
- Consumes: `resolveDataDir()` / `sanitizePath()` from `@zn-ai/zn-agent-core`（Task 0 已导出）；`ZaiSettings` from `../../shared/settings.js`
- Produces（后续任务依赖这些精确签名）：
  - `ARCHIVE_KEEP_COUNT_DEFAULT: 20`、`ARCHIVE_KEEP_COUNT_MIN: 1`、`ARCHIVE_KEEP_COUNT_MAX: 1000`、`ARCHIVE_KEEP_DAYS: 3`、`ARCHIVE_PROTECT_WINDOW_MS: 600000`
  - `projectDirFor(dataDir: string, cwd: string): string`
  - `archiveDirFor(dataDir: string, cwd: string): string`
  - `toArchiveKeepCount(value: unknown): number | null`
  - `resolveArchiveKeepCount(settings: ZaiSettings): number`

- [ ] **Step 1: 写失败测试**

创建 `packages/zai/test/server/services/sessionArchive.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptStore } from '@zn-ai/zn-agent-core'
import {
  ARCHIVE_KEEP_COUNT_DEFAULT,
  ARCHIVE_KEEP_COUNT_MAX,
  ARCHIVE_KEEP_COUNT_MIN,
  archiveDirFor,
  projectDirFor,
  resolveArchiveKeepCount,
  toArchiveKeepCount,
} from '../../../src/server/services/sessionArchive.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'session-archive-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe('路径派生', () => {
  it('源目录 = <dataDir>/projects/<encoded>，目标 = <dataDir>/archive/projects/<encoded>', () => {
    const cwd = '/Users/foo/code/bar'
    expect(projectDirFor(dataDir, cwd)).toBe(
      join(dataDir, 'projects', '-Users-foo-code-bar'),
    )
    expect(archiveDirFor(dataDir, cwd)).toBe(
      join(dataDir, 'archive', 'projects', '-Users-foo-code-bar'),
    )
  })

  // 这条是防漂移的关键回归测试：断言"真实落盘目录"与 projectDirFor 一致。
  // 两者的编码都来自 core 导出的同一个 sanitizePath，但 TranscriptStore 未来
  // 若换编码，这条会立刻红 —— 不要把算法抄进测试里再断言算法。
  it('projectDirFor 与 TranscriptStore 真实落盘的目录一致', async () => {
    const cwd = '/Users/foo/code/drift-check'
    const store = new TranscriptStore(dataDir)
    await store.create({ cwd, model: 'test-model' }, { cwd })
    expect(fs.existsSync(projectDirFor(dataDir, cwd))).toBe(true)
  })
})

describe('toArchiveKeepCount', () => {
  it('合法数字原样返回（取整）', () => {
    expect(toArchiveKeepCount(50)).toBe(50)
    expect(toArchiveKeepCount(50.9)).toBe(50)
  })

  it('可转数字的字符串也接受（与 max-visible-messages 同款宽容度）', () => {
    expect(toArchiveKeepCount('50')).toBe(50)
  })

  it('clamp 到 [1, 1000]', () => {
    expect(toArchiveKeepCount(0)).toBe(ARCHIVE_KEEP_COUNT_MIN)
    expect(toArchiveKeepCount(-10)).toBe(ARCHIVE_KEEP_COUNT_MIN)
    expect(toArchiveKeepCount(1e9)).toBe(ARCHIVE_KEEP_COUNT_MAX)
  })

  it('非法输入返回 null', () => {
    expect(toArchiveKeepCount(undefined)).toBeNull()
    expect(toArchiveKeepCount(null)).toBeNull()
    expect(toArchiveKeepCount('abc')).toBeNull()
    expect(toArchiveKeepCount(NaN)).toBeNull()
    expect(toArchiveKeepCount(Infinity)).toBeNull()
  })
})

describe('resolveArchiveKeepCount', () => {
  it('缺失 / 非法值 → 默认 20', () => {
    expect(resolveArchiveKeepCount({})).toBe(ARCHIVE_KEEP_COUNT_DEFAULT)
    expect(
      resolveArchiveKeepCount({ archive: { keepCount: 'junk' as never } }),
    ).toBe(ARCHIVE_KEEP_COUNT_DEFAULT)
  })

  it('读得到就 clamp 后返回', () => {
    expect(resolveArchiveKeepCount({ archive: { keepCount: 5 } })).toBe(5)
    expect(resolveArchiveKeepCount({ archive: { keepCount: 99999 } })).toBe(
      ARCHIVE_KEEP_COUNT_MAX,
    )
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @zn-ai/zai test test/server/services/sessionArchive.test.ts
```

Expected: FAIL —— `Failed to resolve import "../../../src/server/services/sessionArchive.js"`（文件还不存在）。

- [ ] **Step 3: 写最小实现**

创建 `packages/zai/src/server/services/sessionArchive.ts`：

```ts
/**
 * sessionArchive — 会话级 transcript 过期归档。
 *
 * 同一 cwd 下，`<dataDir>/projects/<encoded-cwd>/` 里既不在"最近 keepCount
 * 条"也不在"最近 3 天"内的 transcript，被移到
 * `<dataDir>/archive/projects/<encoded-cwd>/`（保留原始 project 编码路径）。
 *
 * 触发时机只有两个：
 *   1. `initAgentRuntime()` 启动时一次（services/agentRuntime.ts）；
 *   2. `POST /api/agent/sessions/archive`（设置页「立即归档」）手动一次。
 *
 * 约定逐条对齐同目录的 services/historyArchive.ts：
 *   - 单体错误只 console.warn，绝不抛出；
 *   - 目标同名 → warn 跳过（不合并 / 不覆盖 / 不加后缀）；
 *   - 整个 sweep 异常 → warn 吞掉；
 *   - 模块级 in-flight Promise 去重（启动 sweep 未完成时用户已点「立即归档」）。
 *
 * 归档后对 Web UI 完全透明：文件不在 projects/ 下 → 侧栏列表自然不再列出。
 * 无归档列表页 / 无恢复 UI（spec §2 D1）。
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDataDir, sanitizePath } from '@zn-ai/zn-agent-core'
import { readZaiSettings } from './zaiSettingsStore.js'
import type { ZaiSettings } from '../../shared/settings.js'

export const ARCHIVE_KEEP_COUNT_DEFAULT = 20
export const ARCHIVE_KEEP_COUNT_MIN = 1
export const ARCHIVE_KEEP_COUNT_MAX = 1000
/** 保留窗口（天）—— spec §2 D4：只暴露数量阈值，天数固定。 */
export const ARCHIVE_KEEP_DAYS = 3
/** 活跃保护窗：mtime 在此窗口内的文件一律不移动（防扫描/写入撞车）。 */
export const ARCHIVE_PROTECT_WINDOW_MS = 10 * 60_000

const JSONL_EXT = '.jsonl'

/** 源目录：该 cwd 的 transcript 落盘位置。 */
export function projectDirFor(dataDir: string, cwd: string): string {
  return join(dataDir, 'projects', sanitizePath(cwd))
}

/** 目标目录：归档位置，保留原始 project 编码路径段。 */
export function archiveDirFor(dataDir: string, cwd: string): string {
  return join(dataDir, 'archive', 'projects', sanitizePath(cwd))
}

/**
 * 校验 + 归一化一个候选 keepCount。接受 number 或可转数字的字符串
 * （与 PUT /agent/settings/max-visible-messages 的 handler 同款宽容度）。
 * 非法 → null（调用方决定回落值）。
 */
export function toArchiveKeepCount(value: unknown): number | null {
  // 必须先挡 null/undefined：`Number(null) === 0` 是有限数，会一路 clamp 成 1，
  // 而调用方（PUT handler / resolveArchiveKeepCount）把 null 当"没配"处理。
  // `undefined` 走 Number() 本来就是 NaN，这一行对它是冗余但无害。
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(ARCHIVE_KEEP_COUNT_MIN, Math.min(ARCHIVE_KEEP_COUNT_MAX, Math.floor(n)))
}

/** 从 settings 解析保留条数；缺失 / 手编垃圾值 → 20。 */
export function resolveArchiveKeepCount(settings: ZaiSettings): number {
  return toArchiveKeepCount(settings.archive?.keepCount) ?? ARCHIVE_KEEP_COUNT_DEFAULT
}
```

注意：`ZaiSettings.archive` 字段本任务还没加（Task 5 加）。为了本任务能通过 `tsc`，先在 `packages/zai/src/shared/settings.ts` 的 `ZaiSettings` 接口里加上字段声明（值解析逻辑仍在 `sessionArchive.ts`）：

```ts
  /**
   * 会话归档 —— 同一 cwd 下超出保留阈值的旧 transcript 会被移到
   * `<ZAI_DATA_DIR>/archive/projects/<encoded-cwd>/`。仅服务启动时自动跑一次，
   * 另有「立即归档」手动触发。详见
   * docs/superpowers/specs/2026-09-23-zai-session-archive-design.md。
   */
  archive?: {
    /**
     * 保留最近 N 条会话；不在此列**且**早于 3 天的才归档。默认 20，clamp [1,1000]。
     * 3 天窗口是模块常量（sessionArchive.ts 的 ARCHIVE_KEEP_DAYS），不可配。
     * 改动写盘即持久，下次扫描（启动 / 手动）生效，不需要重启。
     */
    keepCount?: number
  }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @zn-ai/zai test test/server/services/sessionArchive.test.ts
```

Expected: PASS（全部 8 个用例）。

- [ ] **Step 5: 类型检查**

```bash
pnpm --filter @zn-ai/zai exec tsc --noEmit
```

Expected: 无报错。

- [ ] **Step 6: 提交**

```bash
git add packages/zai/src/server/services/sessionArchive.ts \
        packages/zai/test/server/services/sessionArchive.test.ts \
        packages/zai/src/shared/settings.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 会话归档服务骨架(路径派生+配置解析)"
```

---

## Task 2: sweep 主体 —— 判定与移动

本任务是整个特性的核心：决定"哪些归档"以及"怎么移"。

**Files:**
- Modify: `packages/zai/src/server/services/sessionArchive.ts`
- Test: `packages/zai/test/server/services/sessionArchive.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `projectDirFor` / `archiveDirFor` / `resolveArchiveKeepCount` / `ARCHIVE_KEEP_DAYS` / `ARCHIVE_PROTECT_WINDOW_MS`
- Produces（Task 3 / Task 4 依赖）：
  - `type SessionArchiveResult = { archived: string[]; kept: number; skipped: number }`
  - `type SweepOptions = { cwd: string; dataDir?: string; now?: number; keepCount?: number }`
  - `sweepSessionArchive(opts: SweepOptions): Promise<SessionArchiveResult>`
  - `__resetSessionArchiveForTests(): void`

**判定规则（spec §4，实现前先读懂）**：
1. 候选 = 源目录里所有 `<sid>.jsonl`；`<sid>/` 目录**不是**候选（它是随行者）。
2. 按 `mtime` 降序排序，前 `keepCount` 条进保留集。
3. `mtime >= now - 3天` 的也进保留集（并集）。
4. 归档集 = 候选 − 保留集。逐条再过 10 分钟保护窗检查。
5. `kept` = 保留集大小 = `候选数 − 归档集大小`。

- [ ] **Step 1: 写失败测试**

在 `packages/zai/test/server/services/sessionArchive.test.ts` 顶部 import 区补上（**合并进** Task 1 已有的 `node:fs/promises` import，不要写两条重复 import）：

```ts
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { vi } from 'vitest'
import {
  __resetSessionArchiveForTests,
  sweepSessionArchive,
} from '../../../src/server/services/sessionArchive.js'

// stat 需要被 mock —— 「扫描后被并发写入」的保护窗分支只能靠 mock 复现
// （见该用例注释）。其余函数透传。这个手法与 test/server/historyArchive.test.ts:8-11
// mock readdir 是同一款。
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  return { ...orig, stat: vi.fn(orig.stat) }
})
```

把 Task 1 原本那行 `import { mkdtemp, rm } from 'node:fs/promises'` 删掉，`afterEach` / `beforeEach` 里用到的 `mkdtemp` / `rm` 由上面这行统一提供。

并在文件末尾追加：

```ts
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0) // 固定墙钟，测试不依赖 Date.now()

/** 在源目录铺一个 <sid>.jsonl，并把 mtime 设成 daysAgo 天前。 */
async function seedSession(
  cwd: string,
  sessionId: string,
  daysAgo: number,
  opts: { withSubagentDir?: boolean } = {},
): Promise<void> {
  const dir = projectDirFor(dataDir, cwd)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${sessionId}${'.jsonl'}`)
  await writeFile(file, `${JSON.stringify({ type: 'user', message: sessionId })}\n`, 'utf-8')
  const t = new Date(NOW - daysAgo * DAY_MS)
  await utimes(file, t, t)
  if (opts.withSubagentDir) {
    const sub = join(dir, sessionId, 'subagents')
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, 'agent-x.jsonl'), '{}\n', 'utf-8')
  }
}

const listDir = (p: string): string[] =>
  fs.existsSync(p) ? fs.readdirSync(p).sort() : []

const CWD = '/Users/foo/code/archive-target'

beforeEach(() => {
  __resetSessionArchiveForTests()
})

describe('sweepSessionArchive 判定', () => {
  it('超出阈值：25 条、最老 5 条在 5 天前 → 归档 5 条', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-new${i}`, 1)
    for (let i = 0; i < 5; i++) await seedSession(CWD, `sess-old${i}`, 5)
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(res.archived.sort()).toEqual([
      'sess-old0', 'sess-old1', 'sess-old2', 'sess-old3', 'sess-old4',
    ])
    expect(res.kept).toBe(20)
    expect(res.skipped).toBe(0)
    expect(listDir(archiveDirFor(dataDir, CWD))).toEqual([
      'sess-old0.jsonl', 'sess-old1.jsonl', 'sess-old2.jsonl', 'sess-old3.jsonl', 'sess-old4.jsonl',
    ])
  })

  it('3 天窗口保护：25 条全部 1 天前 → 归档 0 条（数量超了但都在窗口内）', async () => {
    for (let i = 0; i < 25; i++) await seedSession(CWD, `sess-recent${i}`, 1)
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(res.archived).toEqual([])
    expect(res.kept).toBe(25)
    expect(listDir(projectDirFor(dataDir, CWD))).toHaveLength(25)
  })

  it('并集语义：22 条中排序在 20 名之外的 2 条若在 3 天内则不动', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-a${i}`, 1)
    await seedSession(CWD, 'sess-b0', 2) // 第 21 名，但 2 天前 → 保留
    await seedSession(CWD, 'sess-b1', 5) // 第 22 名且 5 天前 → 归档
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(res.archived).toEqual(['sess-b1'])
    expect(res.kept).toBe(21)
  })

  it('候选数 ≤ keepCount → 直接返回，不归档', async () => {
    for (let i = 0; i < 3; i++) await seedSession(CWD, `sess-few${i}`, 30)
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(res.archived).toEqual([])
    expect(res.kept).toBe(3)
  })

  it('保护窗：扫描后被并发写入的会话不移动(skipped 计数)', async () => {
    // 保护窗可达的唯一路径是"扫描与写入撞车"：第一次 stat(候选扫描)看到旧
    // mtime → 进归档集；第二次 stat(移动前的 re-stat)看到刚刚被写入的新
    // mtime → 跳过。判断条件本身(早于 3 天)与保护窗(10 分钟)不可能同时成立，
    // 所以只能 mock 出撞车。第二次 stat 存在的意义就是抓这个窗口。
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-p${i}`, 1)
    await seedSession(CWD, 'sess-raced0', 5)

    const statSpy = vi.mocked(stat)
    const defaultImpl = statSpy.getMockImplementation()
    let reads = 0
    statSpy.mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      const s = await (defaultImpl as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
      if (typeof p === 'string' && p.endsWith('sess-raced0.jsonl')) {
        reads++
        if (reads >= 2) {
          // 第二次读 = 移动前的 re-stat → 模拟"这个会话刚被恢复并写入"
          return { ...(s as object), mtimeMs: NOW - 60_000 }
        }
      }
      return s
    }) as unknown as typeof stat)

    try {
      const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
      expect(res.archived).toEqual([])
      expect(res.skipped).toBe(1)
      expect(reads).toBe(2)
      expect(
        fs.existsSync(join(projectDirFor(dataDir, CWD), 'sess-raced0.jsonl')),
      ).toBe(true)
    } finally {
      statSpy.mockImplementation(defaultImpl!)
    }
  })
})

describe('sweepSessionArchive 归档单元', () => {
  it('<sid>/ 子 Agent 目录随行归档', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-k${i}`, 1)
    await seedSession(CWD, 'sess-withsub', 5, { withSubagentDir: true })
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(res.archived).toEqual(['sess-withsub'])
    const dst = archiveDirFor(dataDir, CWD)
    expect(fs.existsSync(join(dst, 'sess-withsub.jsonl'))).toBe(true)
    expect(fs.existsSync(join(dst, 'sess-withsub', 'subagents', 'agent-x.jsonl'))).toBe(true)
    // 源目录里不再有孤儿目录
    expect(fs.existsSync(join(projectDirFor(dataDir, CWD), 'sess-withsub'))).toBe(false)
  })

  it('0 字节占位文件同规则参与判定', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-z${i}`, 1)
    const dir = projectDirFor(dataDir, CWD)
    const empty = join(dir, 'sess-empty0.jsonl')
    await writeFile(empty, '', 'utf-8')
    const t = new Date(NOW - 10 * DAY_MS)
    await utimes(empty, t, t)
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(res.archived).toEqual(['sess-empty0'])
  })

  it('project 目录不存在 → 空结果不抛', async () => {
    const res = await sweepSessionArchive({
      cwd: '/Users/nobody/never-ran', dataDir, now: NOW, keepCount: 20,
    })
    expect(res).toEqual({ archived: [], kept: 0, skipped: 0 })
  })
})

describe('sweepSessionArchive 容错', () => {
  it('非会话文件 / 目录不受影响', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-m${i}`, 1)
    await seedSession(CWD, 'sess-doomed', 5)
    const dir = projectDirFor(dataDir, CWD)
    await mkdir(join(dir, 'memory'), { recursive: true })
    await writeFile(join(dir, 'memory', 'MEMORY.md'), '# mem\n', 'utf-8')
    await writeFile(join(dir, 'knowledge_graph.json'), '{}\n', 'utf-8')
    await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(fs.existsSync(join(dir, 'memory', 'MEMORY.md'))).toBe(true)
    expect(fs.existsSync(join(dir, 'knowledge_graph.json'))).toBe(true)
  })

  it('目标同名 → warn 跳过，源文件保留', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-c${i}`, 1)
    await seedSession(CWD, 'sess-conflict', 5)
    const dst = archiveDirFor(dataDir, CWD)
    await mkdir(dst, { recursive: true })
    await writeFile(join(dst, 'sess-conflict.jsonl'), 'preexisting\n', 'utf-8')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    warnSpy.mockRestore()
    expect(res.archived).toEqual([])
    expect(res.skipped).toBe(1)
    expect(fs.existsSync(join(projectDirFor(dataDir, CWD), 'sess-conflict.jsonl'))).toBe(true)
  })

  it('并发调用复用同一 in-flight sweep（同一 Promise 实例）', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-i${i}`, 1)
    await seedSession(CWD, 'sess-lone0', 5)
    const p1 = sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    const p2 = sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(p1).toBe(p2)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2)
    expect(r1.archived).toEqual(['sess-lone0'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @zn-ai/zai test test/server/services/sessionArchive.test.ts
```

Expected: FAIL —— `sweepSessionArchive is not a function`。

- [ ] **Step 3: 写实现**

在 `packages/zai/src/server/services/sessionArchive.ts` 末尾追加：

```ts
export type SessionArchiveResult = {
  /** 成功移走的 sessionId 列表。 */
  archived: string[]
  /** 保留集大小（候选数 − 归档集大小）。 */
  kept: number
  /** 进了归档集但因保护窗 / 目标同名 / stat 失败而没被移动的条数。 */
  skipped: number
}

export type SweepOptions = {
  /** 要归档的工作目录（= 实例 cwd）。 */
  cwd: string
  /** 默认 resolveDataDir().resolved。测试注入临时目录。 */
  dataDir?: string
  /** 默认 Date.now()。测试注入固定墙钟。 */
  now?: number
  /** 默认从 ~/.zai/settings.json 解析。测试注入。 */
  keepCount?: number
}

/**
 * rename 优先（同盘原子零拷贝）。捕获 EXDEV（跨设备 —— 例如用户把
 * ~/.zai/archive 做成指向另一块盘的符号链接）→ 降级 cp + rm。
 */
async function movePath(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(src, dst, { recursive: true, preserveTimestamps: true })
    await rm(src, { recursive: true, force: true })
  }
}

async function doSweep(opts: SweepOptions): Promise<SessionArchiveResult> {
  const archived: string[] = []
  let kept = 0
  let skipped = 0
  try {
    const dataDir = opts.dataDir ?? resolveDataDir().resolved
    const now = opts.now ?? Date.now()
    const keepCount =
      opts.keepCount ?? resolveArchiveKeepCount(await readZaiSettings())

    const srcDir = projectDirFor(dataDir, opts.cwd)
    let names: string[]
    try {
      names = await readdir(srcDir)
    } catch {
      // project 目录不存在 → 该 cwd 从没跑过会话，静默返回
      return { archived, kept, skipped }
    }

    // 候选只取 .jsonl；<sid>/ 目录与 memory/ 等都不是候选（<sid>/ 是随行者，
    // 在移动到主文件时一并带走）。
    const candidates: Array<{ sessionId: string; mtimeMs: number }> = []
    for (const name of names) {
      if (!name.endsWith(JSONL_EXT)) continue
      const sessionId = name.slice(0, -JSONL_EXT.length)
      try {
        const s = await stat(join(srcDir, name))
        candidates.push({ sessionId, mtimeMs: s.mtimeMs })
      } catch (err) {
        // 竞态删除 / 权限 → 跳过该条，不影响其余
        console.warn(`[sessionArchive] stat failed for ${name}, skipped:`, err)
      }
    }

    if (candidates.length <= keepCount) {
      return { archived, kept: candidates.length, skipped }
    }

    // 保留集 = 前 keepCount 条 ∪ { mtime >= now - 3天 }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const keepIds = new Set(candidates.slice(0, keepCount).map((c) => c.sessionId))
    const cutoffMs = now - ARCHIVE_KEEP_DAYS * 24 * 60 * 60 * 1000
    const doomed: string[] = []
    for (const c of candidates) {
      if (keepIds.has(c.sessionId)) continue
      if (c.mtimeMs >= cutoffMs) continue
      doomed.push(c.sessionId)
    }
    kept = candidates.length - doomed.length

    if (doomed.length === 0) return { archived, kept, skipped }

    const dstRoot = archiveDirFor(dataDir, opts.cwd)
    await mkdir(dstRoot, { recursive: true })

    for (const sessionId of doomed) {
      try {
        const srcJsonl = join(srcDir, `${sessionId}${JSONL_EXT}`)
        const dstJsonl = join(dstRoot, `${sessionId}${JSONL_EXT}`)

        // 保护窗：扫描与写入撞车时别把正在写的会话抽走。
        // 注意（spec §4.1）：这防的是竞态，防不住"另一实例持有 ≥3 天没写入
        // 的会话" —— 后者是已知限制。
        let mtimeMs: number
        try {
          mtimeMs = (await stat(srcJsonl)).mtimeMs
        } catch {
          skipped++ // 已被并发移走
          continue
        }
        if (now - mtimeMs < ARCHIVE_PROTECT_WINDOW_MS) {
          skipped++
          continue
        }
        if (existsSync(dstJsonl)) {
          console.warn(
            `[sessionArchive] ${sessionId}: 归档目录已存在同名文件，跳过归档`,
          )
          skipped++
          continue
        }

        await movePath(srcJsonl, dstJsonl)

        // 子 Agent transcript 目录随行；不存在就只移单文件。
        // 只移 .jsonl 会把 <sid>/ 留成永远没人认领的孤儿目录。
        const srcSub = join(srcDir, sessionId)
        if (existsSync(srcSub)) {
          const dstSub = join(dstRoot, sessionId)
          if (existsSync(dstSub)) {
            console.warn(
              `[sessionArchive] ${sessionId}: 归档目录已存在同名子目录，` +
                '主文件已归档，子目录留在原地（需人工处理）',
            )
          } else {
            await movePath(srcSub, dstSub)
          }
        }

        archived.push(sessionId)
      } catch (err) {
        // 单会话错误只 warn，不影响其余会话
        console.warn(`[sessionArchive] ${sessionId}: 归档失败(跳过):`, err)
      }
    }
  } catch (err) {
    console.warn('[sessionArchive] sweep 异常(已吞掉):', err)
  }

  // 有归档才打印，避免每次启动都刷一行
  if (archived.length > 0) {
    console.log(
      `[sessionArchive] cwd=${opts.cwd} archived=${archived.length} kept=${kept} skipped=${skipped}`,
    )
  }
  return { archived, kept, skipped }
}

let inFlight: Promise<SessionArchiveResult> | null = null

/**
 * 扫描并归档过期会话。永不抛出；in-flight 去重 —— sweep 进行中再次调用
 * 返回同一 Promise（防"启动 sweep 还没跑完用户就点了立即归档"）。
 */
export function sweepSessionArchive(
  opts: SweepOptions,
): Promise<SessionArchiveResult> {
  if (!inFlight) {
    inFlight = doSweep(opts).finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

/** 测试用 —— 清 in-flight 缓存。 */
export function __resetSessionArchiveForTests(): void {
  inFlight = null
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @zn-ai/zai test test/server/services/sessionArchive.test.ts
```

Expected: PASS（Task 1 的 8 个 + 本任务的 11 个用例全绿）。

若「保护窗」用例失败，先确认 `stat` 的 mock 确实生效（`reads` 是否等于 2）—— 候选扫描与移动前 re-stat 各读一次，共 2 次；mock 装在第二次上。

- [ ] **Step 5: 类型检查**

```bash
pnpm --filter @zn-ai/zai exec tsc --noEmit
```

Expected: 无报错。

- [ ] **Step 6: 提交**

```bash
git add packages/zai/src/server/services/sessionArchive.ts \
        packages/zai/test/server/services/sessionArchive.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 会话归档判定与移动实现"
```

---

## Task 3: 启动接入

挂进 `initAgentRuntime()`。**必须在 `restoreAllSessions(agentRegistry)` 之前** —— 否则 registry 会为已经移走的 sessionId 留下 agent 绑定。

**Files:**
- Modify: `packages/zai/src/server/services/agentRuntime.ts`（在 `await restoreAllSessions(agentRegistry)` 之前，即当前 :674 的 `// zai patch (2026-08-29, plan §3.1)` 注释块**之前**）

**Interfaces:**
- Consumes: `sweepSessionArchive({ cwd })`（Task 2）
- Produces: 无新导出（纯副作用接线）

- [ ] **Step 1: 插入钩子**

在 `initAgentRuntime` 内、`// zai patch (2026-08-29, plan §3.1): Agent 插件系统 registry 启动序列。` 这段注释块**之前**插入：

```ts
  // zai patch (2026-09-23): 归档超出保留阈值的旧会话 transcript。
  // 必须在 restoreAllSessions 之前 —— 否则 registry 会为已经移走的
  // sessionId 留下 agent 绑定。只扫本实例 cwd 对应的 project 目录。
  // 独立 try/catch：失败只 warn，绝不阻断启动，也不该被下面的
  // agent-registry catch 误报成 'agent registry init failed'。
  // 详见 docs/superpowers/specs/2026-09-23-zai-session-archive-design.md。
  try {
    const { sweepSessionArchive } = await import('./sessionArchive.js')
    await sweepSessionArchive({ cwd })
  } catch (err) {
    console.warn('[initAgentRuntime] session archive sweep failed:', err)
  }
```

- [ ] **Step 2: 类型检查**

```bash
pnpm --filter @zn-ai/zai exec tsc --noEmit
```

Expected: 无报错。

- [ ] **Step 3: 跑受影响的现有测试**

`initAgentRuntime` 被这些测试文件覆盖，改完必须确认没打破它们：

```bash
pnpm --filter @zn-ai/zai test test/server/agentRuntime.test.ts \
                              test/server/agent-runtime-server.test.ts \
                              src/server/services/__tests__/agentRuntime.repl.test.ts
```

Expected: PASS。

> 若某个测试因为 sweep 扫到真实 `~/.zai/projects` 而变慢或产生副作用，说明该测试的 `ZAI_DATA_DIR` 没隔离到临时目录 —— 在那个测试文件的 setup 里补 `process.env.ZAI_DATA_DIR = <tmpdir>`，**不要**在 `sweepSessionArchive` 里加"测试模式跳过"的分支。

- [ ] **Step 4: 提交**

```bash
git add packages/zai/src/server/services/agentRuntime.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 启动时自动归档过期会话 transcript"
```

---

## Task 4: 手动触发端点

独立 router 文件，避免动 2300 行的 `routes/agent.ts`，也让测试不必 mock 整个 `agentRuntime.js`。

**Files:**
- Create: `packages/zai/src/server/routes/sessionArchive.ts`
- Modify: `packages/zai/src/server/index.ts`（import 区 :19 附近 + mount 区 :237 附近）
- Test: `packages/zai/test/server/routes/sessionArchive.test.ts`

**Interfaces:**
- Consumes: `sweepSessionArchive`（Task 2）
- Produces: `POST /api/agent/sessions/archive` → `200 { archived: string[], kept: number, skipped: number }`

- [ ] **Step 1: 写失败测试**

创建 `packages/zai/test/server/routes/sessionArchive.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import fs from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Express } from 'express'

// sweep 内部 resolveDataDir() 读 ZAI_DATA_DIR → 隔离归档目录；
// 但 resolveArchiveKeepCount 走 readZaiSettings()，而 zaiSettingsPath() 是
// join(homedir(), '.zai', 'settings.json') —— homedir() 看 $HOME，
// **不看 ZAI_DATA_DIR**。所以 HOME 也必须隔离，否则测试会读到开发机真实的
// ~/.zai/settings.json 里的 archive.keepCount，结果不稳定。
let dataDir: string
let cwd: string
let app: Express

const DAY_MS = 24 * 60 * 60 * 1000

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'zai-archive-route-'))
  cwd = '/Users/foo/code/route-target'
  process.env.ZAI_DATA_DIR = dataDir
  process.env.HOME = dataDir
  vi.resetModules()
  const { __resetSessionArchiveForTests } = await import(
    '../../../src/server/services/sessionArchive.js'
  )
  __resetSessionArchiveForTests()
  const { default: sessionArchiveRouter } = await import(
    '../../../src/server/routes/sessionArchive.js'
  )
  app = express()
  app.use(express.json())
  app.locals.instanceContext = { cwd, cwdName: 'route-target' }
  app.use('/api', sessionArchiveRouter)
})

afterEach(async () => {
  delete process.env.ZAI_DATA_DIR
  delete process.env.HOME
  await rm(dataDir, { recursive: true, force: true })
})

async function seed(sessionId: string, daysAgo: number): Promise<void> {
  const dir = join(dataDir, 'projects', '-Users-foo-code-route-target')
  await mkdir(dir, { recursive: true })
  const f = join(dir, `${sessionId}.jsonl`)
  await writeFile(f, `${JSON.stringify({ type: 'user' })}\n`, 'utf-8')
  const t = new Date(Date.now() - daysAgo * DAY_MS)
  await utimes(f, t, t)
}

describe('POST /api/agent/sessions/archive', () => {
  it('归档本实例 cwd 的过期会话并回报结果', async () => {
    for (let i = 0; i < 20; i++) await seed(`sess-r${i}`, 1)
    await seed('sess-oldr0', 5)
    const res = await request(app).post('/api/agent/sessions/archive')
    expect(res.status).toBe(200)
    expect(res.body.archived).toEqual(['sess-oldr0'])
    expect(res.body.kept).toBe(20)
    expect(res.body.skipped).toBe(0)
    expect(
      fs.existsSync(
        join(dataDir, 'archive', 'projects', '-Users-foo-code-route-target', 'sess-oldr0.jsonl'),
      ),
    ).toBe(true)
  })

  it('没有可归档项 → 200 + archived: []（不是 5xx）', async () => {
    const res = await request(app).post('/api/agent/sessions/archive')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ archived: [], kept: 0, skipped: 0 })
  })
})
```

> 注意：这条测试**没有**注入 `keepCount`，走真实 `readZaiSettings()`。若开发机 `~/.zai/settings.json` 里有奇怪的 `archive.keepCount`，测试会不稳 —— 所以 `afterEach` 里也把 `HOME` 一起隔离更保险；如果实测不稳，在 `beforeEach` 里加 `process.env.HOME = dataDir`（与 `test/server/agentSettings-memory.test.ts:15-16` 同款）。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @zn-ai/zai test test/server/routes/sessionArchive.test.ts
```

Expected: FAIL —— 无法解析 `../../../src/server/routes/sessionArchive.js`。

- [ ] **Step 3: 写实现**

创建 `packages/zai/src/server/routes/sessionArchive.ts`：

```ts
/**
 * sessionArchive router — 手动触发会话归档。
 *
 * 唯一端点 `POST /api/agent/sessions/archive`：对**本实例 cwd** 对应的
 * project 目录跑一次归档扫描（与 initAgentRuntime 启动时那次同一实现、
 * 同一 in-flight 去重）。设置页「立即归档」按钮调它。
 *
 * 为什么独立成文件而不是塞进 routes/agent.ts：
 *   - agent.ts 已 2300+ 行；
 *   - agent.ts 的测试必须 mock 整个 agentRuntime.js 才能加载模块，而本端点
 *     完全不依赖 runtime —— 独立 router 可以用裸 express + supertest 自包含测试。
 *
 * 永不返回 5xx：sweep 自身吞掉所有异常，没有可归档项时返回 200 + archived: []。
 * 详见 docs/superpowers/specs/2026-09-23-zai-session-archive-design.md §6.2。
 */
import { Router, type IRouter, type Request, type Response } from 'express'
import { sweepSessionArchive } from '../services/sessionArchive.js'

// 必须显式标注 `: IRouter` —— 不标会触发 TS2742（推断出的类型无法在不引用
// express 内部路径的情况下命名）。仓库里 15 个 router 全部是这个写法。
const router: IRouter = Router()

router.post('/agent/sessions/archive', async (req: Request, res: Response) => {
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const result = await sweepSessionArchive({ cwd: ctx.cwd })
    res.json(result)
  } catch (err) {
    // sweep 自带 try/catch，理论上到不了这里；兜底不返 5xx。
    console.warn('[sessionArchive] route failed (swallowed):', err)
    res.json({ archived: [], kept: 0, skipped: 0 })
  }
})

export default router
```

- [ ] **Step 4: 挂载**

在 `packages/zai/src/server/index.ts`：

① import 区（当前 `:19` 的 `import agentSettingsRouter from './routes/agentSettings.js';` 下一行）加：

```ts
import sessionArchiveRouter from './routes/sessionArchive.js';
```

② mount 区（当前 `:237` 的 `app.use('/api', agentSettingsRouter);` 下一行）加：

```ts
  // 会话归档 — 手动触发（设置页「立即归档」）。启动时那次在 initAgentRuntime。
  app.use('/api', sessionArchiveRouter);
```

顺序无冲突：`routes/agent.ts` 只有 `GET|POST /agent/sessions`（精确匹配）与 `GET|DELETE|PATCH /agent/sessions/:id`，**没有** `POST /agent/sessions/:id` 会吃掉 `archive` 这一段。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @zn-ai/zai test test/server/routes/sessionArchive.test.ts
```

Expected: PASS（2 个用例）。

- [ ] **Step 6: 类型检查**

```bash
pnpm --filter @zn-ai/zai exec tsc --noEmit
```

Expected: 无报错。

- [ ] **Step 7: 提交**

```bash
git add packages/zai/src/server/routes/sessionArchive.ts \
        packages/zai/test/server/routes/sessionArchive.test.ts \
        packages/zai/src/server/index.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 新增手动触发会话归档端点"
```

---

## Task 5: 设置端点 —— GET 增补 + PUT 校验

`ZaiSettings.archive` 字段声明在 Task 1 已经加了，这里只补 API 面。

**Files:**
- Modify: `packages/zai/src/server/routes/agentSettings.ts`（GET 响应对象 :126-147；PUT 路由加在 `max-visible-messages` 之后，即当前 :244 附近）
- Test: `packages/zai/test/server/agentSettings-archive.test.ts`（Create）

**Interfaces:**
- Consumes: `toArchiveKeepCount` / `resolveArchiveKeepCount`（Task 1）
- Produces: `GET /api/agent/settings` 响应新增 `archiveKeepCount: number`；`PUT /api/agent/settings/archive-keep-count` → `{ value: number }`

- [ ] **Step 1: 写失败测试**

创建 `packages/zai/test/server/agentSettings-archive.test.ts`（setup 照抄 `test/server/agentSettings-max-visible-messages.test.ts:1-29`）：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Express } from 'express'

// 把 ZAI_DATA_DIR / HOME 隔离到一个临时目录, 避免污染真实 ~/.zai/settings.json
let dataDir: string
let app: Express

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-archive-settings-'))
  process.env.ZAI_DATA_DIR = dataDir
  process.env.HOME = dataDir
  vi.resetModules()
  const { __resetCacheForTests } = await import(
    '../../src/server/services/zaiSettingsCache.js'
  )
  __resetCacheForTests()
  const { default: agentSettingsRouter } = await import(
    '../../src/server/routes/agentSettings.js'
  )
  app = express()
  app.use(express.json())
  app.locals.instanceContext = { cwd: '/tmp', cwdName: 'test' }
  app.use('/api', agentSettingsRouter)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function onDisk(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
  )
}

describe('GET /api/agent/settings exposes archiveKeepCount', () => {
  it('defaults to 20 when settings carry no archive block', async () => {
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.archiveKeepCount).toBe(20)
  })

  it('reflects a persisted value', async () => {
    await request(app)
      .put('/api/agent/settings/archive-keep-count')
      .send({ value: 5 })
    const res = await request(app).get('/api/agent/settings')
    expect(res.body.archiveKeepCount).toBe(5)
  })
})

describe('PUT /api/agent/settings/archive-keep-count', () => {
  it('persists value to archive.keepCount and echoes back', async () => {
    const res = await request(app)
      .put('/api/agent/settings/archive-keep-count')
      .send({ value: 50 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 50 })
    expect(onDisk().archive).toEqual({ keepCount: 50 })
  })

  it('clamps below 1 to 1', async () => {
    const res = await request(app)
      .put('/api/agent/settings/archive-keep-count')
      .send({ value: 0 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 1 })
  })

  it('clamps above 1000 to 1000', async () => {
    const res = await request(app)
      .put('/api/agent/settings/archive-keep-count')
      .send({ value: 1e9 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 1000 })
  })

  it('rejects non-numeric payload with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/archive-keep-count')
      .send({ value: 'abc' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid archive\.keepCount/)
  })

  it('rejects a missing value with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/archive-keep-count')
      .send({})
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @zn-ai/zai test test/server/agentSettings-archive.test.ts
```

Expected: FAIL —— `archiveKeepCount` 为 `undefined`；PUT 路由 404。

- [ ] **Step 3: 改 GET**

在 `packages/zai/src/server/routes/agentSettings.ts`：

① import 区加：

```ts
import { resolveArchiveKeepCount, toArchiveKeepCount } from '../services/sessionArchive.js'
```

② `GET /agent/settings` handler 内，紧挨 `const autoDreamEnabled = resolveAutoDreamEnabled(settings)` 之后加：

```ts
    // 会话归档保留条数（派生值，磁盘上可能是缺失 / 垃圾值）。
    const archiveKeepCount = resolveArchiveKeepCount(settings)
```

③ `res.json({...})` 对象里，`autoDreamEnabled,` 之后加：

```ts
      archiveKeepCount,
```

- [ ] **Step 4: 加 PUT 路由**

在 `router.put('/agent/settings/max-visible-messages', ...)` 那段结束的 `},` 之后（当前 :243-244 附近）加：

```ts
/**
 * PUT /api/agent/settings/archive-keep-count — 持久化「会话归档保留条数」。
 * Body 是 `{ value: number }`，服务端 floor + clamp 到 [1, 1000]。
 *
 * 与 max-visible-messages 同款：宽容接受可转数字的字符串，非法 → 400，
 * 返回持久化后的规范值让客户端回显。
 *
 * 生效时机：写盘即持久。归档扫描只在「服务启动」与「立即归档」时读配置，
 * 所以不需要重启 —— 与 memory 三件套的"重启后生效"不同。
 */
router.put(
  '/agent/settings/archive-keep-count',
  async (req: Request, res: Response) => {
    const raw = (req.body as { value?: unknown } | undefined)?.value
    const clamped = toArchiveKeepCount(raw)
    if (clamped === null) {
      return res
        .status(400)
        .json({ error: `invalid archive.keepCount: ${String(raw)}` })
    }
    try {
      const current = await readZaiSettings()
      await updateZaiSettings({
        archive: { ...(current.archive ?? {}), keepCount: clamped },
      })
      res.json({ value: clamped })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  },
)
```

> `{ ...(current.archive ?? {}), keepCount }` 的展开是**必须**的：`updateZaiSettings` 是浅合并（`{...settings, ...patch}`），直接写 `{ archive: { keepCount } }` 会把 `archive` 块里的同级字段整个抹掉。这条模式与 `memory-auto-write` 的 PUT 完全一致（见 `test/server/agentSettings-memory.test.ts:51-65` 的回归测试）。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @zn-ai/zai test test/server/agentSettings-archive.test.ts
```

Expected: PASS（7 个用例）。

- [ ] **Step 6: 跑受影响的既有设置测试**

```bash
pnpm --filter @zn-ai/zai test test/server/agentSettings.test.ts \
                              test/server/agentSettings-memory.test.ts \
                              test/server/agentSettings-max-visible-messages.test.ts
```

Expected: PASS。

- [ ] **Step 7: 类型检查 + 提交**

```bash
pnpm --filter @zn-ai/zai exec tsc --noEmit
git add packages/zai/src/server/routes/agentSettings.ts \
        packages/zai/test/server/agentSettings-archive.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 会话归档保留条数设置端点"
```

---

## Task 6: 前端 store + 冷启动 hydrate

clamp 逻辑在两个组件里各要写一遍，抽成一个 6 行的共享 helper —— 它同时给了 hydrate 一个**真正可测的缝合点**（不必拉起整个 Layout）。

**Files:**
- Create: `packages/zai/src/web/src/lib/settingsHydrate.ts`
- Test: `packages/zai/test/web/lib/settingsHydrate.test.ts`
- Modify: `packages/zai/src/web/src/store/useAppStore.ts`（接口 `:139` 附近、默认值 `:276` 附近、setter `:419` 附近）
- Test: `packages/zai/test/web/store/useAppStore-archive.test.ts`
- Modify: `packages/zai/src/web/src/components/Layout.tsx`（destructure `:50`、hydrate `:177-183` 附近、依赖数组 `:214`）
- Modify: `packages/zai/src/web/src/components/MobileLayout.tsx`（selector `:26` 附近、hydrate `:94` 附近、依赖数组 `:117`）
- Modify: `packages/zai/src/web/src/lib/agentSessionApi.ts`（追加导出）

**Interfaces:**
- Consumes: `GET /api/agent/settings` 的 `archiveKeepCount` 字段（Task 5）
- Produces（Task 7 依赖）：
  - `clampSettingNumber(value: unknown, min: number, max: number): number | null` from `lib/settingsHydrate.js`
  - `useAppStore().archiveKeepCount: number`（默认 20）
  - `useAppStore().setArchiveKeepCount: (n: number) => void`
  - `archiveSessions(): Promise<{ archived: string[]; kept: number; skipped: number }>` from `lib/agentSessionApi.js`

- [ ] **Step 1: 写 clamp helper 的失败测试**

创建 `packages/zai/test/web/lib/settingsHydrate.test.ts`：

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { clampSettingNumber } from '../../../src/web/src/lib/settingsHydrate.js'

describe('clampSettingNumber', () => {
  it('合法数字 floor 后原样返回', () => {
    expect(clampSettingNumber(20, 1, 1000)).toBe(20)
    expect(clampSettingNumber(20.9, 1, 1000)).toBe(20)
  })

  it('clamp 到 [min, max]', () => {
    expect(clampSettingNumber(0, 1, 1000)).toBe(1)
    expect(clampSettingNumber(-5, 1, 1000)).toBe(1)
    expect(clampSettingNumber(1e9, 1, 1000)).toBe(1000)
  })

  // 关键：手编 settings.json / 后端字段缺失时不能把 undefined 变成 NaN 灌进 store，
  // 那会让 number 行显示 "NaN"。返回 null = "本次不 hydrate，保留现有值"。
  it('非 number / 非有限值返回 null（调用方跳过 hydrate）', () => {
    expect(clampSettingNumber(undefined, 1, 1000)).toBeNull()
    expect(clampSettingNumber(null, 1, 1000)).toBeNull()
    expect(clampSettingNumber('20', 1, 1000)).toBeNull()
    expect(clampSettingNumber(NaN, 1, 1000)).toBeNull()
    expect(clampSettingNumber(Infinity, 1, 1000)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @zn-ai/zai test test/web/lib/settingsHydrate.test.ts
```

Expected: FAIL —— 无法解析 `settingsHydrate.js`。

- [ ] **Step 3: 写 helper**

创建 `packages/zai/src/web/src/lib/settingsHydrate.ts`：

```ts
/**
 * 把 GET /api/agent/settings 返回的数值字段钳位到 [min, max]。
 *
 * 存在的理由有两个：
 *   1. Layout 与 MobileLayout 各要 hydrate 一遍同一批数值设置（现在有
 *      maxVisibleMessages，加 archiveKeepCount），钳位表达式不该抄两份；
 *   2. 给 hydrate 一个可单测的缝合点 —— 不必拉起整个 Layout 就能验证
 *      "手编 settings.json 写出 0/负数/字符串时不会把 NaN 灌进 store"。
 *
 * 返回 null 表示「本次不 hydrate」：字段缺失 / 类型不对时保留 store 现有值，
 * 而不是把 undefined 钳成一个数字。
 */
export function clampSettingNumber(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(min, Math.min(max, Math.floor(value)))
}
```

- [ ] **Step 4: 写 store 的失败测试**

创建 `packages/zai/test/web/store/useAppStore-archive.test.ts`：

```ts
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../../src/web/src/store/useAppStore.js'

// 模块加载瞬间的初始快照 —— 这才是 create() 给的默认值，不受后面 setState 影响。
const initialArchiveKeepCount = useAppStore.getState().archiveKeepCount

afterEach(() => {
  useAppStore.setState({ archiveKeepCount: 20 })
})

describe('useAppStore.archiveKeepCount', () => {
  it('默认 20（与服务端 resolveArchiveKeepCount 的回落值一致）', () => {
    expect(initialArchiveKeepCount).toBe(20)
  })

  it('setArchiveKeepCount 写入 store', () => {
    useAppStore.getState().setArchiveKeepCount(42)
    expect(useAppStore.getState().archiveKeepCount).toBe(42)
  })
})
```

- [ ] **Step 5: 跑 store 测试确认失败**

```bash
pnpm --filter @zn-ai/zai test test/web/store/useAppStore-archive.test.ts
```

Expected: FAIL —— `setArchiveKeepCount is not a function`。

- [ ] **Step 6: 加 store 字段**

在 `packages/zai/src/web/src/store/useAppStore.ts` 中，紧挨 `maxVisibleMessages: number;` / `setMaxVisibleMessages: (n: number) => void;` 那一对之后加：

```ts
  /**
   * 会话归档保留条数（同一 cwd 下保留最近 N 条，且 3 天内的一律保留）。
   * 默认 20. Layout / MobileLayout mount effect 用 GET /api/agent/settings 覆写.
   */
  archiveKeepCount: number;
  setArchiveKeepCount: (n: number) => void;
```

在默认值区（紧挨 `maxVisibleMessages: 20,` 之后）加：

```ts
  archiveKeepCount: 20,
```

在 setter 区（紧挨 `setMaxVisibleMessages: (n) => set({ maxVisibleMessages: n }),` 之后）加：

```ts
  setArchiveKeepCount: (n) => set({ archiveKeepCount: n }),
```

- [ ] **Step 7: 跑两个新测试确认通过**

```bash
pnpm --filter @zn-ai/zai test test/web/lib/settingsHydrate.test.ts \
                              test/web/store/useAppStore-archive.test.ts
```

Expected: PASS。

- [ ] **Step 8: Layout hydrate**

`packages/zai/src/web/src/components/Layout.tsx`：

① import 区加：

```ts
import { clampSettingNumber } from '../lib/settingsHydrate.js'
```

② `:50` 的 destructure 里，`setMaxVisibleMessages` 之后加 `setArchiveKeepCount`（同一行的解构列表里加一个名字即可）。

③ `:147` 的 `.get<{...}>` 泛型类型里加 `archiveKeepCount?: number`（与其他可选字段并列）。

④ `:183` 的 `maxVisibleMessages` hydrate 块**之后**加：

```ts
        const archiveKeepCount = clampSettingNumber(data.archiveKeepCount, 1, 1000)
        if (archiveKeepCount !== null) {
          // 与服务端 PUT handler 同款 clamp —— 手编 settings.json 写出 0/负数
          // 也不能让前端把值显示成非法的。
          setArchiveKeepCount(archiveKeepCount)
        }
```

⑤ `:214` 的依赖数组里加 `setArchiveKeepCount`。

- [ ] **Step 9: MobileLayout hydrate**

`packages/zai/src/web/src/components/MobileLayout.tsx`：

① import 区加：

```ts
import { clampSettingNumber } from '../lib/settingsHydrate.js'
```

② `:26` 附近加 selector（与相邻行同款）：

```ts
  const setArchiveKeepCount = useAppStore((s) => s.setArchiveKeepCount)
```

③ `:94` 的 `maxVisibleMessages` hydrate **之后**加：

```ts
        const archiveKeepCount = clampSettingNumber(data.archiveKeepCount, 1, 1000)
        if (archiveKeepCount !== null) {
          setArchiveKeepCount(archiveKeepCount)
        }
```

④ `:117` 的依赖数组里加 `setArchiveKeepCount`。

- [ ] **Step 10: 加前端调用 helper**

在 `packages/zai/src/web/src/lib/agentSessionApi.ts` 末尾追加：

```ts
/**
 * 手动触发一次会话归档（本实例 cwd）。设置页「立即归档」按钮调它。
 *
 * 永不抛：后端该端点也不返 5xx，任何异常都归一成"零归档"，UI 只需提示用户
 * 「没有需要归档的会话」，不必区分"失败"与"没什么可归档"。
 */
export async function archiveSessions(): Promise<{
  archived: string[]
  kept: number
  skipped: number
}> {
  const token = localStorage.getItem('zai-token') || ''
  try {
    const res = await fetch('/api/agent/sessions/archive', {
      method: 'POST',
      headers: { 'X-Zai-Token': token },
    })
    if (!res.ok) return { archived: [], kept: 0, skipped: 0 }
    const data = (await res.json()) as {
      archived?: string[]
      kept?: number
      skipped?: number
    }
    return {
      archived: Array.isArray(data.archived) ? data.archived : [],
      kept: typeof data.kept === 'number' ? data.kept : 0,
      skipped: typeof data.skipped === 'number' ? data.skipped : 0,
    }
  } catch {
    return { archived: [], kept: 0, skipped: 0 }
  }
}
```

- [ ] **Step 11: 类型检查**

```bash
pnpm --filter @zn-ai/zai exec tsc --noEmit
```

Expected: 无报错。

- [ ] **Step 12: 跑受影响的既有测试**

```bash
pnpm --filter @zn-ai/zai test test/web/components/MobileLayout.system.test.tsx
```

Expected: PASS。

- [ ] **Step 13: 提交**

```bash
git add packages/zai/src/web/src/lib/settingsHydrate.ts \
        packages/zai/test/web/lib/settingsHydrate.test.ts \
        packages/zai/src/web/src/store/useAppStore.ts \
        packages/zai/test/web/store/useAppStore-archive.test.ts \
        packages/zai/src/web/src/components/Layout.tsx \
        packages/zai/src/web/src/components/MobileLayout.tsx \
        packages/zai/src/web/src/lib/agentSessionApi.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 会话归档保留数接入前端 store 与冷启动 hydrate"
```

---

## Task 7: SettingsDrawer UI

「保留会话数」走 **schema number 行**（与「显示 → 消息最大显示条数」同款，可键盘导航）；「立即归档」按钮走**手写区块**（schema 不支持按钮行，照抄同文件「服务」区块的做法）。

**Files:**
- Modify: `packages/zai/src/web/src/components/SettingsDrawer.tsx`
- Modify: `packages/zai/src/web/src/components/SettingsDrawer.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `archiveKeepCount` / `setArchiveKeepCount` / `archiveSessions()`
- Produces: 无新导出

- [ ] **Step 1: 写失败测试**

在 `packages/zai/src/web/src/components/SettingsDrawer.test.tsx` 末尾追加：

```tsx
// McpServersSection 在 SettingsDrawer 里挂载即拉 GET /api/mcp/status,且会在
// status.commands.length 处解引用。返回 '{}' 会让它崩溃,返回 5xx 会弹全局
// notification —— 两种情况都污染这些用例。所以 stub 必须给一个合法空状态。
const MCP_STATUS_EMPTY = {
  lazyConnect: false,
  connecting: false,
  servers: [],
  commands: [],
}

describe('SettingsDrawer — 会话归档', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    useAppStore.setState({
      settingsDrawerOpen: false,
      archiveKeepCount: 20,
    })
  })

  it('schema 渲染「会话归档」section 与保留数 number 行', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/mcp/status'
          ? new Response(JSON.stringify(MCP_STATUS_EMPTY), { status: 200 })
          : new Response('{}', { status: 200 }),
      ),
    )
    useAppStore.setState({ settingsDrawerOpen: true, archiveKeepCount: 35 })
    render(<SettingsDrawer />)
    // 必须断言完整标题:section 名带刻意的「(立即生效)」后缀,而 getByText
    // 默认是子串匹配 —— 只写「会话归档」会同时命中祖先容器,报 multiple elements。
    expect(screen.getByText('会话归档 (立即生效)')).toBeInTheDocument()
    expect(screen.getByText('保留会话数')).toBeInTheDocument()
    expect(screen.getByText('35')).toBeInTheDocument()
  })

  it('渲染「立即归档」按钮，点击后 POST /api/agent/sessions/archive 并提示条数', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/agent/settings' && (!init || !init.method)) {
        return new Response(JSON.stringify({}), { status: 200 })
      }
      if (url === '/api/agent/sessions/archive') {
        return new Response(
          JSON.stringify({ archived: ['a', 'b'], kept: 20, skipped: 0 }),
          { status: 200 },
        )
      }
      if (url === '/api/mcp/status') {
        return new Response(JSON.stringify(MCP_STATUS_EMPTY), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    useAppStore.setState({ settingsDrawerOpen: true, archiveKeepCount: 20 })
    render(<SettingsDrawer />)
    fireEvent.click(screen.getByTestId('settings-run-archive'))
    await screen.findByText(/已归档 2 个会话/)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent/sessions/archive',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
```

> **写计划时踩到的两个坑（已修正）**：① 必须断言完整 section 标题 `会话归档 (立即生效)`，只写 `会话归档` 会因 `getByText` 的子串匹配同时命中祖先容器而报 multiple elements；② fetch stub 必须让 `GET /api/mcp/status` 返回合法空状态，否则 `McpServersSection` 崩溃或弹 notification 污染用例。这两点都是实测出来的，不是推测。

需要在文件顶部 import 里补 `vi`（若已有则跳过）与确认已 import `fireEvent`（当前 `:4` 已有）。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/SettingsDrawer.test.tsx
```

Expected: FAIL —— 找不到「会话归档」文本与 `settings-run-archive` testid。

- [ ] **Step 3: schema 参数与 section**

在 `packages/zai/src/web/src/components/SettingsDrawer.tsx`：

① `buildStaticSchema` 签名（`:581-595`）在 `maxVisibleMessages: number,` **之后**加一个参数：

```ts
  archiveKeepCount: number,
```

② 在 `buildStaticSchema` 返回数组的末尾（`:854` 的 `自动记忆` section 对象之后、`]` 之前）加：

```ts
    {
      // 会话归档 —— 同一 cwd 下保留最近 N 条，且 3 天内修改过的一律保留；
      // 其余在服务启动时（或手动点「立即归档」时）移入 ~/.zai/archive/。
      // 标题里带「立即生效」是刻意的：归档扫描每次读盘，不需要重启
      // （与上面「自动记忆 (重启后生效)」相反，别照抄那行的时效说明）。
      // 3 天窗口是服务端常量，不暴露在这里 —— 缓存需求只要求数量阈值可配。
      section: '会话归档 (立即生效)',
      rows: [
        {
          key: 'archiveKeepCount',
          label: '保留会话数',
          kind: 'number',
          value: archiveKeepCount,
          min: 1,
          max: 1000,
          step: 1,
        },
      ],
    },
```

- [ ] **Step 4: 接线 store → schema**

① `:921-922` 附近加 selector：

```ts
  const archiveKeepCount = useAppStore((s) => s.archiveKeepCount)
  const setArchiveKeepCount = useAppStore((s) => s.setArchiveKeepCount)
```

② `:974-976` 的 `useState<SettingsSchema>` 初始化调用里，`maxVisibleMessages` 之后插入 `archiveKeepCount`：

```ts
  const [schema, setSchema] = useState<SettingsSchema>(() =>
    buildStaticSchema(theme, outputStyle, workMode, maxVisibleMessages, archiveKeepCount, defaultSplitScreen, enableDynamicWorkflow, enableComputerUse, autoUpdate, memoryAutoWrite, memoryRequireApproval, autoDreamEnabled, mainAgent, agentOptions),
  )
```

③ 紧接 `:1069` 的 `maxVisibleMessages` 同步 effect 之后，加一个同款 effect：

```ts
  // 同步 store archiveKeepCount → schema.archiveKeepCount 行。
  // 与 maxVisibleMessages 行同款：store 是 settings.json 持久化的真源，
  // 这里单向把已持久化的值投影到 schema 渲染态。
  useEffect(() => {
    setSchema((prev) =>
      prev.map((s) => ({
        ...s,
        rows: s.rows.map((r) => {
          if (r.key === 'archiveKeepCount' && r.kind === 'number') {
            return { ...r, value: archiveKeepCount }
          }
          return r
        }),
      })),
    )
  }, [archiveKeepCount])
```

④ `handleChange` 里，紧接 `:1267` 的 `maxVisibleMessages` 分支之后加：

```ts
      // 会话归档保留条数走 store + PUT settings.json 持久化路径（同
      // maxVisibleMessages）：clamp 到 [1, 1000] 再写 store，server 端会再
      // 做一次 floor + clamp 兜底。注意这里不需要重启 —— 归档扫描每次
      // 「服务启动」或「立即归档」时读盘，写盘即生效。
      if (key === 'archiveKeepCount' && typeof value === 'number') {
        const clamped = Math.max(1, Math.min(1000, Math.floor(value)))
        setArchiveKeepCount(clamped)
        void fetch('/api/agent/settings/archive-keep-count', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: clamped }),
        }).catch(() => {
          // swallow — 下次 GET 会重新对齐磁盘状态
        })
      }
```

⑤ `:1381` 的 `useCallback` 依赖数组里加 `setArchiveKeepCount`。

- [ ] **Step 5: 加「立即归档」按钮**

① 文件顶部 import 区加：

```ts
import { archiveSessions } from '../lib/agentSessionApi.js'
```

（`message` 若未 import，从 `antd` 一并引入 —— 该文件已在用 AntD，按现有 import 风格加。）

② 组件内加状态（紧挨 `const [weixinState, setWeixinState] = useState<string | null>(null)` 附近）：

```ts
  // 「立即归档」按钮的进行中标记 —— 防重复点击。
  const [archiving, setArchiving] = useState(false)
```

③ 在 `<SettingsList schema={schema} onClose={close} onChange={handleChange} />`（`:1521`）**之后**、`<McpServersSection ... />` **之前**插入：

```tsx
      {/* 手动触发一次归档。刻意不做 Modal.confirm —— 归档只是把文件移到
          ~/.zai/archive/，可逆；这里用 confirm 的只有「服务」区块（重启会
          中断对话）。文案必须写清「3 天」与两个触发时机，否则用户无法预期
          它什么时候跑。 */}
      <div
        data-testid="settings-archive-section"
        className="mt-4 pt-2 border-t border-[var(--border-subtle)]"
      >
        <div className="text-[11px] text-[var(--text-dim-45)] mb-2 leading-[1.6]">
          保留最近 N 条，且 3 天内修改过的一律保留；其余在服务启动时移入
          ~/.zai/archive/。也可立即触发一次。
        </div>
        <Button
          size="small"
          loading={archiving}
          data-testid="settings-run-archive"
          onClick={async () => {
            setArchiving(true)
            try {
              const { archived } = await archiveSessions()
              if (archived.length > 0) {
                message.success(`已归档 ${archived.length} 个会话`)
              } else {
                message.info('没有需要归档的会话')
              }
            } finally {
              setArchiving(false)
            }
          }}
        >
          立即归档
        </Button>
      </div>
```

- [ ] **Step 6: 跑测试确认通过**

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/SettingsDrawer.test.tsx
```

Expected: PASS（含新增 2 个用例 + 原有 number row / 微信门控用例）。

- [ ] **Step 7: 跑其余 SettingsDrawer 测试 + 类型检查**

```bash
pnpm --filter @zn-ai/zai test test/web/components/SettingsDrawer.restart.test.tsx \
                              test/web/components/SettingsDrawer.mobile-managed.test.tsx
pnpm --filter @zn-ai/zai exec tsc --noEmit
```

Expected: PASS / 无报错。

- [ ] **Step 8: 提交**

```bash
git add packages/zai/src/web/src/components/SettingsDrawer.tsx \
        packages/zai/src/web/src/components/SettingsDrawer.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 设置页新增会话归档保留数与立即归档"
```

---

## Task 8: 真实浏览器验收（**先问用户**）

`AGENTS.md` 规定：真实浏览器验收**非必须，先询问用户**。用户确认后再执行。

**Files:** 无（只读验证）

- [ ] **Step 1: 询问用户**

用 `AskUserQuestion` 问：是否要跑 ego-browser 真实浏览器验收？说明会起一个 8102 端口的 dev 实例。

- [ ] **Step 2:（用户确认后）确认端口空闲并起服务**

```bash
lsof -i :8102 ; lsof -i :7715
pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715
```

端口被占用 → **报错退出，不要 kill 占用进程，不要换端口**，改用另一个空闲端口重新确认。

- [ ] **Step 3: 走用户路径**

经 `/ego-browser` skill：

1. 打开 `http://localhost:8102/agent`；
2. 打开设置抽屉（左滑 / 设置按钮）；
3. 确认「会话归档 (立即生效)」section、`保留会话数` 行显示当前值、`立即归档` 按钮可见；
4. 把保留数改成明显偏小的值（如 3），确认无报错；
5. 点「立即归档」，确认出现 `已归档 N 个会话` 或 `没有需要归档的会话` 提示；
6. **度量出像素级证据**（`getBoundingClientRect` / `getComputedStyle` / 截图），不要只截图目测。

- [ ] **Step 4: 核对落盘**

```bash
ls ~/.zai/archive/projects/ | head
ls ~/.zai/archive/projects/<当前实例的 encoded-cwd>/ | head
```

确认归档目录结构与 `~/.zai/projects/<encoded-cwd>/` 同构，且源目录里对应文件已消失。

- [ ] **Step 5: 收尾**

停掉 8102 实例（**只停这个 dev 进程**，不碰 920x）。把验收结论（通过 / 发现的问题）报告给用户；发现问题则回到对应 Task 修，不要新建 task 掩盖。

---

## Self-Review 记录

**Spec 覆盖**（逐节对照 `docs/superpowers/specs/2026-09-23-zai-session-archive-design.md`）：

| Spec 节 | 覆盖任务 |
|---|---|
| §2 D1（纯磁盘收纳、无 UI） | Task 2（不加任何列表/恢复）+ Task 7（只加保留数 + 按钮） |
| §2 D2（只扫本实例 cwd） | Task 3（`{ cwd }`）+ Task 4（`ctx.cwd`） |
| §2 D3（`.jsonl` + `<sid>/` 整组） | Task 2 Step 3（`movePath(srcSub, dstSub)`） |
| §2 D4（只配 keepCount） | Task 1（`toArchiveKeepCount`）+ Task 5（PUT）+ Task 7（number 行） |
| §2 D5（10 分钟保护窗） | Task 2 Step 3（`ARCHIVE_PROTECT_WINDOW_MS` 判定）+ 对应测试 |
| §2 D6（手动触发） | Task 4（router）+ Task 6（`archiveSessions`）+ Task 7（按钮） |
| §3 路径与归档单元 | Task 1 Step 1（路径测试）+ Task 2（`<sid>/` 随行测试） |
| §3.1 `sanitizePath` 单一实现 | Task 0（core 导出）+ Task 1（import 而非内联）+ Task 1 的对拍用例 |
| §4 判定算法 | Task 2 Step 1 全部判定用例 |
| §4.2 边界（0 字节 / stat 失败 / 目录不存在 / 未来 mtime） | Task 2（0 字节用例、目录不存在用例；未来 mtime 天然进保留集，被 keepCount 前 N 兜住，不单测） |
| §5 配置 + 解析函数 | Task 1 Step 3 + Task 5 |
| §6.1 启动触发点（restore 之前） | Task 3 |
| §6.2 手动触发 + 独立 router | Task 4 |
| §6.3 in-flight 去重 | Task 2 Step 1「并发调用」用例 + Task 2 Step 3 `inFlight` |
| §7 服务实现（EXDEV / 同名跳过 / 永不抛 / 日志） | Task 2 Step 3 |
| §8.1 number 行 + store + hydrate | Task 6 + Task 7 Step 3/4 |
| §8.2 按钮 + `archiveSessions` + 无 confirm | Task 6 Step 10 + Task 7 Step 5 |
| §11.1 服务单测 | Task 1 + Task 2 |
| §11.2 路由单测 | Task 4 |
| §11.3 设置端点测试 | Task 5 |
| §11.4 前端测试 | Task 6 Step 1/4 + Task 7 Step 1 |
| §11.5 ego 验收 | Task 8 |

**占位符扫描**：无 TBD / TODO / "类似 Task N" / "适当处理错误"。所有代码步骤都给了可粘贴的完整代码。

**类型一致性核对**：
- `SessionArchiveResult` 在 Task 2 定义，Task 4 的路由与 Task 6 的 `archiveSessions()` 返回值形状一致（`archived: string[]; kept: number; skipped: number`）。
- `SweepOptions` 的 `dataDir` / `now` / `keepCount` 三个可注入参数在 Task 2 的测试里全部用到了；Task 3 / Task 4 的生产调用只传 `cwd`（其余走默认值），与 spec §7 一致。
- `toArchiveKeepCount` / `resolveArchiveKeepCount` 在 Task 1 定义，Task 5 同时用到两者 —— 名字与 spec §5.2 一致。
- `sanitizePath` 在 Task 0 从 core 导出，Task 1 import 使用（原名、原签名 `(name: string) => string`）。
- `clampSettingNumber` 在 Task 6 Step 3 定义，同任务 Step 8/9 的两个 hydrate 调用点与 Step 1 的测试三处签名一致（`unknown, number, number → number | null`）。
- store 字段名 `archiveKeepCount` / setter `setArchiveKeepCount` 在 Task 6 与 Task 7 中一致。
- testid `settings-run-archive` / `settings-archive-section` 在 Task 7 的测试与实现中一致。

**已知的取值取舍**：`kept` 定义为「保留集大小」而非「扫描后实际留在磁盘上的条数」（被保护窗/同名跳过的条目仍会算进 `archived` 之外的 kept）。这与 spec §7 的定义一致，UI 只展示 `archived.length`，不展示 `kept`，所以不会造成用户困惑。

**保护窗可达性（写计划时发现的要点）**：判定条件「早于 3 天」与保护窗「10 分钟」在**重新读取到的同一 mtime** 上不可能同时成立 —— 所以保护窗唯一可达的路径是**扫描与写入撞车**：候选扫描时的第一次 `stat` 读到旧 mtime（进归档集），移动前的第二次 `stat` 读到刚被写入的新 mtime（触发跳过）。实现里那第二次 `stat` 存在的意义就是它。因此 Task 2 的「保护窗」用例必须 mock `stat` 才能覆盖，不能靠铺文件 + `utimes` 构造。**不要**因为"看着像死代码"就删掉这个分支。

**测试隔离的关键事实**：`zaiSettingsPath()` = `join(homedir(), '.zai', 'settings.json')`，`homedir()` 读 `$HOME` 而**不读** `ZAI_DATA_DIR`。全局 `test/setup.isolation.ts` 只隔离了 `ZAI_DATA_DIR`。所以任何让 `sweepSessionArchive` 走默认 `keepCount`（即调用真实 `readZaiSettings()`）的测试都必须自己设 `process.env.HOME`。Task 4 的 `beforeEach` 已这样做。

**core 改动的连锁**：Task 0 是唯一改 `zn-agent-core` 的任务，且**必须**跟一次 `pnpm run build:core`，否则 zai 侧 import 到的 `dist/` 仍是旧产物、`sanitizePath` 取不到值（`undefined is not a function`）。Task 1 的 import 一旦失败，先回查 Task 0 Step 5 的 `node -e` 验证输出。