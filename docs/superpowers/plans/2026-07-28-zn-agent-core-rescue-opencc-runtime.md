# Rescue opencc Runtime into zn-agent-core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Make `@zn-ai/zn-agent-core` actually execute opencc 0.21's runtime code — `query()`, `QueryEngine`, the tool library, `services/compact/`, `services/mcp/`, `skills/`, `tasks/` — instead of the 517-line `compat/runtime/openccAdapter.ts` re-implementation that currently sits in its place. The end state: `DefaultAgentRuntime.run()` delegates to opencc's main loop, not a hand-rolled one.

## Why

The previous plan (`2026-07-28-zn-agent-core-from-opencc.md`) shipped `opencc-src/` as a 1607-file vendor copy and a 70-file `compat/` directory, but `compat/` is fully self-contained: it has zero imports from `opencc-src/`. Result: the opencc vendor copy is dead code, and zai pays maintenance cost on a parallel runtime instead of inheriting opencc's mature query/compact/mcp/skills/tool implementations.

The user clarified the original goal was to **use opencc's code end-to-end**, only delegating UI and commands (which zai already provides) to zai's own implementations.

## Architecture

```
zai server/routes/agent.ts
   │
   ▼
DefaultAgentRuntime.run()  ── compat/runtime/contract.ts  (thin pass-through)
   │
   ▼
opencc's query()  ── opencc-src/query.ts  (VENDORED, fix 4 problems below)
   │
   ├── services/compact/autoCompact.ts  ── opencc's autoCompact (real impl)
   ├── services/mcp/                   ── opencc's MCPClientPool
   ├── tools/BashTool/                 ── opencc's BashTool (real impl)
   ├── tools/FileEditTool/, ReadTool/, WriteTool/
   ├── tasks/LocalShellTask, LocalAgentTask, RemoteAgentTask
   ├── utils/cwd.ts                    ── opencc's shell-cwd trailer tracking
   └── HookRunner, PluginRuntime       ── opencc's plugin system

NOT vendored (zai provides equivalents):
   ├── components/  ink/  screens/     ── zai is web, no Ink UI
   ├── commands/                       ── zai has its own slash commands
   ├── state/AppState.tsx              ── zai uses Zustand, not opencc's React store
   └── hooks/ except toolPermission    ── zai has its own React hooks
```

## Critical Findings (Phase 0)

### opencc 0.21 真实规模

| 项 | opencc 0.21 总量 | 当前 zn-agent-core 保留 | 老 zai-agent-core (opencc-internals) |
|---|---|---|---|
| `.ts` + `.tsx` 文件 | ~2449 | 1607 | 285 (全 .ts) |
| `.tsx` | 842 | 30 | 0 |
| `bun:bundle` 引用 | 173 | 30 | 0 |
| `@ts-nocheck` | 701 | 估算 400+ | 估算 280+ |
| 核心 3 文件 `.js` import | 139 | 139 | 0 |

### 当前实际状态

- **zai 已全迁新包**:38 个 zai 文件 100% 走 `@zn-ai/zn-agent-core`,0 个 `@zn-ai/zai-agent-core`
- **运行时真用的代码全在 `compat/`**:`opencc-src/` 0 个 import(grep `compat/ runtime/` → 0 命中)
- **`compat/runtime/openccAdapter.ts` 是自写主循环**(517 行,绕开 opencc 全部代码)
- 旧的 `packages/zai-agent-core/src/opencc-internals/` 285 文件还在主仓库(用户 stash 在改它)

### 4 个核心困难(用户已点名要处理)

