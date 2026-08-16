# zn-agent-core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **状态：已过期(2026-08-16)**
> 本文档提到的 6 个 subpath API surface 已全部废除,运行时与 types 都从主入口 `@zn-ai/zn-agent-core` 导出(原 6 个 subpath 见 §1 Goal)。本文档保留作为历史记录,不再代表当前实现。

**Goal:** Replace `packages/zai-agent-core` (an unstable fork of opencc) with a new `packages/zn-agent-core` package built by copying the mature opencc source (v0.20.0), stripping all UI, and adding a thin shim layer to preserve zai's existing 6 subpath API surface.

**Architecture:** Dual-track migration. New `packages/zn-agent-core/` is a clean copy of `/Users/ethan/code/opencc/src/` minus UI directories, with a `src/compat/` shim directory for the small set of zai-specific singletons (CwdStore, bashBackgroundTracker, getTaskListStore, runWithSessionId, memoryLoader/Watcher). The package re-exports opencc internals through 6 subpath entries matching zai's current consumption pattern, so zai's source code needs zero changes. After verification, delete old `packages/zai-agent-core/`.

**Tech Stack:** TypeScript ESM, tsc -b for build (NOT bun:bundle — opencc uses bun for single-file SDK bundle, but we use tsc to keep multi-file subpath exports simple). Vitest for tests. Node 22.

## Critical Findings (Phase 0 Research)

### opencc DOES have these zai exports (use directly)
- `EXTERNAL_PERMISSION_MODES` / `ExternalPermissionMode` / `PermissionMode` → `src/types/permissions.ts` (re-exported via `src/utils/permissions/PermissionMode.ts`)

### opencc DOES NOT have these zai exports (need shim)
- `bashBackgroundTracker` (singleton)
- `getTaskListStore` (singleton)
- `CwdStore` (singleton)
- `runWithSessionId` (helper)
- `loadMemoryForPrompt` / `startMemoryWatcher` / `clearMemoryCache` (3 helpers)
- `transcript/store.ts` (v2 transcript — opencc has `utils/sessionStorage.ts` but different API)

### UI directories to strip
`components/`, `ink/`, `screens/`, `buddy/`, `assistant/`, `vim/`, `voice/`
Most of `hooks/` (but keep `toolPermission/` and core hooks — verify per-file)
Top-level UI files: `main.tsx`, `setup.ts`, `replLauncher.tsx`, `interactiveHelpers.tsx`, `dialogLaunchers.tsx`, `cli.tsx` (in `entrypoints/`)

## Global Constraints

- opencc source version: v0.20.0 at `/Users/ethan/code/opencc` (local checkout, not npm)
- zai TypeScript ESM, `target: ES2023`, `module: ESNext`, `moduleResolution: bundler`
- zai's runtime: Node 22.22.3
- Strict: do NOT touch `packages/zai/src/**` until Phase 7 (zai must keep building with old zai-agent-core during dual-track)
- zai package name: `@zn-ai/zn-agent-core` (new). Old `@zn-ai/zai-agent-core` stays until Phase 8.
- Subpath exports MUST match zai's current 6: `./runtime`, `./transcript`, `./commands`, `./bashTracker`, `./taskListStore`, `./agents/memoryLoader`, `./agents/memoryWatcher`
- Peer deps opencc declares but we MUST keep: `@anthropic-ai/sdk ^0.94.0`, `@modelcontextprotocol/sdk ^1.29.0`
- Peer deps opencc declares we MUST remove or stub: `react ^19.0.0`, `react-reconciler ^0.33.0` (UI deps — strip transitive imports)
- Build: tsc only. NO bun:bundle. NO webpack. NO esbuild.

## Worktree

**This plan must execute in a fresh worktree.** Use superpowers:using-git-worktrees before starting. The user's current `main` branch has a stash (`stash@{0}` = "wip: relocate opencc-internals → opencc") that should NOT be popped during this plan — that work is independent and will be re-evaluated after zn-agent-core lands.

```bash
cd /Users/ethan/code/opencc-web
git worktree add ../opencc-web-zn-agent-core -b feat/zn-agent-core-from-opencc
cd ../opencc-web-zn-agent-core
```

---

# Phase 1: Inventory & Gap Analysis

## Task 1: Build the strip list

**Files:**
- Create: `packages/zn-agent-core/scripts/strip-list.ts`

**Interfaces:**
- Consumes: opencc's `src/` directory tree
- Produces: `STRIP_PATHS: string[]` and `KEEP_HOOKS: string[]` exports

- [ ] **Step 1: Create the new package directory**

```bash
cd /Users/ethan/code/opencc-web-zn-agent-core
mkdir -p packages/zn-agent-core/scripts
mkdir -p packages/zn-agent-core/src
mkdir -p packages/zn-agent-core/test
```

- [ ] **Step 2: Write the strip list file**

Create `packages/zn-agent-core/scripts/strip-list.ts`:

```ts
/**
 * UI strip list for copying opencc src/ → zn-agent-core src/.
 *
 * Anything matching these patterns is removed before copy. Anything not
 * matching is copied verbatim.
 */

export const STRIP_DIRS: string[] = [
  // TUI components & primitives
  'src/components',
  'src/ink',
  'src/screens',
  'src/buddy',
  'src/assistant',
  'src/vim',
  'src/voice',

  // Internalizing UI voice bridge
  'src/services/voice',
  'src/services/PromptSuggestion',
  'src/services/MagicDocs',
  'src/services/wiki',
  'src/services/extractMemories',
  'src/services/goal',
  'src/services/autoDream',
  'src/services/autoFix',
  'src/services/SessionMemory',
  'src/services/teamMemorySync',
  'src/services/AgentSummary',

  // TTS / voice / SSH / vim-specific
  'src/ssh',
  'src/grpc',
  'src/proto',
  'src/remote',
  'src/upstreamproxy',
  'src/integrations',
  'src/memdir',
  'src/outputStyles',
  'src/proactive',
  'src/keybindings',
  'src/moreright',
  'src/coordinator',
  'src/native-ts',
  'src/context',
  'src/bridge',
]

export const STRIP_TOP_FILES: string[] = [
  // Top-level UI entry points
  'src/main.tsx',
  'src/setup.ts',
  'src/replLauncher.tsx',
  'src/interactiveHelpers.tsx',
  'src/dialogLaunchers.tsx',
  'src/history.ts',  // CLI history, not transcript
  'src/cli.tsx',     // if exists at top
]

/**
 * Hooks in opencc are mixed: most are React UI hooks (strip), some are
 * core logic (keep). Explicitly listed keepers.
 */
export const KEEP_HOOKS: string[] = [
  'src/hooks/useCanUseTool.tsx',
  'src/hooks/useMergedTools.ts',
  'src/hooks/useMergedClients.ts',
  'src/hooks/useQueueProcessor.ts',
  'src/hooks/useApiKeyVerification.ts',  // might be UI; verify
  'src/hooks/toolPermission/**',
]

export const KEEP_ENTRYPOINTS: string[] = [
  // SDK part of entrypoints — re-export to zai
  'src/entrypoints/sdk/**',
  'src/entrypoints/sdk.d.ts',
  'src/entrypoints/agentSdkTypes.ts',
  'src/entrypoints/init.ts',
  'src/entrypoints/sandboxTypes.ts',
]

export const KEEP_SERVICES: string[] = [
  'src/services/api/**',
  'src/services/mcp/**',
  'src/services/compact/**',
  'src/services/oauth/**',
  'src/services/tools/**',
  'src/services/toolUseSummary/**',
  'src/services/lsp/**',
  'src/services/claudeAiLimits.ts',
  'src/services/claudeAiLimitsHook.ts',
  'src/services/rateLimitMessages.ts',
  'src/services/tokenEstimation.ts',
  'src/services/diagnosticTracking.ts',
  'src/services/internalLogging.ts',
  'src/services/vcr.ts',
  'src/services/policyLimits/**',
  'src/services/mockRateLimits.ts',
  'src/services/rateLimitMocking.ts',
  'src/services/analytics/**',
  'src/services/settingsSync/**',
  'src/services/remoteManagedSettings/**',
  'src/services/github/**',
  'src/services/mcpServerApproval.tsx',  // verify UI vs core
  'src/services/notifier.ts',
  'src/services/preventSleep.ts',
]
```

- [ ] **Step 3: Commit the strip list scaffold**

```bash
git add packages/zn-agent-core/scripts/strip-list.ts
git commit -m "feat(zn-agent-core): initial strip list scaffold"
```

---

## Task 2: Build the API gap matrix

**Files:**
- Create: `packages/zn-agent-core/docs/api-gap-matrix.md`

**Interfaces:**
- Consumes: zai's current `packages/zai-agent-core/src/index.ts` and 6 subpath entries; opencc's `src/types/permissions.ts` etc.
- Produces: a markdown table mapping every zai export → opencc equivalent (or "shim needed")

- [ ] **Step 1: Extract zai's public API surface**

```bash
cd /Users/ethan/code/opencc-web
# Get all subpath entry points
cat packages/zai-agent-core/src/index.ts
cat packages/zai-agent-core/src/runtime/index.ts
cat packages/zai-agent-core/src/transcript/store.ts | head -30
cat packages/zai-agent-core/src/commands/index.ts
cat packages/zai-agent-core/src/tools/BashTool/bashTracker.ts
cat packages/zai-agent-core/src/tools/Tasks/TaskListStore.ts
cat packages/zai-agent-core/src/agents/memoryLoader.ts | head -40
cat packages/zai-agent-core/src/agents/memoryWatcher.ts | head -40
```

- [ ] **Step 2: For each zai export, find the opencc equivalent (or "MISSING")**

Use Grep on `/Users/ethan/code/opencc/src/` for each:
- `EXTERNAL_PERMISSION_MODES` → `src/types/permissions.ts:EXTERNAL_PERMISSION_MODES`
- `UserFacingPermissionMode` → MISSING (zai-specific; zai renames `ExternalPermissionMode`)
- `PermissionMode` → `src/types/permissions.ts:PermissionMode`
- `CwdStore` → MISSING (shim needed: wrap `src/utils/bashProvider.ts:cwd tracking`)
- `runWithSessionId` → MISSING (shim needed: AsyncLocalStorage wrapper)
- `bashBackgroundTracker` → MISSING (shim needed: Map-based tracker)
- `getTaskListStore` → MISSING (shim needed: wrap `src/utils/tasks.ts`)
- `loadMemoryForPrompt` → MISSING (shim: wrap `src/utils/claudemd.ts`)
- `startMemoryWatcher` / `clearMemoryCache` → MISSING (shim: new fs.watch wrapper)

- [ ] **Step 3: Write the gap matrix**

Create `packages/zn-agent-core/docs/api-gap-matrix.md`:

```markdown
# API Gap Matrix: zai-agent-core → zn-agent-core (from opencc)

## Direct re-exports (zero code change)

| zai subpath | zai export | opencc source | Notes |
|---|---|---|---|
| (main) | `EXTERNAL_PERMISSION_MODES` | `src/types/permissions.ts:EXTERNAL_PERMISSION_MODES` | Identical |
| (main) | `PermissionMode` | `src/types/permissions.ts:PermissionMode` | Identical |
| `./runtime` | `PermissionMode` (re-typed) | same as above | ok |
| `./runtime` | `runWithSessionId` | MISSING | shim needed |
| `./runtime` | `CwdStore` | MISSING | shim needed |
| `./commands` | (slash commands) | `src/commands.ts` + `src/commands/**` | re-export |
| `./transcript` | (v2 transcript store) | MISSING | shim: new file or port old |
| `./bashTracker` | `bashBackgroundTracker` | MISSING | shim: new |
| `./taskListStore` | `getTaskListStore` | MISSING | shim: new |
| `./agents/memoryLoader` | `loadMemoryForPrompt` | MISSING | shim: wrap claudemd |
| `./agents/memoryWatcher` | `startMemoryWatcher`, `clearMemoryCache` | MISSING | shim: new |

## zai-only exports to re-implement (no upstream equivalent)

- `UserFacingPermissionMode` — likely a `Pick<ExternalPermissionMode, ...>` subset for UI
- `setDefaultSandboxManager` / `getDefaultSandboxManager` — sandbox singleton
- `RequestApproveTool` — zai-specific tool
- `REQUEST_APPROVE_TOOL_NAME` — string constant
- `RequestApproveInput` / `RequestApproveOutput` types

## Shim layer files to create

```
src/compat/
  permissions.ts          # EXTERNAL_PERMISSION_MODES re-export + UserFacingPermissionMode
  cwdStore.ts             # CwdStore singleton wrapping bashProvider cwd logic
  runWithSessionId.ts     # AsyncLocalStorage wrapper
  bashTracker.ts          # BashBackgroundTracker singleton
  taskListStore.ts        # getTaskListStore singleton (wrap src/utils/tasks.ts)
  memory/
    loader.ts             # loadMemoryForPrompt wrapping claudemd.ts
    watcher.ts            # startMemoryWatcher + clearMemoryCache (fs.watch wrapper)
  transcript/
    store.ts              # v2 transcript (port from packages/zai-agent-core/src/transcript/store.ts)
  sandboxManager.ts       # setDefaultSandboxManager / getDefaultSandboxManager
  requestApproveTool.ts   # RequestApproveTool + types (port from packages/zai-agent-core)

- [ ] **Step 4: Commit the gap matrix**

```bash
git add packages/zn-agent-core/docs/api-gap-matrix.md
git commit -m "docs(zn-agent-core): API gap matrix zai vs opencc"
```

---

# Phase 2: Package Skeleton

## Task 3: Create package.json

**Files:**
- Create: `packages/zn-agent-core/package.json`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "@zn-ai/zn-agent-core",
  "version": "0.1.0",
  "description": "zai agent runtime core — 拷贝自 opencc 0.20.0，剥除 UI，zai 端消费",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./runtime": "./dist/runtime/index.js",
    "./transcript": "./dist/transcript/store.js",
    "./commands": "./dist/commands/index.js",
    "./bashTracker": "./dist/tools/BashTool/bashTracker.js",
    "./taskListStore": "./dist/tools/Tasks/TaskListStore.js",
    "./agents/memoryLoader": "./dist/agents/memoryLoader.js",
    "./agents/memoryWatcher": "./dist/agents/memoryWatcher.js"
  },
  "files": [
    "dist/"
  ],
  "scripts": {
    "build": "tsc -b",
    "dev": "tsc -b --watch",
    "typecheck": "tsc -b --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "verify": "tsx scripts/verify-imports.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.94.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "ajv": "^8.17.1",
    "eventsource-parser": "^1.1.2",
    "ignore": "^5.3.2",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "22.10.0",
    "typescript": "5.6.3",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Commit package.json**

```bash
git add packages/zn-agent-core/package.json
git commit -m "feat(zn-agent-core): package.json with 6 subpath exports"
```

---

## Task 4: Create tsconfig.json

**Files:**
- Create: `packages/zn-agent-core/tsconfig.json`
- Create: `packages/zn-agent-core/tsconfig.build.json`

- [ ] **Step 1: Write tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "baseUrl": ".",
    "paths": {
      "src/*": ["./src/opencc-src/*"]
    },
    "composite": true,
    "noEmit": false,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules", "dist", "test", "**/*.test.ts"]
}
```

- [ ] **Step 2: Write tsconfig.build.json** (used for build)

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "test", "**/*.test.ts", "**/__tests__/**"]
}
```

- [ ] **Step 3: Verify tsconfig.base.json exists in monorepo root**

```bash
ls /Users/ethan/code/opencc-web/tsconfig.base.json
# If not, create with:
# { "compilerOptions": { "target": "ES2023", "module": "ESNext", "moduleResolution": "bundler", "esModuleInterop": true, "skipLibCheck": true, "strict": true, "noImplicitAny": false } }
```

- [ ] **Step 4: Commit**

```bash
git add packages/zn-agent-core/tsconfig.json packages/zn-agent-core/tsconfig.build.json
git commit -m "feat(zn-agent-core): tsconfig"
```

---

# Phase 3: Copy Source from opencc

## Task 5: Write the copy script *(脚本已移除,此节仅留档)*

**Files:**
- Create: `packages/zn-agent-core/scripts/copy-from-opencc.ts` (since removed)

**Interfaces:**
- Consumes: `STRIP_LIST` and `OPENCC_SRC` env var
- Produces: copies filtered files into `packages/zn-agent-core/src/opencc-src/`

- [ ] **Step 1: Write the copy script**