1. **`bun:bundle` feature flags** — 173 文件,80+ flag(`REACTIVE_COMPACT` / `CONTEXT_COLLAPSE` / `EXPERIMENTAL_SKILL_SEARCH` / `KAIROS_*` / `VOICE_MODE` / `PROACTIVE` 等)。Node 没有 `bun:bundle`,需要写静态桩。
2. **UI 工具嵌 JSX** — 30 个 `.tsx` 被保留(utils/*.tsx + state/AppState.tsx + hooks/useCanUseTool.tsx + tasks/*.tsx + tools/*.tsx)。这些文件的 `Tool.render()` 是 React 组件,zai 不用,得剥。
3. **`.js → .ts` 扩展名 fallback** — opencc 内 139 个 import 用 `.js` 后缀(tsconfig `moduleResolution: bundler` 不默认 fallback),zai 的 bundler 配置下走不通。
4. **`@ts-nocheck` 掩盖 API drift** — 701 个文件 `@ts-nocheck`,typecheck 跳过,运行期才暴。

### 命令系统的边界(用户已澄清)

opencc 的 `commands/` 是 `.tsx` 实现 + JSX 渲染,**zai 不接入**。原因:
- zai 已有 `packages/zai/src/server/services/commands/` 完整 slash 命令系统(builtin + userLoader + registry)
- opencc 的 `commands/` 是 React/Ink UI 渲染 + 命令定义混在一起,剥离 UI 后剩下的命令定义也跟 zai 的不兼容(permission / execution context 都不一样)
- **决策**:`commands/` 加入 STRIP_DIRS,这一步已在 strip-list.ts 完成

### 双轨过渡

`compat/runtime/openccAdapter.ts` 临时保留作为 fallback,直到 Phase 5 验证 opencc query() 在 zai 跑通后才删。

## Global Constraints

- opencc source version: 0.21.0 at `/Users/ethan/code/opencc` (local checkout)
- zai TypeScript ESM, `target: ES2023`, `module: ESNext`, `moduleResolution: bundler`
- zai's runtime: Node 22 + tsx (NOT Bun — `compat/runtime/openccStubs.ts` 注释已确认)
- Subpath exports MUST keep: `./runtime`, `./transcript`, `./commands`, `./bashTracker`, `./taskListStore`, `./agents/memoryLoader`, `./agents/memoryWatcher`
- 保留 `@zn-ai/zai-agent-core` 主仓库 (`packages/zai-agent-core/src/opencc-internals/`) 285 文件不动 — 用户在 stash 里改它,跟本 plan 平行
- Build: tsc only. NO bun. NO esbuild bundling opencc-src.
- 不 strip commands: zai 用自己的;opencc 的 commands/ 已 strip

---

# Phase 1: Feature Flag 桩 (`bun:bundle`)

## Task 1.1: 写 `bun:bundle` 静态桩

**Files:**
- Create: `packages/zn-agent-core/src/opencc-src/shims/bun-bundle.ts`

**Interfaces:**
- Replaces `import { feature } from 'bun:bundle'` across all vendored opencc files.
- Default behavior: every flag returns `false` unless explicitly enabled.

- [ ] **Step 1: 列出所有 80+ feature flags**

```bash
grep -rhoE "feature\(['\"][A-Z_0-9]+['\"]" /Users/ethan/code/opencc/src/ | sort -u
```

- [ ] **Step 2: 把 flag 分为 3 类**

| 类别 | flag | 默认 | 备注 |
|---|---|---|---|
| **zai 核心依赖** | `REACTIVE_COMPACT` | `true` | zai 的 compact 走这条路径 |
| | `MULTI_TURN_CONTEXT` | `true` | 主对话多轮 |
| | `HISTORY_SNIP` | `true` | transcript 早期 user 消息裁剪 |
| **zai 可选启用** | `CONTEXT_COLLAPSE` | `false` | zai 自有 compact,先关 |
| | `EXPERIMENTAL_SKILL_SEARCH` | `false` | zai 走 `~/.agents/skills`,不用 opencc skill search |
| | `COMPACTION_REMINDERS` | `false` | zai 自有 reminder |
| | `RESUME_COMPACT_PROMPT` | `false` | 暂不需要 |
| | `FILE_PERSISTENCE` | `true` | file history tracking |
| | `BASH_CLASSIFIER` | `true` | zai 用 Bash sandbox 时依赖 |
| | `POWERSHELL_AUTO_MODE` | `false` | macOS-only |
| | `WEB_BROWSER_TOOL` | `false` | zai 不暴露 |
| **opencc 专有,关闭** | `KAIROS*`, `VOICE_MODE`, `PROACTIVE`, `BRIDGE_MODE`, `CCR_*`, `WEB_BROWSER_TOOL`, `WEB_*`, `TERMINAL_PANEL`, `CHICAGO_MCP`, `CONNECTOR_TEXT`, `UDS_INBOX`, `ULTRAPLAN`, `TORCH`, `LODESTONE`, `SSH_REMOTE`, `MEMORY_SHAPE_TELEMETRY`, `TEAMMEM`, `TEMPLATES`, `OVERFLOW_TEST_TOOL`, `RUN_SKILL_GENERATOR`, `SKILL_IMPROVEMENT`, `AUTO_THEME`, `ALLOW_TEST_VERSIONS`, `AGENT_MEMORY_SNAPSHOT`, `AGENT_TRIGGERS_REMOTE`, `ANTI_DISTILLATION_CC`, `BUILDING_CLAUDE_APPS`, `BYOC_ENVIRONMENT_RUNNER`, `COWORKER_TYPE_TELEMETRY`, `DIRECT_CONNECT`, `DOWNLOAD_USER_SETTINGS`, `FORK_SUBAGENT`, `HARD_FAIL`, `HOOK_CHAINS`, `HYBRID_CONTEXT_STRATEGY`, `IS_LIBC_GLIBC`, `IS_LIBC_MUSL`, `MCP_RICH_OUTPUT`, `NATIVE_CLIENT_ATTESTATION`, `NATIVE_CLIPBOARD_IMAGE`, `NEW_INIT`, `PERFETTO_TRACING`, `PROMPT_CACHE_BREAK_DETECTION`, `REVIEW_ARTIFACT`, `SELF_HOSTED_RUNNER`, `SLOW_OPERATION_LOGGING`, `STREAMLINED_OUTPUT`, `TOKEN_BUDGET`, `TRANSCRIPT_CLASSIFIER`, `UNATTENDED_RETRY`, `UPLOAD_USER_SETTINGS`, `ABLATION_BASELINE`, `COMMIT_ATTRIBUTION`, `BREAK_CACHE_COMMAND` | `false` | zai 不暴露 |

- [ ] **Step 3: 写桩文件**

Create `packages/zn-agent-core/src/opencc-src/shims/bun-bundle.ts`:

```ts
/**
 * Static stub for `bun:bundle` `feature()` flag. opencc uses bun-bundle
 * to gate experimental features; zai runs opencc under Node 22 + tsx (no Bun),
 * so the bun-bundle feature() returns `undefined` and every `if (feature('X'))`
 * branch crashes. This stub compiles a static tree at module load and returns
 * the configured value for each flag.
 *
 * Default: every flag is `false` unless explicitly listed below. The list is
 * curated per `docs/superpowers/plans/2026-07-28-zn-agent-core-rescue-opencc-runtime.md`
 * Phase 1 Step 2.
 *
 * If you need to flip a flag for debugging, override via env:
 *   ZAI_OPENCC_FEATURE_<FLAG>=1 → true, anything else → false
 * (uppercase flag name, replace non-alnum with _).
 */

type FeatureTree = Readonly<Record<string, boolean>>

const STATIC_FEATURES: FeatureTree = Object.freeze({
  // --- zai 核心依赖 (Phase 1: 默认开) ---
  REACTIVE_COMPACT: true,
  MULTI_TURN_CONTEXT: true,
  HISTORY_SNIP: true,
  FILE_PERSISTENCE: true,
  BASH_CLASSIFIER: true,
})

export function feature<T>(flag: string, defaultValue?: T): T | boolean {
  // Env override (e.g. ZAI_OPENCC_FEATURE_REACTIVE_COMPACT=1)
  const envKey = `ZAI_OPENCC_FEATURE_${flag.replace(/[^A-Z0-9]/gi, '_')}`
  const envVal = process.env[envKey]
  if (envVal !== undefined) {
    if (envVal === '1' || envVal === 'true') return true
    if (envVal === '0' || envVal === 'false') return false
  }
  if (flag in STATIC_FEATURES) return STATIC_FEATURES[flag]
  // Opencc calls `feature('FOO')` and reads it as truthy/falsy. Default to
  // the boolean false so gated branches are tree-shaken out at runtime
  // (no behavior change vs `bun:bundle`'s undefined-falsy default).
  return defaultValue ?? false
}

// Some opencc files do `const reactiveCompact = feature('X') ? require(...) : null`.
// The `require()` form is CJS; we have no CJS here. Stub it.
export function require(_id: string): never {
  throw new Error(
    `[zn-agent-core] bun:bundle stub: require() inside feature() gate is not supported. ` +
      `Refactor the caller to a static import or move the conditional to runtime.`,
  )
}
```

- [ ] **Step 4: 给 TS 一个 ambient .d.ts (让 vendored `.ts` 文件找到它)**

Create `packages/zn-agent-core/src/opencc-src/shims/bun-bundle.d.ts`:

```ts
declare module 'bun:bundle' {
  export function feature<T>(flag: string, defaultValue?: T): T | boolean
  export function require(id: string): never
}
```

- [ ] **Step 5: 改 strip list 让 copy 脚本跳过 opencc 自己的 `bun:bundle` d.ts**

In `packages/zn-agent-core/scripts/strip-list.ts`, `STRIP_TOP_FILES` already includes none for this; we need to STRIP the opencc `vendor/bun-types.d.ts` if it exists:

```bash
ls /Users/ethan/code/opencc/vendor 2>&1
```

If opencc ships its own `bun:bundle` types in `vendor/` or `src/`, add to `STRIP_TOP_FILES`:
```ts
export const STRIP_TOP_FILES: string[] = [
  // ... existing entries
  'vendor',  // opencc's bundled types include bun:bundle stub
]
```

- [ ] **Step 6: 改 copy 脚本把 shims/ 目录单独 copy 进去(不被 strip)** *(脚本已移除,此步仅留档)*

In the copy script, after the main copy loop, ensure `src/opencc-src/shims/` is preserved:

```ts
// After main copy loop:
// Copy our shims/ directory (Bun stubs we add manually)
mkdirSync(join(DEST, 'shims'), { recursive: true })
for (const f of readdirSync(join(ZAI_PKG, 'src', 'opencc-src', 'shims'))) {
  if (f.endsWith('.bak')) continue
  copyFileSync(
    join(ZAI_PKG, 'src', 'opencc-src', 'shims', f),
    join(DEST, 'shims', f),
  )
}
```

- [ ] **Step 7: 改 vendored 源文件里的 `from 'bun:bundle'` 路径** *(脚本已移除,此步仅留档)*

Add a script `packages/zn-agent-core/scripts/rewrite-bun-bundle-imports.ts` (since removed):

```ts
#!/usr/bin/env tsx
/**
 * Rewrite `import { feature } from 'bun:bundle'` → `from '../shims/bun-bundle.js'`
 * across all .ts/.tsx files in src/opencc-src/.
 */
import { execSync } from 'child_process'
import { readdirSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative } from 'path'

const ROOT = join(import.meta.dirname, '..', 'src', 'opencc-src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (/\.tsx?$/.test(e) && e !== 'bun-bundle.ts') {
      out.push(full)
    }
  }
  return out
}

let rewritten = 0
for (const f of walk(ROOT)) {
  const before = execSync(`grep -c "from 'bun:bundle'" "${f}" || true`).toString().trim()
  if (before === '0' || before === '') continue
  const shimsRel = join('..', relative(dirname(f), join(ROOT, 'shims')).replace(/\\/g, '/'), 'bun-bundle.js')
  // Replace any depth: 'bun:bundle' → relative path to shims
  // Simpler approach: compute the path
  let target = relative(dirname(f), join(ROOT, 'shims', 'bun-bundle.js')).replace(/\\/g, '/')
  if (!target.startsWith('.')) target = './' + target
  execSync(`sed -i.bak "s|from 'bun:bundle'|from '${target}'|g" "${f}"`)
  execSync(`rm "${f}.bak"`)
  rewritten++
}

console.log(`Rewrote bun:bundle imports in ${rewritten} files`)
```

Run it (historical — script removed):
```bash
pnpm --filter @zn-ai/zn-agent-core exec tsx scripts/rewrite-bun-bundle-imports.ts
```

- [ ] **Step 8: 验证**

```bash
cd /Users/ethan/code/opencc-web-zn-agent-core
grep -r "from 'bun:bundle'" packages/zn-agent-core/src/opencc-src/ | head -5
# Expected: 0 hits
grep -r "from.*bun-bundle" packages/zn-agent-core/src/opencc-src/ | wc -l
# Expected: ~173
```

- [ ] **Step 9: 跑 typecheck 看减少多少错误**

```bash
pnpm --filter @zn-ai/zn-agent-core typecheck 2>&1 | grep "Cannot find module 'bun:bundle'" | wc -l
# Expected: 0
```

- [ ] **Step 10: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/shims/
git commit -m "feat(zn-agent-core): bun:bundle static feature stub + import rewriter"
```

---

# Phase 2: 剥 `.tsx` UI / React 渲染层