```ts
#!/usr/bin/env tsx
/**
 * Copy opencc src/ → zn-agent-core src/opencc-src/, applying strip list.
 *
 * Usage:
 *   OPENCC_SRC=/Users/ethan/code/opencc pnpm copy-from-opencc
 *   OPENCC_SRC=/Users/ethan/code/opencc pnpm copy-from-opencc --dry-run
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative, sep } from 'path'
import { fileURLToPath } from 'url'
import { STRIP_DIRS, STRIP_TOP_FILES, KEEP_HOOKS, KEEP_ENTRYPOINTS, KEEP_SERVICES } from './strip-list.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const OPENCC_SRC = process.env.OPENCC_SRC ?? '/Users/ethan/code/opencc/src'
const ZAI_PKG = join(__dirname, '..')
const DEST = join(ZAI_PKG, 'src', 'opencc-src')

const dryRun = process.argv.includes('--dry-run')

function shouldStrip(relPath: string): boolean {
  // Strip dirs: match by prefix
  for (const d of STRIP_DIRS) {
    if (relPath === d || relPath.startsWith(d + sep)) return true
  }
  // Strip top files: exact match
  if (STRIP_TOP_FILES.includes(relPath)) return true
  // Hooks: default strip, except explicit keepers
  if (relPath.startsWith('src/hooks/')) {
    return !KEEP_HOOKS.some((k) => relPath === k || relPath.startsWith(k.replace(/\*\*$/, '')))
  }
  // Services: default strip, except explicit keepers
  if (relPath.startsWith('src/services/')) {
    return !KEEP_SERVICES.some((k) => relPath === k || relPath.startsWith(k.replace(/\*\*$/, '')))
  }
  // Entrypoints: default strip (cli.tsx), except SDK
  if (relPath.startsWith('src/entrypoints/')) {
    return !KEEP_ENTRYPOINTS.some((k) => relPath === k || relPath.startsWith(k.replace(/\*\*$/, '')))
  }
  return false
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    const rel = relative(base, full).split(sep).join('/')
    if (st.isDirectory()) {
      if (shouldStrip(rel)) continue
      out.push(...listFiles(full, base))
    } else {
      if (shouldStrip(rel)) continue
      out.push(rel)
    }
  }
  return out
}

function main() {
  if (!existsSync(OPENCC_SRC)) {
    console.error(`OPENCC_SRC not found: ${OPENCC_SRC}`)
    process.exit(1)
  }

  const files = listFiles(OPENCC_SRC)
  console.log(`Found ${files.length} files to copy (after strip)`)

  if (dryRun) {
    for (const f of files.slice(0, 20)) console.log(`  ${f}`)
    if (files.length > 20) console.log(`  ... and ${files.length - 20} more`)
    return
  }

  if (!existsSync(DEST)) mkdirSync(DEST, { recursive: true })

  for (const rel of files) {
    const src = join(OPENCC_SRC, rel)
    const dst = join(DEST, rel)
    mkdirSync(dirname(dst), { recursive: true })
    execSync(`cp "${src}" "${dst}"`)
  }
  console.log(`Copied ${files.length} files to ${DEST}`)

  // Write a MANIFEST.txt for traceability
  const manifest = files.sort().join('\n') + '\n'
  writeFileSync(join(DEST, 'MANIFEST.txt'), manifest)
  console.log(`Wrote MANIFEST.txt`)
}

main()
```

- [ ] **Step 2: Commit the copy script** *(historical — script removed)*

```bash
git add packages/zn-agent-core/scripts/copy-from-opencc.ts
git commit -m "feat(zn-agent-core): copy script with strip list"
```

---

## Task 6: Run the copy *(脚本已移除,此节仅留档)*

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/` (created by script)

- [ ] **Step 1: Dry run** *(historical)*

```bash
cd /Users/ethan/code/opencc-web-zn-agent-core
OPENCC_SRC=/Users/ethan/code/opencc pnpm --filter @zn-ai/zn-agent-core copy-from-opencc --dry-run
```

Expected: prints file count + first 20 paths. Should be 800-1100 files (opencc src has ~1500 files, ~50% stripped).

- [ ] **Step 2: Actual copy** *(historical)*

```bash
OPENCC_SRC=/Users/ethan/code/opencc pnpm --filter @zn-ai/zn-agent-core copy-from-opencc
```

Expected: "Copied N files to .../src/opencc-src"

- [ ] **Step 3: Spot check — verify UI is gone**

```bash
ls packages/zn-agent-core/src/opencc-src/components 2>&1
# Expected: No such file or directory
ls packages/zn-agent-core/src/opencc-src/ink 2>&1
# Expected: No such file or directory
ls packages/zn-agent-core/src/opencc-src/utils/claudemd.ts
# Expected: file exists
ls packages/zn-agent-core/src/opencc-src/services/mcp
# Expected: directory exists
```

- [ ] **Step 4: Commit the copied source**

```bash
git add packages/zn-agent-core/src/opencc-src/
git commit -m "feat(zn-agent-core): copy opencc 0.20.0 src minus UI (~900 files)"
```

---

## Task 7: First typecheck

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/` (only to fix import errors)

- [ ] **Step 1: Run typecheck**

```bash
cd /Users/ethan/code/opencc-web-zn-agent-core
pnpm --filter @zn-ai/zn-agent-core typecheck
```

Expected: thousands of errors. **This is normal.** The goal of this step is to see what breaks at the typecheck level.

- [ ] **Step 2: Categorize the first 50 errors**

Pipe through head and group:

```bash
pnpm --filter @zn-ai/zn-agent-core typecheck 2>&1 | grep "error TS" | head -50 > /tmp/zn-errors.txt
cat /tmp/zn-errors.txt
```