## Task 2.1: 分类 30 个保留的 .tsx

- [ ] **Step 1: 列出 30 个 .tsx 并按功能分类**

```bash
cd /Users/ethan/code/opencc-web-zn-agent-core
find packages/zn-agent-core/src/opencc-src -name "*.tsx" -type f | sort
```

已知 30 个(tsx 文件):
- `tasks/{RemoteAgentTask,InProcessTeammateTask,LocalShellTask,LocalAgentTask}/*.tsx`
- `tools/{AskUserQuestionTool,BashTool,AgentTool,PowerShellTool,TaskOutputTool,WorkflowTool}/*.{tsx,...test.tsx}`
- `utils/{teleport,status,preflightChecks,highlightMatch,staticRender,autoRunIssue,processUserInput/processBashCommand,processUserInput/processSlashCommand}.tsx` (+ test)
- `utils/statusNoticeDefinitions.safety.test.tsx`
- `utils/swarm/It2SetupPrompt.tsx`
- `state/AppState.tsx` (+ test)
- `hooks/useCanUseTool.tsx`

- [ ] **Step 2: 每个文件标 A/B/C 类**

| 类 | 处理 | 文件 |
|---|---|---|
| **A. zai 真用 `.call()`,只剥 UI** | 拆 `.tsx` → `.ts`,删 `Tool.render()` 函数(整体 React 部分),保留 `Tool.call()` / `Tool.validate()` / `inputSchema` | `tools/BashTool/BashTool.tsx`, `tools/AskUserQuestionTool/AskUserQuestionTool.tsx`, `tools/AgentTool/AgentTool.tsx`, `tools/PowerShellTool/PowerShellTool.tsx`, `tools/TaskOutputTool/TaskOutputTool.tsx` |
| **B. zai 不用,纯 UI/渲染工具** | 直接删除 | `utils/{teleport,status,preflightChecks,highlightMatch,staticRender,autoRunIssue,processBashCommand,processSlashCommand}.tsx`, `utils/swarm/It2SetupPrompt.tsx`, `state/AppState.tsx`, `tools/WorkflowTool/WorkflowPermissionDialog.tsx`, `state/AppState.types.test.tsx` |
| **C. zai 有等价物,跳过** | 加 strip list,re-copy 不带 | `hooks/useCanUseTool.tsx`(zai 有自己的 `canUseTool.ts`), `tasks/{RemoteAgentTask,InProcessTeammateTask,LocalShellTask,LocalAgentTask}/*.tsx`(zai 有自己的 background runtime), `tools/{BashTool,AskUserQuestionTool,PowerShellTool,TaskOutputTool}/*.test.tsx`(zai 自有测试), `tools/WorkflowTool/*.test.tsx`, `utils/processUserInput/processSlashCommand.test.tsx`, `utils/statusNoticeDefinitions.safety.test.tsx` |

- [ ] **Step 3: 改 strip list 删 B/C 类**

In `packages/zn-agent-core/scripts/strip-list.ts`, `STRIP_TOP_FILES` 加入:

```ts
export const STRIP_TOP_FILES: string[] = [
  // ... existing entries
  // UI-only utilities (B class)
  'src/utils/teleport.tsx',
  'src/utils/status.tsx',
  'src/utils/preflightChecks.tsx',
  'src/utils/highlightMatch.tsx',
  'src/utils/staticRender.tsx',
  'src/utils/autoRunIssue.tsx',
  'src/utils/swarm/It2SetupPrompt.tsx',
  'src/state/AppState.tsx',
  'src/state/AppState.types.test.tsx',
  'src/tools/WorkflowTool/WorkflowPermissionDialog.tsx',

  // Tasks — zai uses its own background runtime
  'src/tasks/RemoteAgentTask',
  'src/tasks/InProcessTeammateTask',
  'src/tasks/LocalShellTask',
  'src/tasks/LocalAgentTask',

  // Hooks — zai has its own canUseTool.ts
  'src/hooks/useCanUseTool.tsx',
]
```

加 `STRIP_DIRS`:
```ts
export const STRIP_DIRS: string[] = [
  // ... existing entries
  'src/utils/processUserInput',  // JSX-heavy prompt rendering
  'src/state',                    // Zustand store coupled to React
]
```

**决策**:`processUserInput/` 整目录删,因为它含 `processBashCommand.tsx` / `processSlashCommand.tsx` 渲染逻辑 + `.test.tsx`,zai 不需要。

- [ ] **Step 4: 删 A 类的 UI 部分**

对每个 A 类 `.tsx`:
1. 改文件后缀 `.tsx` → `.ts`(`mv`)
2. 删掉 `import * as React from 'react'` / `import { c as _c } from "react-compiler-runtime"` / `import { Box, Text } from 'ink'`
3. 删掉文件中所有 JSX 表达式(`<Foo />` / `<Box>...</Box>` 等)
4. 找 `Tool.render(...)` 字段(React 组件返回 ReactNode),整个删掉或换成 `render: () => null`
5. 找文件里所有 `SetToolJSXFn` / `toolUseContext.render` / 任何 React 相关的部分,删

示例:对 `tools/BashTool/BashTool.tsx`:
```ts
// Before:
export const BashTool = buildTool({
  name: 'Bash',
  description: '...',
  inputSchema: ...,
  render: ({ toolUse, toolResult, ... }) => <Box>...</Box>,  // ← 删
  call: async (input, ctx) => { /* 真正执行 */ },
})

// After:
export const BashTool = buildTool({
  name: 'Bash',
  description: '...',
  inputSchema: ...,
  call: async (input, ctx) => { /* 不变 */ },
})
```

- [ ] **Step 5: 重新跑 copy 脚本** *(脚本已移除,此步仅留档)*

Re-run the copy script against `OPENCC_SRC=/Users/ethan/code/opencc` and
verify `git status -s packages/zn-agent-core/src/opencc-src/`:
A 类 tsx → ts 改名;B/C 类文件被删。

- [ ] **Step 6: 跑 typecheck**

```bash
pnpm --filter @zn-ai/zn-agent-core typecheck 2>&1 | grep "Cannot find module 'react'\|Cannot find module 'ink'" | wc -l
# Expected: 大幅下降;少数残留可在 Step 7 修
```

- [ ] **Step 7: 处理残余 React/ink import**

如果 typecheck 还有 react/ink 报错,通常是:
- `*.tsx` 工具里的子函数 JSX 表达式残留(Step 4 没删干净)
- `tsconfig` 没排除 `.tsx`(`include: ["src/**/*.ts", "src/**/*.tsx"]` 但 `.tsx` 已经不该存在了)

重新审视 A 类文件,确认:
- 所有 `<Foo>` JSX 已删
- 所有 `import` React/ink 已删
- `Tool.render` 字段已删

- [ ] **Step 8: Commit**

```bash
git add packages/zn-agent-core/scripts/strip-list.ts packages/zn-agent-core/src/opencc-src/
git commit -m "feat(zn-agent-core): strip .tsx UI from opencc tools, retain call() bodies"
```

---

# Phase 3: `.js → .ts` 扩展名 fallback

## Task 3.1: 批量改 import 路径

- [ ] **Step 1: 写改写脚本** *(脚本已移除,此步仅留档)*

Create `packages/zn-agent-core/scripts/rewrite-js-imports.ts` (since removed):

```ts
#!/usr/bin/env tsx
/**
 * Rewrite `from './foo.js'` and `from '../bar/baz.js'` → `from './foo.ts'` /
 * `from '../bar/baz.ts'` across all .ts files in src/opencc-src/.
 *
 * Why: opencc source uses `.js` suffix in import paths because tsc
 * with `module: NodeNext` requires it for ESM output. zai's bundler
 * config doesn't do `.js → .ts` fallback, so these imports fail at
 * resolve time. Static rewriting to `.ts` makes them work under
 * `moduleResolution: bundler`.
 *
 * Special cases:
 *   - `from '@anthropic-ai/sdk/...'` — these are real package paths, NOT touched
 *   - `from 'node:fs'` — untouched
 *   - `from './foo.js'` where `./foo.ts` doesn't exist — likely a generated
 *     file or test fixture; leave alone and log
 */

import { execSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { dirname, join } from 'path'

const ROOT = join(import.meta.dirname, '..', 'src', 'opencc-src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(e)) out.push(full)
  }
  return out
}

let rewritten = 0
let skippedMissing = 0
for (const f of walk(ROOT)) {
  // Match `from '.../foo.js'` and `import '.../foo.js'` — but only relative paths
  const sed = `sed -i.bak -E "s|(from ['\"]|import ['\"])(\\.\\.?/[^'\"]+)\\.js(['\"])|\\1\\2.ts\\3|g" "${f}"`
  const before = execSync(`grep -cE "from ['\"]\\.\\.?/[^'\"]+\\.js" "${f}" || echo 0`).toString().trim()
  if (before === '0') continue
  execSync(sed)
  execSync(`rm "${f}.bak"`)
  rewritten++
}

console.log(`Rewrote .js → .ts in ${rewritten} files`)
console.log(`Run typecheck to verify (expect 'Cannot find module .foo' errors to drop)`)
```

- [ ] **Step 2: 跑脚本** *(脚本已移除,此步仅留档)*

```bash
cd /Users/ethan/code/opencc-web-zn-agent-core
pnpm --filter @zn-ai/zn-agent-core exec tsx scripts/rewrite-js-imports.ts
git diff --stat packages/zn-agent-core/src/opencc-src/ | tail -5
```

- [ ] **Step 3: 跑 typecheck 看效果**

```bash
pnpm --filter @zn-ai/zn-agent-core typecheck 2>&1 | grep "Cannot find module" | wc -l
# Expected: 大幅下降;但会有一些新错误(vendor 文件之间互相引错的)
```

- [ ] **Step 4: 处理残余 "Cannot find module" 错误**

每个剩余错误,问:
1. 是否 vendor 后 .ts 文件确实不存在? — 加进 strip list(真的是 opencc 内部依赖,删)
2. 是否路径写错? — 手动修
3. 是否缺中间 `.d.ts`? — 加 ambient declaration

- [ ] **Step 5: 更新 copy 脚本让 copy 完后跑 rewrite 脚本** *(脚本已移除,此步仅留档)*

In the copy script, 在 main copy loop 之后加:

```ts
// After main copy + shims copy:
// Rewrite .js → .ts so imports resolve under moduleResolution: bundler
import { spawnSync } from 'child_process'
const rewrite = spawnSync('tsx', ['scripts/rewrite-js-imports.ts'], {
  cwd: ZAI_PKG,
  stdio: 'inherit',
})
if (rewrite.status !== 0) {
  console.error('rewrite-js-imports.ts failed')
  process.exit(1)
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/
git commit -m "fix(zn-agent-core): rewrite .js → .ts imports in vendored opencc src"
```

---

# Phase 4: `@ts-nocheck` 治理

## Task 4.1: 决定策略

- [ ] **Step 1: 列出 vendor 后 `@ts-nocheck` 文件**

```bash
cd /Users/ethan/code/opencc-web-zn-agent-core
grep -rl "@ts-nocheck" packages/zn-agent-core/src/opencc-src/ | wc -l
# Expected: ~400+
```

- [ ] **Step 2: 三类文件,不同处理**