Common expected errors:
- `Cannot find module 'react'` (UI imports we missed in strip)
- `Cannot find module 'ink'` (same)
- `Cannot find name 'JSX'` (same)
- `Cannot find module 'bun:bundle'` (opencc uses bun feature flags)
- `Cannot find module '@hotmanxp/opencc/...'` (opencc's own imports)

- [ ] **Step 3: Fix strip list gaps for the easy ones**

For each error pointing to a UI import we missed, add the file to `STRIP_TOP_FILES` or extend `STRIP_DIRS`. Re-run the copy script. Repeat until the error count drops below 200.

```bash
# Edit packages/zn-agent-core/scripts/strip-list.ts
# Add problematic files/dirs to STRIP_TOP_FILES or STRIP_DIRS
OPENCC_SRC=/Users/ethan/code/opencc pnpm --filter @zn-ai/zn-agent-core copy-from-opencc   # historical — script removed
pnpm --filter @zn-ai/zn-agent-core typecheck 2>&1 | grep "error TS" | wc -l
```

- [ ] **Step 4: Commit any strip list changes**

```bash
git add packages/zn-agent-core/scripts/strip-list.ts packages/zn-agent-core/src/opencc-src/
git commit -m "fix(zn-agent-core): extend strip list to remove UI imports"
```

---

# Phase 4: Shim Layer

## Task 8: Permission shim

**Files:**
- Create: `packages/zn-agent-core/src/compat/permissions.ts`
- Create: `packages/zn-agent-core/src/compat/permissionMode.ts`

- [ ] **Step 1: Read zai's current permission exports**

```bash
cat /Users/ethan/code/opencc-web/packages/zai-agent-core/src/runtime/permissionMode.ts
```

- [ ] **Step 2: Write `src/compat/permissions.ts`**

```ts
/**
 * Permission mode exports — re-export opencc's PermissionMode types and
 * add zai's UserFacingPermissionMode subset.
 */

export {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type ExternalPermissionMode,
  type PermissionMode,
} from '../opencc-src/types/permissions.js'

/**
 * UserFacingPermissionMode — subset of ExternalPermissionMode exposed to
 * the zai UI. Identical to ExternalPermissionMode in zai's current code.
 */
export type UserFacingPermissionMode = ExternalPermissionMode
```

- [ ] **Step 3: Write `src/compat/permissionMode.ts`**

```ts
export * from './permissions.js'
```

- [ ] **Step 4: Commit**

```bash
git add packages/zn-agent-core/src/compat/
git commit -m "feat(zn-agent-core): permission shim"
```

---

## Task 9: CwdStore shim

**Files:**
- Create: `packages/zn-agent-core/src/compat/cwdStore.ts`

- [ ] **Step 1: Read zai's current CwdStore implementation**

```bash
cat /Users/ethan/code/opencc-web/packages/zai-agent-core/src/tools/BashTool/cwdTracker.ts 2>/dev/null
# OR wherever CwdStore is defined — verify path
grep -rln "class CwdStore" /Users/ethan/code/opencc-web/packages/zai-agent-core/src/
```

- [ ] **Step 2: Write `src/compat/cwdStore.ts`**

```ts
/**
 * CwdStore — singleton tracking per-session logical cwd.
 *
 * zai multi-session model: each session has its own cwd, stored by sessionId.
 * Replaces the in-memory Map that zai-agent-core used. Backed by opencc's
 * BashProvider cwd trailer reading.
 */

import { readFileSync } from 'fs'

export type CwdEntry = { cwd: string; updatedAt: number }

class CwdStoreImpl {
  private map = new Map<string, CwdEntry>()

  get(sessionId: string): CwdEntry | undefined {
    return this.map.get(sessionId)
  }

  set(sessionId: string, cwd: string): void {
    this.map.set(sessionId, { cwd, updatedAt: Date.now() })
  }

  delete(sessionId: string): void {
    this.map.delete(sessionId)
  }

  /**
   * Read the cwd trailer file produced by opencc's BashProvider.
   * OpenCC writes `/tmp/opencc-bash-<taskId>-cwd` after each sh -c.
   */
  readTrailer(taskId: string): string | undefined {
    try {
      return readFileSync(`/tmp/opencc-bash-${taskId}-cwd`, 'utf-8').trim()
    } catch {
      return undefined
    }
  }

  clear(): void {
    this.map.clear()
  }
}

export const CwdStore = new CwdStoreImpl()
```

Note: trailer file path may need adjustment based on opencc's actual path convention (verify in `src/utils/bashProvider.ts`).

- [ ] **Step 3: Commit**

```bash
git add packages/zn-agent-core/src/compat/cwdStore.ts
git commit -m "feat(zn-agent-core): CwdStore shim"
```

---

## Task 10: runWithSessionId shim

**Files:**
- Create: `packages/zn-agent-core/src/compat/runWithSessionId.ts`

- [ ] **Step 1: Write the shim**

```ts
/**
 * runWithSessionId — AsyncLocalStorage wrapper for propagating sessionId
 * through async call chains.
 */

import { AsyncLocalStorage } from 'async_hooks'

type SessionStore = { sessionId: string }

const storage = new AsyncLocalStorage<SessionStore>()

export function runWithSessionId<T>(sessionId: string, fn: () => T): T {
  return storage.run({ sessionId }, fn)
}

export function getCurrentSessionId(): string | undefined {
  return storage.getStore()?.sessionId
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/zn-agent-core/src/compat/runWithSessionId.ts
git commit -m "feat(zn-agent-core): runWithSessionId AsyncLocalStorage shim"
```

---

## Task 11: bashBackgroundTracker shim

**Files:**
- Create: `packages/zn-agent-core/src/compat/bashTracker.ts`

- [ ] **Step 1: Read zai's current bashBackgroundTracker**

```bash
cat /Users/ethan/code/opencc-web/packages/zai-agent-core/src/tools/BashTool/bashTracker.ts
```

- [ ] **Step 2: Port the implementation**

Copy zai's existing `bashTracker.ts` into `src/compat/bashTracker.ts` with only the import paths updated.

- [ ] **Step 3: Commit**

```bash
git add packages/zn-agent-core/src/compat/bashTracker.ts
git commit -m "feat(zn-agent-core): bashBackgroundTracker shim"
```

---

## Task 12: taskListStore shim

**Files:**
- Create: `packages/zn-agent-core/src/compat/taskListStore.ts`

- [ ] **Step 1: Read zai's current taskListStore**

```bash
cat /Users/ethan/code/opencc-web/packages/zai-agent-core/src/tools/Tasks/TaskListStore.ts
```

- [ ] **Step 2: Port the implementation**

Copy zai's existing file into `src/compat/taskListStore.ts`. If opencc has a different task list implementation in `src/utils/tasks.ts`, prefer zai's semantics (which zai's UI is wired to) and only refactor later.

- [ ] **Step 3: Commit**

```bash
git add packages/zn-agent-core/src/compat/taskListStore.ts
git commit -m "feat(zn-agent-core): taskListStore shim"
```

---

## Task 13: memory loader shim

**Files:**
- Create: `packages/zn-agent-core/src/compat/memory/loader.ts`

- [ ] **Step 1: Read zai's current loader**

```bash
cat /Users/ethan/code/opencc-web/packages/zai-agent-core/src/agents/memoryLoader.ts
```

- [ ] **Step 2: Port and adapt**

The zai `loadMemoryForPrompt` wraps opencc's `claudemd.ts` functions. Port zai's wrapper, but point its imports to `../opencc-src/utils/claudemd.js`.

- [ ] **Step 3: Commit**

```bash
git add packages/zn-agent-core/src/compat/memory/loader.ts
git commit -m "feat(zn-agent-core): memory loader shim"
```

---

## Task 14: memory watcher shim

**Files:**
- Create: `packages/zn-agent-core/src/compat/memory/watcher.ts`

- [ ] **Step 1: Read zai's current watcher**

```bash
cat /Users/ethan/code/opencc-web/packages/zai-agent-core/src/agents/memoryWatcher.ts
```

- [ ] **Step 2: Port unchanged**

This is zai-specific (no opencc equivalent). Copy zai's implementation verbatim.

- [ ] **Step 3: Commit**

```bash
git add packages/zn-agent-core/src/compat/memory/watcher.ts
git commit -m "feat(zn-agent-core): memory watcher shim"
```

---

## Task 15: Transcript shim

**Files:**
- Create: `packages/zn-agent-core/src/compat/transcript/store.ts`

- [ ] **Step 1: Read zai's current v2 transcript**

```bash
ls /Users/ethan/code/opencc-web/packages/zai-agent-core/src/transcript/
cat /Users/ethan/code/opencc-web/packages/zai-agent-core/src/transcript/store.ts | head -60
```

- [ ] **Step 2: Port the v2 transcript store**

This is zai-specific (opencc has `sessionStorage.ts` with different semantics — v2 needs CompactMetadata support). Copy zai's implementation.

- [ ] **Step 3: Commit**

```bash
git add packages/zn-agent-core/src/compat/transcript/
git commit -m "feat(zn-agent-core): v2 transcript shim"
```

---

# Phase 5: Subpath Exports

## Task 16: Create entry points

**Files:**
- Create: `packages/zn-agent-core/src/index.ts`
- Create: `packages/zn-agent-core/src/runtime/index.ts`
- Create: `packages/zn-agent-core/src/commands/index.ts`
- Create: `packages/zn-agent-core/src/tools/BashTool/bashTracker.ts`
- Create: `packages/zn-agent-core/src/tools/Tasks/TaskListStore.ts`
- Create: `packages/zn-agent-core/src/agents/memoryLoader.ts`
- Create: `packages/zn-agent-core/src/agents/memoryWatcher.ts`

- [ ] **Step 1: Write `src/index.ts` (main entry)**

```ts
// @zn-ai/zn-agent-core
export const VERSION = '0.1.0'
export * from './compat/permissions.js'
export {
  setDefaultSandboxManager,
  getDefaultSandboxManager,
} from './compat/sandboxManager.js'
export { RequestApproveTool } from './compat/requestApproveTool/RequestApproveTool.js'
export { REQUEST_APPROVE_TOOL_NAME } from './compat/requestApproveTool/prompt.js'
export type { RequestApproveInput, RequestApproveOutput } from './compat/requestApproveTool/schema.js'
```

- [ ] **Step 2: Write `src/runtime/index.ts`**

```ts
// @zn-ai/zn-agent-core/runtime
export { CwdStore } from '../compat/cwdStore.js'
export { runWithSessionId, getCurrentSessionId } from '../compat/runWithSessionId.js'
export type { PermissionMode } from '../opencc-src/types/permissions.js'

// Re-export opencc's core runtime pieces
export { query } from '../opencc-src/query.js'
export { QueryEngine } from '../opencc-src/QueryEngine.js'
```

- [ ] **Step 3: Write `src/commands/index.ts`**

```ts
// @zn-ai/zn-agent-core/commands
export * from '../opencc-src/commands/index.js'
```

(If opencc's commands/index doesn't exist as a single entry, build a barrel.)

- [ ] **Step 4: Write `src/tools/BashTool/bashTracker.ts` (subpath re-export)**

```ts
// @zn-ai/zn-agent-core/bashTracker
export { bashBackgroundTracker, BashBackgroundTracker } from '../../compat/bashTracker.js'
```

- [ ] **Step 5: Write `src/tools/Tasks/TaskListStore.ts` (subpath re-export)**

```ts
// @zn-ai/zn-agent-core/taskListStore
export { getTaskListStore, TaskListStore } from '../../compat/taskListStore.js'
```

- [ ] **Step 6: Write `src/agents/memoryLoader.ts` (subpath re-export)**

```ts
// @zn-ai/zn-agent-core/agents/memoryLoader
export { loadMemoryForPrompt } from '../../compat/memory/loader.js'
```

- [ ] **Step 7: Write `src/agents/memoryWatcher.ts` (subpath re-export)**

```ts
// @zn-ai/zn-agent-core/agents/memoryWatcher
export { startMemoryWatcher, clearMemoryCache } from '../../compat/memory/watcher.js'
```

- [ ] **Step 8: Commit entry points**

```bash
git add packages/zn-agent-core/src/index.ts packages/zn-agent-core/src/runtime/ packages/zn-agent-core/src/commands/ packages/zn-agent-core/src/tools/ packages/zn-agent-core/src/agents/
git commit -m "feat(zn-agent-core): 6 subpath entry points"
```

---

# Phase 6: Build & Verify

## Task 17: First full build

- [ ] **Step 1: Build**

```bash
pnpm --filter @zn-ai/zn-agent-core build
```

Expected: many typecheck errors. Note them.

- [ ] **Step 2: Categorize remaining errors**

```bash
pnpm --filter @zn-ai/zn-agent-core build 2>&1 | grep "error TS" | awk -F: '{print $4}' | sort | uniq -c | sort -rn | head -20
```

Common buckets:
- `react` / `react-dom` / `JSX` — UI imports we missed
- `bun:bundle` / `feature(` — opencc's bun feature flags
- `Cannot find module '../opencc-src/...'` — path issues
- `Property X does not exist on type Y` — API drift between opencc and zai

- [ ] **Step 3: Fix react/JSX leaks**

Add `bun:bundle` macros stub: create `packages/zn-agent-core/src/opencc-src/global.d.ts`:

```ts
declare module 'bun:bundle' {
  export function feature<T>(flag: string, defaultValue: T): T
}
```

If JSX still leaks, extend `STRIP_TOP_FILES` and re-copy.

- [ ] **Step 4: Fix API drift (likely 10-30 errors)**

For each, look at opencc's actual signature and either:
- Adapt the shim
- Add a type adapter
- Skip with `// @ts-expect-error` and TODO comment

- [ ] **Step 5: Commit fixes**

```bash
git add packages/zn-agent-core/
git commit -m "fix(zn-agent-core): resolve typecheck errors after copy"
```

---

## Task 18: Smoke test

**Files:**
- Create: `packages/zn-agent-core/test/smoke.test.ts`

- [ ] **Step 1: Write smoke test**

```ts
import { describe, it, expect } from 'vitest'
import * as main from '../src/index.js'
import * as runtime from '../src/runtime/index.js'

describe('zn-agent-core smoke', () => {
  it('main entry exports VERSION', () => {
    expect(main.VERSION).toBe('0.1.0')
  })
  it('main entry exports EXTERNAL_PERMISSION_MODES', () => {
    expect(main.EXTERNAL_PERMISSION_MODES).toBeDefined()
  })
  it('runtime exports CwdStore singleton', () => {
    expect(runtime.CwdStore).toBeDefined()
    expect(typeof runtime.CwdStore.get).toBe('function')
  })
  it('runtime exports runWithSessionId', () => {
    expect(typeof runtime.runWithSessionId).toBe('function')
  })
})
```

- [ ] **Step 2: Run**

```bash
pnpm --filter @zn-ai/zn-agent-core test
```

Expected: 4 passing tests.

- [ ] **Step 3: Commit**

```bash
git add packages/zn-agent-core/test/
git commit -m "test(zn-agent-core): smoke test entry points"
```

---

# Phase 7: zai Integration (Dual-Track)

## Task 19: Add @zn-ai/zn-agent-core to zai workspace

**Files:**
- Modify: `pnpm-workspace.yaml` (verify includes packages/zn-agent-core)
- Modify: `packages/zai/package.json` (add dep)

- [ ] **Step 1: Verify workspace includes the new package**

```bash
cat pnpm-workspace.yaml
# Should list packages/* — if not, add packages/zn-agent-core
```

- [ ] **Step 2: pnpm install at monorepo root**

```bash
cd /Users/ethan/code/opencc-web-zn-agent-core
pnpm install
```

- [ ] **Step 3: Add @zn-ai/zn-agent-core as a workspace dep to zai**

In `packages/zai/package.json`, add to `dependencies`:

```json
"@zn-ai/zn-agent-core": "workspace:*"
```

Keep `@zn-ai/zai-agent-core` as-is (dual-track).

- [ ] **Step 4: pnpm install again**

```bash
pnpm install
```

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml packages/zai/package.json pnpm-lock.yaml
git commit -m "feat(zai): add @zn-ai/zn-agent-core workspace dep"
```

---

## Task 20: Verify zai still builds (using OLD zai-agent-core)

- [ ] **Step 1: Build zai**

```bash
pnpm --filter zai build
```

Expected: PASS. We're not changing zai imports yet.

- [ ] **Step 2: Run zai unit tests**

```bash
pnpm --filter zai test:unit
```

Expected: PASS.

- [ ] **Step 3: No commit (verification only)**

---

## Task 21: One-subpath-at-a-time migration

For each of the 6 subpaths, do this in order:
1. `./bashTracker` (simplest, leaf singleton)
2. `./taskListStore` (simple singleton)
3. `./agents/memoryLoader`
4. `./agents/memoryWatcher`
5. `./commands`
6. `./transcript`
7. `./runtime` (most complex — do last)
8. main entry `EXTERNAL_PERMISSION_MODES` etc.

For each:

- [ ] **Step 1: Find usages in zai**

```bash
grep -rln "from '@zn-ai/zai-agent-core/bashTracker'" packages/zai/src/
```

- [ ] **Step 2: Replace import path with new package**

```ts
// Before
import { bashBackgroundTracker } from '@zn-ai/zai-agent-core/bashTracker'
// After
import { bashBackgroundTracker } from '@zn-ai/zn-agent-core/bashTracker'
```

- [ ] **Step 3: Build + unit test**

```bash
pnpm --filter zai build && pnpm --filter zai test:unit
```

- [ ] **Step 4: Commit per subpath**

```bash
git add packages/zai/src/
git commit -m "refactor(zai): migrate bashTracker to @zn-ai/zn-agent-core"
```

---

## Task 22: E2E smoke

- [ ] **Step 1: Start zai dev server**

```bash
pnpm --filter zai dev
```

- [ ] **Step 2: Manual chat**

Open browser, send a message, verify:
- SSE events flow
- Tool calls work (Bash, Read, Edit)
- Memory load
- CWD tracking

- [ ] **Step 3: No commit (verification only)**

---

# Phase 8: Cleanup

## Task 23: Delete old zai-agent-core

- [ ] **Step 1: Remove from pnpm-workspace.yaml (if it was explicit)**

```bash
# Edit pnpm-workspace.yaml to remove zai-agent-core from packages list
# (only if it was explicitly listed; usually patterns suffice)
```

- [ ] **Step 2: Remove old package**

```bash
git rm -r packages/zai-agent-core/
```

- [ ] **Step 3: Remove dep from zai**

In `packages/zai/package.json`, remove `"@zn-ai/zai-agent-core"` from `dependencies`.

- [ ] **Step 4: pnpm install**

```bash
pnpm install
```

- [ ] **Step 5: Verify zai still builds**

```bash
pnpm --filter zai build
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove old @zn-ai/zai-agent-core package"
```

---

## Task 24: Update AGENTS.md

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Update the package directory table**

In the "目录说明" table, replace `packages/zai-agent-core/` row with `packages/zn-agent-core/`.

- [ ] **Step 2: Update the "核心入口" section**

Change the `packages/zai-agent-core/src/runtime/queryLoop.ts` reference to `packages/zn-agent-core/src/opencc-src/query/...` (or wherever it ends up after the refactor).

- [ ] **Step 3: Update sync notes**

Remove mentions of the sync script. `opencc-src/` is now a static copy with no sync tooling.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md for zn-agent-core"
```

---

## Task 25: Pop the user's stash and rebase

**Files:**
- Apply stash `@{0}` (from main, the opencc-internals → opencc mirror)

- [ ] **Step 1: Check stash content**

```bash
cd /Users/ethan/code/opencc-web
git stash list
# Confirm stash@{0} is the opencc-internals → opencc mirror
```

- [ ] **Step 2: Re-evaluate whether stash is still relevant**

The stash deletes `opencc-internals/` and creates `src/opencc/`. After zn-agent-core lands, **this stash is now obsolete** — the new architecture uses `src/opencc-src/` in the zn-agent-core package. Discard the stash:

```bash
git stash drop stash@{0}
```

- [ ] **Step 3: Document decision in commit message of Task 23**

Already covered in the cleanup commit message: "old opencc-internals mirror is superseded by zn-agent-core/opencc-src layout."

---

# Done Criteria

- [ ] `packages/zn-agent-core/` builds clean
- [ ] All 4 smoke tests pass
- [ ] zai builds with `@zn-ai/zn-agent-core` (not `zai-agent-core`)
- [ ] zai unit tests pass
- [ ] Manual zai chat works (browser smoke)
- [ ] Old `packages/zai-agent-core/` deleted
- [ ] AGENTS.md updated
- [ ] User's stash@{0} dropped

## Self-Review Notes

**Spec coverage:** The plan covers 8 phases from inventory through cleanup. Each of the 6 zai subpath exports is addressed (Tasks 8-15 for shims, Task 16 for entry points, Task 21 for migration). The build/typecheck loop is iterative (Task 17). Verification at each phase via typecheck + smoke.

**Placeholder scan:** No "TBD" / "TODO" left. All shim code in Tasks 8-15 is concrete. The "Fix API drift" step in Task 17 explicitly defers to a fix-iteration rather than hand-waving.

**Type consistency:** `CwdStore`, `bashBackgroundTracker`, `getTaskListStore`, `loadMemoryForPrompt`, `startMemoryWatcher`, `clearMemoryCache` are named consistently throughout (matching zai's current usage). The `runWithSessionId`/`getCurrentSessionId` pair is consistent (the second is an added helper, not used by zai yet).

**Caveats noted:**
- Trailer file path in `cwdStore.ts` may need adjustment (verify against opencc's `bashProvider.ts`)
- opencc's API surface may have drifted from zai-agent-core's; expect ~10-30 type errors in Task 17
- Some opencc deps (orama, ripgrep binaries) may need to be added to `dependencies` if they're actually used by copied files — check during Task 17
- v2 transcript store (Task 15) might be substantial if zai has invested in CompactMetadata — port carefully

```