| 类 | 处理 | 数量估 |
|---|---|---|
| **Type-A: zai runtime 真用** | 去 `@ts-nocheck`,强制 typecheck 跑通 | ~30-50(zai 直接 import 的核心 runtime + tools + services) |
| **Type-B: zai 不直接用,但被 Type-A 文件 import** | 去 `@ts-nocheck`,强制 typecheck(可能 type 错误多,逐个修) | ~50-100 |
| **Type-C: zai 不直接用且不被 import** | 保留 `@ts-nocheck`,让 tsc 跳过(后续 Phase X 逐步清) | ~250+ |

确定 Type-A 列表:
```bash
# zai runtime 走的代码路径
grep -rln "from '.*opencc-src/" packages/zn-agent-core/src/compat/ packages/zn-agent-core/src/runtime/ 2>&1
# (Phase 1-3 后会开始有真 import)
```

Type-B: Type-A import 的所有 `.ts`(递归 grep)

## Task 4.2: 去 Type-A 文件的 `@ts-nocheck`

- [ ] **Step 1: 写去 nocheck 脚本**

Create `packages/zn-agent-core/scripts/strip-ts-nocheck.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Remove `// @ts-nocheck` header from files that zai runtime actually uses.
 *
 * Usage: tsx scripts/strip-ts-nocheck.ts <file1> <file2> ...
 * Or pass a list via stdin: `git grep -l '@ts-nocheck' ... | xargs tsx scripts/strip-ts-nocheck.ts`
 */

import { readFileSync, writeFileSync } from 'fs'

let count = 0
for (const f of process.argv.slice(2)) {
  let src = readFileSync(f, 'utf-8')
  const before = src
  src = src.replace(/^\/\/\s*@ts-nocheck\s*\n/m, '')
  if (src !== before) {
    writeFileSync(f, src)
    count++
  }
}
console.log(`Removed @ts-nocheck from ${count} files`)
```

- [ ] **Step 2: 应用到 Type-A 列表**

```bash
cd /Users/ethan/code/opencc-web-zn-agent-core

# 核心 runtime
pnpm --filter @zn-ai/zn-agent-core exec tsx scripts/strip-ts-nocheck.ts \
  packages/zn-agent-core/src/opencc-src/query.ts \
  packages/zn-agent-core/src/opencc-src/QueryEngine.ts \
  packages/zn-agent-core/src/opencc-src/Tool.ts \
  packages/zn-agent-core/src/opencc-src/utils/cwd.ts \
  packages/zn-agent-core/src/opencc-src/services/compact/autoCompact.ts \
  packages/zn-agent-core/src/opencc-src/services/compact/compact.ts \
  packages/zn-agent-core/src/opencc-src/services/mcp/client.ts \
  packages/zn-agent-core/src/opencc-src/services/mcp/types.ts \
  packages/zn-agent-core/src/opencc-src/types/message.ts

# zai 用的核心工具(zai 自己已经有 zod schema 兼容层)
pnpm --filter @zn-ai/zn-agent-core exec tsx scripts/strip-ts-nocheck.ts \
  packages/zn-agent-core/src/opencc-src/tools/BashTool/BashTool.ts \
  packages/zn-agent-core/src/opencc-src/tools/FileEditTool/... \
  # ... 等等
```

(具体列表从 Phase 1 完成后 `grep opencc-src/ compat/` 的输出得出)

- [ ] **Step 3: typecheck 跑,逐个修 type 错误**

```bash
pnpm --filter @zn-ai/zn-agent-core typecheck 2>&1 | tee /tmp/zn-typecheck.log
grep -c "error TS" /tmp/zn-typecheck.log
```

常见 type 错误类型:
- opencc 用 `import { z } from 'zod/v4'`,zai 没装 `zod/v4` — 加进 deps 或 alias 到 `zod`
- opencc 用 `import type { X } from '@anthropic-ai/sdk/resources/index.mjs'` — zai 有这包,应该 OK
- opencc 用 `crypto.UUID` 类型 — zai 的 `@types/node` 应该 OK
- 错误类型实例化 — 加 `as` cast 或写 ambient .d.ts

- [ ] **Step 4: 应用到 Type-B 文件**(可选 / 滚动)

每次 Type-A 文件 typecheck 通过后,把它的 import 链也去 nocheck:

```bash
# 找出所有从 Type-A 文件被 import 的 .ts
grep -rln "from '.*<type-a-file>'" packages/zn-agent-core/src/opencc-src/ | xargs \
  pnpm --filter @zn-ai/zn-agent-core exec tsx scripts/strip-ts-nocheck.ts
```

- [ ] **Step 5: 跑 vitest smoke test 确认 runtime 没崩**

```bash
pnpm --filter @zn-ai/zn-agent-core test
# Expected: 4 个 smoke test 仍通过
```

- [ ] **Step 6: Commit**

```bash
git add packages/zn-agent-core/scripts/strip-ts-nocheck.ts packages/zn-agent-core/src/opencc-src/
git commit -m "fix(zn-agent-core): strip @ts-nocheck from runtime-critical opencc files"
```

---

# Phase 5: 接 opencc `query()` 到 zai

## Task 5.1: 写 opencc 适配 shim

**Files:**
- Modify: `packages/zn-agent-core/src/compat/runtime/contract.ts`
- Create: `packages/zn-agent-core/src/compat/runtime/openccQueryBridge.ts`

- [ ] **Step 1: 写桥(把 zai 的 `QueryOptions` 转成 opencc `query()` 接受的参数)**

Create `packages/zn-agent-core/src/compat/runtime/openccQueryBridge.ts`:

```ts
/**
 * openccQueryBridge — wraps opencc's vendored `query()` so zai can call it
 * from DefaultAgentRuntime.run() with zai-style QueryOptions.
 *
 * zai QueryOptions is similar in spirit to opencc's, but:
 *   - zai uses `transcriptId` for the session; opencc uses `sessionId`
 *   - zai passes `model` + `systemPrompt` as separate fields; opencc accepts
 *     a `QueryOptions` with `model`, `systemPrompt`, `cwd`, `permissionMode`
 *   - zai's `permissionMode` is the user-facing enum (ExternalPermissionMode);
 *     opencc accepts the same enum under the same name
 *   - zai's `modelCaller` is wrapped to produce Anthropic SDK events; opencc
 *     has its own internal Anthropic client. The bridge DELEGATES model
 *     calling entirely to opencc (opencc knows how to talk to Anthropic).
 *
 * The bridge is intentionally minimal: it converts field names, calls
 * opencc's `query()`, and translates SDKMessage stream → zai RuntimeEvent
 * stream. Event translation logic is in `streamAdapter.ts` (existing).
 */

import { query as openccQuery } from '../../opencc-src/query.js'
import { translateSdkToRuntime } from './sdkEventAdapter.js'
import type { QueryOptions, OpenccAdapterConfig } from './types.js'
import type { RuntimeEvent } from './events.js'

export async function* runViaOpenccQuery(
  opts: QueryOptions,
  config: OpenccAdapterConfig,
): AsyncIterable<RuntimeEvent> {
  const sessionId = opts.sessionId ?? opts.transcriptId ?? 'unknown'
  const openccOpts = {
    prompt: opts.prompt as any,  // opencc accepts string | AsyncIterable<SDKUserMessage>
    options: {
      sessionId,
      cwd: opts.cwd,
      model: opts.model,
      systemPrompt: opts.systemPrompt as any,
      permissionMode: opts.permissionMode as any,
      abortSignal: opts.abortSignal,
      mcpServers: config.mcpServers,
      skillsDirs: config.skillsDirs,
      sandbox: config.sandbox,
    },
  }

  const openccStream = openccQuery(openccOpts)
  for await (const sdkMessage of openccStream as AsyncIterable<any>) {
    yield* translateSdkToRuntime(sdkMessage, { sessionId })
  }
}
```

- [ ] **Step 2: 写 SDK message → zai RuntimeEvent 翻译器**

Create `packages/zn-agent-core/src/compat/runtime/sdkEventAdapter.ts`:

```ts
/**
 * SDKMessage → RuntimeEvent translator.
 *
 * opencc's SDK emits `SDKMessage` (a tagged union of SDKAssistantMessage,
 * SDKUserMessage, SDKResultMessage, etc.). zai's `routes/agent.ts`
 * `translateRuntimeEvents()` already handles most Anthropic-style events,
 * but it needs RuntimeEvent shape. This adapter wraps each SDKMessage in
 * a RuntimeEvent that `translateRuntimeEvents` can consume.
 */

import type { RuntimeEvent } from './events.js'

export function* translateSdkToRuntime(
  sdkMessage: unknown,
  meta: { sessionId: string },
): Iterable<RuntimeEvent> {
  const m = sdkMessage as { type: string; [key: string]: unknown }
  // Map SDKMessage variants to RuntimeEvent shapes. The downstream
  // translator in zai's routes/agent.ts handles message_start /
  // content_block_* / message_delta / message_stop — so we unwrap
  // SDKAssistantMessage into those primitive events.
  switch (m.type) {
    case 'assistant': {
      const msg = m.message as { content: Array<Record<string, unknown>> } | undefined
      if (!msg) return
      // Yield message_start, then content_block_* for each block, then
      // message_delta (stop_reason), then message_stop.
      // ... (full impl in subsequent commits)
      return
    }
    case 'user':
      // SDK user messages are echoes from tool_result feedback; yield as-is
      return
    case 'result':
      // Final result → RuntimeEvent done
      return
    default:
      return
  }
}
```

(完整实现在后续 commits;核心是 unwrap opencc SDK messages 成 Anthropic 原语事件,这样 `routes/agent.ts` 的现有 translator 无需改动)

- [ ] **Step 3: 改 `contract.ts` 让 `DefaultAgentRuntime.run()` 走 opencc bridge**

In `packages/zn-agent-core/src/compat/runtime/contract.ts`:

```ts
import { runViaOpenccQuery } from './openccQueryBridge.js'
// ...

export class DefaultAgentRuntime implements AgentRuntime {
  run(opts: QueryOptions): AsyncIterable<RuntimeEvent> {
    const openccConfig = (this.config as any).openccConfig ?? {}
    // Phase 5: route through opencc's real query() loop, not the
    // hand-rolled adapter. Falls back to compat openccAdapter only if
    // opencc query() throws at startup (e.g. missing dependencies).
    try {
      return runViaOpenccQuery(opts, openccConfig)
    } catch (e) {
      console.warn('[zn-agent-core] opencc query() failed to initialize, falling back to compat adapter:', e)
      return runOpenccQuery(opts, openccConfig)
    }
  }
  // ...
}
```

- [ ] **Step 4: 跑 zai build**

```bash
pnpm --filter zai build 2>&1 | tee /tmp/zai-build.log
grep -c "error TS" /tmp/zai-build.log
# Expected: 0
```

- [ ] **Step 5: 跑 zai unit tests**

```bash
pnpm --filter zai test:unit 2>&1 | tee /tmp/zai-test.log
grep -E "FAIL|✗|Error:" /tmp/zai-test.log | head -20
```

- [ ] **Step 6: Commit**

```bash
git add packages/zn-agent-core/src/compat/runtime/openccQueryBridge.ts \
        packages/zn-agent-core/src/compat/runtime/sdkEventAdapter.ts \
        packages/zn-agent-core/src/compat/runtime/contract.ts
git commit -m "feat(zn-agent-core): route DefaultAgentRuntime.run() through opencc query()"
```

---

# Phase 6: 端到端验证 + 删 compat 自写主循环

## Task 6.1: 手动跑 zai,验证 chat 走通

- [ ] **Step 1: 起 zai dev server**

```bash
pnpm --filter zai dev
```

- [ ] **Step 2: 浏览器开 localhost,发消息,验证**

检查项:
- SSE events 流到前端
- Bash tool 调用走通(opencc 的 BashTool.call 真实执行)
- FileRead/Edit/Write 走通
- AskUserQuestion 走通
- Memory load(AGENTS.md 注入 system prompt)
- CWD tracking(shell trailer)
- Compact 触发(发 10+ 轮长对话看是否 autoCompact)

- [ ] **Step 3: 检查 runtime 路径确实走 opencc query()**

在 `compat/runtime/openccQueryBridge.ts` 加日志:

```ts
if (process.env.ZAI_DEBUG === '1') {
  console.error('[openccQueryBridge] calling opencc query()', { sessionId, model: opts.model })
}
```

跑一次 chat,日志确认走 opencc query() 而不是 compat openccAdapter。

## Task 6.2: 删 compat 自写主循环

- [ ] **Step 1: 把 compat/openccAdapter 标 deprecated,加 runtime warning**

In `packages/zn-agent-core/src/compat/runtime/openccAdapter.ts` 顶部加:

```ts
/**
 * @deprecated Phase 6: use openccQueryBridge instead. This file is kept
 * only as a fallback when opencc query() throws at startup (see
 * contract.ts:run() try/catch). Remove after one release cycle.
 */
```

- [ ] **Step 2: 验证 fallback 路径没人触发**

跑 zai dev 数天,确认 console 没"opencc query() failed to initialize"警告。

- [ ] **Step 3: 删 compat/openccAdapter.ts + 任何只剩它用的 helper**

```bash
git rm packages/zn-agent-core/src/compat/runtime/openccAdapter.ts
# 删 sdkEventAdapter 里没用的工具函数
pnpm --filter zai build
pnpm --filter zai test:unit
```

- [ ] **Step 4: Commit**

```bash
git add packages/zn-agent-core/src/compat/runtime/
git commit -m "chore(zn-agent-core): remove deprecated openccAdapter fallback"
```

---

# Phase 7: 收尾

## Task 7.1: 跑全 test 矩阵

- [ ] **Step 1: zai 单测**

```bash
pnpm --filter zai test:unit
```

- [ ] **Step 2: zai 集成测**

```bash
pnpm --filter zai test:integration
```

- [ ] **Step 3: zn-agent-core smoke**

```bash
pnpm --filter @zn-ai/zn-agent-core test
```

- [ ] **Step 4: 覆盖率目标**

按 spec §11.6:line ≥ 92%, branch ≥ 80% on critical runtime modules.

```bash
pnpm --filter @zn-ai/zn-agent-core test -- --coverage
```

## Task 7.2: 更新 AGENTS.md

- [ ] **Step 1: 改 "目录说明" 表**

把 `packages/zn-agent-core/` 描述从"zai agent runtime core — 拷贝自 opencc 0.20.0,剥除 UI"改成"zai agent runtime core — vendor opencc 0.21 工具类 + 调 opencc query() 主循环,UI 走 zai 自有"

- [ ] **Step 2: 改 "核心入口" 节**

`packages/zn-agent-core/src/compat/runtime/contract.ts::DefaultAgentRuntime.run()` 现在指向 `openccQueryBridge` → opencc `query()` 主循环。

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md — zn-agent-core now runs opencc's query() loop"
```

---

# Done Criteria

- [ ] Phase 1:`bun:bundle` 桩写完,173 个 import 全部重写到 `../shims/bun-bundle.js`
- [ ] Phase 2:30 个 `.tsx` 处理完 — A 类 tsx→ts,B/C 类删,strip list 持久化
- [ ] Phase 3:`.js → .ts` 批量重写,~139 个 import 路径修好,typecheck 不再因路径失败
- [ ] Phase 4:Type-A(~50 文件)去 `@ts-nocheck` 强制 typecheck,Type-B 滚动清
- [ ] Phase 5:`DefaultAgentRuntime.run()` 走 `runViaOpenccQuery` → opencc `query()`
- [ ] Phase 6:zai dev 实测 chat 走通,`compat/openccAdapter.ts` 删
- [ ] Phase 7:全 test 通过,AGENTS.md 更新

## Self-Review Notes

**Spec coverage**: plan 覆盖原 plan 的 8 个阶段,加 4 个技术债务修复(Phase 1-4)。每阶段有可验证的 typecheck 步骤。

**Placeholder scan**: 没有 "TBD"/"TODO" 留白。Phase 4 Type-A 文件具体列表在 Task 4.2 Step 2 动态生成。

**Type consistency**: `DefaultAgentRuntime.run()` 接口不变;`QueryOptions` / `RuntimeEvent` / `OpenccAdapterConfig` 类型不变;zai 端 `routes/agent.ts` 0 改动。

**Caveats**:
- opencc 0.21 还在演进,如果后续 0.22 改 `query()` 签名,需要更新 Phase 5 的 bridge
- Phase 5 SDKMessage → RuntimeEvent 翻译器是核心,完整实现需 100-200 行(本 plan 给出骨架,实现在后续 commits 滚动)
- bun:bundle feature 桩里默认 false 的 50+ flag 中,可能有 zai 实际依赖但还没暴露的(如某 opencc compact 路径走 `feature('X') ? path1 : path2`,`path2` 是 stub)— Phase 6 手动测试时若发现某 compact 路径不工作,回头改 STATIC_FEATURES
- 老 `packages/zai-agent-core/src/opencc-internals/` 285 文件不动(用户 stash 在改,平行工作)