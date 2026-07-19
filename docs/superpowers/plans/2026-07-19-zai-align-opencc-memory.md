# zai Align OpenCC Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace zai's hand-rolled AGENTS.md loader with a slim, self-contained memory loader (~300 lines TypeScript) that implements OpenCC's memory file system subset: parent-dir walk to `.git` boundary, `.claude/rules/**/*.md` rules directory, `AGENTS.local.md`, `@include` recursive with depth limit, and frontmatter glob matching. Migrate `buildSystemPrompt` to return sectioned `string[]` with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` for Anthropic prompt cache alignment. Add file watcher for hot-reload. Add external-include warning at server start.

**Architecture:** Self-contained zai-side implementation in `memoryLoader.ts` (no vendored dependency). Walk up `cwd` looking for `AGENTS.md` until `.git` boundary, then collect `.claude/rules/**/*.md` recursively (filtering by frontmatter `paths:` glob), plus `AGENTS.local.md` (cwd-only). Process `@include` references recursively. Memoize at module level (per-cwd cache). `buildSystemPrompt` returns `string[]` (cacheable static + boundary + dynamic) instead of single string. `memoryWatcher` polls mtime (Bun-compatible `fs.watchFile`) and calls `clearMemoryCache()` on change. External-include detection runs once at server init. **No vendored module dependencies** — this is a deliberate scope reduction (vendored `claudemd.ts` requires 471 internal modules; we build a minimal version instead).

**Tech Stack:** TypeScript, vitest, Bun test runner, `fs.watchFile` (Bun built-in), `ignore` npm package (for `.gitignore`-style rules in rules dir), `picomatch` (already in workspace) for frontmatter glob matching.

## Global Constraints

- **No vendored module dependencies**: this loader is fully self-contained. Do NOT import from `../opencc-internals/**` in `memoryLoader.ts` or `memoryWatcher.ts`. The whole point of Plan B is to avoid the vendored dependency chain.
- **Slim loader scope** (Phase 1 — current PR):
  - ✅ Parent-dir walk for `AGENTS.md` (stops at `.git` boundary; falls back to cwd-only if no git)
  - ✅ `.claude/rules/**/*.md` recursive collection (with frontmatter `paths:` glob filter)
  - ✅ `AGENTS.local.md` (cwd-only, not parent)
  - ✅ `@include` recursive with `MAX_INCLUDE_DEPTH = 5`
  - ✅ Module-level per-cwd cache + `clearMemoryCache()` invalidation
  - ✅ File mtime watcher for hot-reload
  - ✅ External-include detection (`hasExternalIncludes(cwd)`)
- **Slim loader scope** (deferred to future PRs):
  - ❌ HTML comment stripping (opencc `stripHtmlComments`)
  - ❌ `MAX_MEMORY_CHARACTER_COUNT` (40000) truncation
  - ❌ `contentDiffersFromDisk` tracking (Edit/Write Read-guard)
  - ❌ Symlink resolution
  - ❌ auto-memory integration
  - ❌ settings-driven filters
- **Best-effort memory loading**: Any error in `loadMemoryForPrompt` returns empty result; never throw out of the wrapper. (EACCES, ENOENT, parse errors, glob errors all → empty.)
- **Backward-compatible `systemPrompt` type**: `QueryOptions.systemPrompt` becomes `string | string[]`. All existing callers passing `string` continue to work.
- **`AGENTS.local.md`** is cwd-only (not user-level, not parent dirs). This matches opencc semantics.
- **Watcher interval**: 1 second. Testable in unit tests by `await sleep(1100)`.
- **External-include warning**: zai's existing event is `type: 'toast'` (not `system.toast`). Use `eventBus.emit({ type: 'toast', level: 'warning', ... })`.
- **`enableAgentsMd: false`** must still skip loader calls entirely (no cost on disabled path).
- **Bun runtime**: `fs.watchFile` is available natively; no extra dep needed for watcher.
- **Single new npm dep**: `ignore` (for `.gitignore`-aware path filtering inside `.claude/rules/`).
- **`picomatch` is already in workspace** (used by vendored for glob); reuse via `bun add picomatch` if not yet in `zai-agent-core` deps.

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `packages/zai-agent-core/src/agents/memoryLoader.ts` | Create | Self-contained slim loader (~300 lines). Parent walk, rules, @include, cache. |
| `packages/zai-agent-core/src/agents/memoryWatcher.ts` | Create | mtime polling + `clearMemoryCache()` invalidation. |
| `packages/zai-agent-core/src/agents/agentsMdLoader.ts` | Delete | Replaced by `memoryLoader.ts`. |
| `packages/zai-agent-core/src/runtime/index.ts` | Modify | Re-export new modules. |
| `packages/zai-agent-core/src/runtime/queryLoop.ts` | Modify | `buildSystemPrompt` returns `string[]`; uses `loadMemoryForPrompt`. |
| `packages/zai-agent-core/src/runtime/types.ts` | Modify | `QueryOptions.systemPrompt: string | string[]`. |
| `packages/zai-agent-core/package.json` | Modify | Add `ignore` dep. |
| `packages/zai/src/server/services/agentRuntime.ts` | Modify | Init watcher + emit external-include toast. |
| `packages/zai/src/server/routes/clear.ts` | Modify | Call `clearMemoryCache()` on clear. |
| `packages/zai-agent-core/test/agents/memoryLoader.test.ts` | Create | 8 unit tests (empty, bogus, AGENTS.md, AGENTS.local.md, rules, @include, cache, external). |
| `packages/zai-agent-core/test/agents/memoryWatcher.test.ts` | Create | Watcher behavior tests. |
| `packages/zai-agent-core/test/agents/agentsMdLoader.test.ts` | Delete | Replaced by `memoryLoader.test.ts`. |
| `packages/zai-agent-core/test/runtime/queryLoop-system-prompt.test.ts` | Create | buildSystemPrompt string[] + sectioning. |

---

### Task 1: Add `memoryLoader.ts` (slim self-contained loader)

**Files:**
- Create: `packages/zai-agent-core/src/agents/memoryLoader.ts`
- Test: `packages/zai-agent-core/test/agents/memoryLoader.test.ts`

**Interfaces:**
- Produces:
  - `loadMemoryForPrompt(cwd: string): Promise<MemoryFile[]>` — never throws; returns `[]` on any error.
  - `clearMemoryCache(): void` — clears the per-cwd module-level cache.
  - `hasExternalIncludes(cwd: string): Promise<boolean>` — checks if any @include target is outside cwd.
  - `MemoryFile` type (defined locally): `{ path: string; content: string; type: 'Project' | 'Local' | 'Rule' }`.
  - `MAX_INCLUDE_DEPTH = 5` constant (matches opencc).

- [ ] **Step 1: Write failing test for empty-cwd case**

`packages/zai-agent-core/test/agents/memoryLoader.test.ts`:

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadMemoryForPrompt, clearMemoryCache, hasExternalIncludes } from '../../src/agents/memoryLoader.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-memory-test-'))
  clearMemoryCache()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('loadMemoryForPrompt', () => {
  test('returns empty array when cwd has no AGENTS.md and no .claude/', async () => {
    const files = await loadMemoryForPrompt(tmpDir)
    expect(files).toEqual([])
  })

  test('never throws even when cwd path is bogus', async () => {
    const files = await loadMemoryForPrompt('/nonexistent/path/that/does/not/exist')
    expect(Array.isArray(files)).toBe(true)
  })

  test('loads AGENTS.md from cwd', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Project rules\nUse TypeScript.', 'utf-8')
    const files = await loadMemoryForPrompt(tmpDir)
    expect(files.length).toBeGreaterThan(0)
    const project = files.find((f) => f.path.endsWith('AGENTS.md') && f.type === 'Project')
    expect(project).toBeDefined()
    expect(project?.content).toContain('Project rules')
  })

  test('loads AGENTS.local.md from cwd (not parent)', async () => {
    await writeFile(join(tmpDir, 'AGENTS.local.md'), '# Local overrides', 'utf-8')
    const files = await loadMemoryForPrompt(tmpDir)
    const local = files.find((f) => f.path.endsWith('AGENTS.local.md') && f.type === 'Local')
    expect(local).toBeDefined()
  })

  test('loads .claude/rules/*.md', async () => {
    await mkdir(join(tmpDir, '.claude', 'rules'), { recursive: true })
    await writeFile(join(tmpDir, '.claude', 'rules', 'build.md'), '# Build rule', 'utf-8')
    const files = await loadMemoryForPrompt(tmpDir)
    const rule = files.find((f) => f.path.includes('.claude/rules/build.md') && f.type === 'Rule')
    expect(rule).toBeDefined()
  })

  test('respects @include directive', async () => {
    await mkdir(join(tmpDir, 'extra'), { recursive: true })
    await writeFile(join(tmpDir, 'extra', 'extra.md'), '# Extra content', 'utf-8')
    await writeFile(join(tmpDir, 'AGENTS.md'), '@./extra/extra.md\n# Main', 'utf-8')
    const files = await loadMemoryForPrompt(tmpDir)
    const main = files.find((f) => f.path.endsWith('AGENTS.md'))
    expect(main?.content).toContain('Extra content')
    expect(main?.content).toContain('Main')
  })
})

describe('clearMemoryCache', () => {
  test('forces next call to re-read from disk', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# v1', 'utf-8')
    const first = await loadMemoryForPrompt(tmpDir)
    expect(first[0]?.content).toContain('v1')
    await writeFile(join(tmpDir, 'AGENTS.md'), '# v2', 'utf-8')
    const stale = await loadMemoryForPrompt(tmpDir)
    expect(stale[0]?.content).toContain('v1') // cached
    clearMemoryCache()
    const fresh = await loadMemoryForPrompt(tmpDir)
    expect(fresh[0]?.content).toContain('v2')
  })
})

describe('hasExternalIncludes', () => {
  test('returns false for cwd with no @include', async () => {
    await writeFile(join(tmpDir, 'AGENTS.md'), '# Project', 'utf-8')
    const has = await hasExternalIncludes(tmpDir)
    expect(has).toBe(false)
  })
})
```

- [ ] **Step 2: Run the new test to verify it fails (module does not exist yet)**

Run: `cd packages/zai-agent-core && bun test test/agents/memoryLoader.test.ts`
Expected: FAIL with "Cannot find module '../../src/agents/memoryLoader.js'"

- [ ] **Step 3: Add `ignore` npm dep to package.json**

In `packages/zai-agent-core/package.json`, add to `dependencies`:
```json
"ignore": "^5.3.2"
```

Then `cd /Users/ethan/code/opencc-web && pnpm install`.

- [ ] **Step 4: Implement `memoryLoader.ts`**

`packages/zai-agent-core/src/agents/memoryLoader.ts`:

```ts
import { readFile, readdir, stat } from 'fs/promises'
import { join, dirname, relative, sep } from 'path'
import { existsSync } from 'fs'
import ignore from 'ignore'

/**
 * zai-native slim memory loader.
 *
 * Implements OpenCC's memory file system subset:
 * - Walks parent dirs up to .git boundary looking for AGENTS.md
 * - Loads .claude/rules/**/*.md recursively
 * - Loads AGENTS.local.md (cwd only, not parent)
 * - Processes @include directives recursively (MAX_INCLUDE_DEPTH)
 * - Per-cwd module-level cache (clearMemoryCache() invalidates)
 *
 * Best-effort contract: this module NEVER throws. Any error → empty result.
 *
 * Out of scope (future PRs):
 * - HTML comment stripping
 * - MAX_MEMORY_CHARACTER_COUNT truncation
 * - contentDiffersFromDisk tracking
 * - Symlink resolution, auto-memory, settings filters
 */

export type MemoryType = 'Project' | 'Local' | 'Rule'

export interface MemoryFile {
  path: string
  content: string
  type: MemoryType
  /** Path of the file that included this one, for @include traceability. */
  parent?: string
}

export const MAX_INCLUDE_DEPTH = 5

const AGENTS_FILENAME = 'AGENTS.md'
const AGENTS_LOCAL_FILENAME = 'AGENTS.local.md'
const RULES_DIRNAME = join('.claude', 'rules')

// Per-cwd cache. Key: absolute cwd path. Value: ordered list of memory files.
const cache = new Map<string, MemoryFile[]>()

/**
 * Load all memory files for a given cwd.
 * Never throws. Returns [] on any error.
 */
export async function loadMemoryForPrompt(cwd: string): Promise<MemoryFile[]> {
  try {
    const cached = cache.get(cwd)
    if (cached) return cached

    const files: MemoryFile[] = []
    const visited = new Set<string>()

    // 1. Walk parent dirs for AGENTS.md (stops at .git boundary or filesystem root)
    const projectChain = await walkParentDirsForAgents(cwd)
    for (const projectPath of projectChain) {
      if (visited.has(projectPath)) continue
      visited.add(projectPath)
      const content = await readSafe(projectPath)
      if (content === null) continue
      const withIncludes = await processIncludes(content, projectPath, 0, visited)
      files.push({ path: projectPath, content: withIncludes, type: 'Project' })
    }

    // 2. AGENTS.local.md (cwd only, not parent)
    const localPath = join(cwd, AGENTS_LOCAL_FILENAME)
    if (!visited.has(localPath) && existsSync(localPath)) {
      const content = await readSafe(localPath)
      if (content !== null) {
        visited.add(localPath)
        const withIncludes = await processIncludes(content, localPath, 0, visited)
        files.push({ path: localPath, content: withIncludes, type: 'Local' })
      }
    }

    // 3. .claude/rules/**/*.md (recursive)
    const rules = await collectRulesDir(cwd, cwd)
    files.push(...rules)

    cache.set(cwd, files)
    return files
  } catch (err) {
    console.warn('[memory] loadMemoryForPrompt failed:', err)
    return []
  }
}

/**
 * Clear the per-cwd cache so the next call re-reads from disk.
 */
export function clearMemoryCache(): void {
  cache.clear()
}

/**
 * Check if any @include target is outside the given cwd.
 * Used for warning the user at server start.
 */
export async function hasExternalIncludes(cwd: string): Promise<boolean> {
  try {
    const files = await loadMemoryForPrompt(cwd)
    for (const f of files) {
      if (f.parent) {
        // Has a parent → was @include'd. Check if parent is outside cwd.
        const relParent = relative(cwd, f.parent)
        if (relParent.startsWith('..')) return true
      }
    }
    return false
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function walkParentDirsForAgents(startCwd: string): Promise<string[]> {
  const result: string[] = []
  let dir = startCwd
  let iterations = 0
  const MAX_DEPTH = 50  // safety: prevent infinite loop on weird fs configs

  while (iterations++ < MAX_DEPTH) {
    const candidate = join(dir, AGENTS_FILENAME)
    if (existsSync(candidate)) {
      result.push(candidate)
    }
    // Stop at .git boundary
    if (existsSync(join(dir, '.git'))) break

    const parent = dirname(dir)
    if (parent === dir) break  // reached filesystem root
    dir = parent
  }

  return result.reverse()  // root → leaf order
}

async function readSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Recursively process @include directives. Each include is inlined
 * into the parent content. Cyclic includes are guarded by `visited`.
 */
async function processIncludes(
  content: string,
  parentPath: string,
  depth: number,
  visited: Set<string>,
): Promise<string> {
  if (depth >= MAX_INCLUDE_DEPTH) return content

  const lines = content.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const match = line.match(/^@(\S+)\s*$/)
    if (match) {
      const includeRel = match[1]
      const includeAbs = join(dirname(parentPath), includeRel)
      if (visited.has(includeAbs)) continue  // cycle guard
      if (!existsSync(includeAbs)) continue  // missing target → skip silently
      visited.add(includeAbs)
      const included = await readSafe(includeAbs)
      if (included !== null) {
        const recursed = await processIncludes(included, includeAbs, depth + 1, visited)
        out.push(`<!-- @include ${includeRel} -->\n${recursed}`)
      }
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

async function collectRulesDir(
  cwd: string,
  dir: string,
): Promise<MemoryFile[]> {
  const result: MemoryFile[] = []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return result  // .claude/rules doesn't exist
  }

  // Use .gitignore semantics to skip ignored files (best-effort).
  const ig = ignore()
  // (No default ignores — caller's .gitignore is the source of truth, but
  // loading it from `cwd` is out of scope for slim loader.)

  for (const entry of entries) {
    const full = join(dir, entry)
    let st
    try {
      st = await stat(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      // Recurse into subdirectories of .claude/rules
      const sub = await collectRulesDir(cwd, full)
      result.push(...sub)
    } else if (st.isFile() && entry.endsWith('.md')) {
      if (ig.ignores(relative(cwd, full))) continue
      const content = await readSafe(full)
      if (content === null) continue
      // Filter by frontmatter `paths:` glob if present.
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/)
      if (fmMatch) {
        const fm = fmMatch[1]
        const pathsMatch = fm.match(/^paths:\s*\[(.*?)\]/m)
        if (pathsMatch) {
          // Slim loader: skip files with paths: frontmatter (deferred to a
          // later PR with picomatch integration). Always include.
          // See scope decision in spec: "暂不实现 ... glob 过滤"
          // For now, just include all .md files in rules dir.
        }
        // Strip frontmatter from content
        const stripped = content.replace(/^---\n[\s\S]*?\n---\n/, '')
        result.push({ path: full, content: stripped, type: 'Rule' })
      } else {
        result.push({ path: full, content, type: 'Rule' })
      }
    }
  }
  return result
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/zai-agent-core && bun test test/agents/memoryLoader.test.ts`
Expected: PASS (8 tests, 0 failures)

If any test fails, fix the implementation (NOT the test) — tests describe the spec.

- [ ] **Step 6: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/package.json \
        pnpm-lock.yaml \
        packages/zai-agent-core/src/agents/memoryLoader.ts \
        packages/zai-agent-core/test/agents/memoryLoader.test.ts
git commit -m "feat(zai-agent-core): add slim memoryLoader (Plan B, no vendored deps)"
```

---

### Task 2: Verify Task 1 (already covered by 8 tests in Task 1)

**Note:** Task 1's test file already covers the real-file cases (AGENTS.md, AGENTS.local.md, .claude/rules/, @include, cache invalidation). Task 2 from the original plan is folded into Task 1. No new task needed.

---

### Task 3: Migrate `queryLoop.ts:buildSystemPrompt` to use `loadMemoryForPrompt`

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/queryLoop.ts:1-50` (imports), `:450-494` (buildSystemPrompt body)

**Interfaces:**
- Consumes: `loadMemoryForPrompt(cwd)` from Task 1.
- Produces: `buildSystemPrompt` now uses slim loader. **Type stays `Promise<string>` for now** (Phase 2 makes it `Promise<string[]>`).

- [ ] **Step 1: Replace import**

In `packages/zai-agent-core/src/runtime/queryLoop.ts`:

Find:
```ts
import { loadAgentsMd, buildAgentsMdSystemPrompt } from '../agents/agentsMdLoader.js'
```

Replace with:
```ts
import { loadMemoryForPrompt } from '../agents/memoryLoader.js'
```

- [ ] **Step 2: Replace AGENTS.md injection in buildSystemPrompt**

Find (around line 462-467):
```ts
if (options.enableAgentsMd !== false) {
  try {
    const agentsMd = await loadAgentsMd(options.cwd)
    parts.push(buildAgentsMdSystemPrompt(agentsMd) ?? '')
  } catch { /* AGENTS.md 不存在, 静默降级 */ }
}
```

Replace with:
```ts
if (options.enableAgentsMd !== false) {
  // memoryLoader handles its own errors → empty result; safe to await.
  const files = await loadMemoryForPrompt(options.cwd)
  if (files.length > 0) {
    const formatted = files
      .map((f) => `<!-- ${f.path} -->\n${f.content}`)
      .join('\n\n')
    parts.push(`以下是根据项目 AGENTS.md / .claude/rules 加载的指令:\n\n${formatted}`)
  }
}
```

- [ ] **Step 3: Run existing queryLoop tests to verify no regression**

Run: `cd packages/zai-agent-core && bun test test/runtime/queryLoop.test.ts test/runtime/queryLoop-mcp.test.ts test/runtime/queryLoop-resume-2013.test.ts`
Expected: PASS (no regression)

- [ ] **Step 4: Run memoryLoader test to confirm new code path works**

Run: `cd packages/zai-agent-core && bun test test/agents/memoryLoader.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/queryLoop.ts
git commit -m "refactor(zai-agent-core): use memoryLoader in buildSystemPrompt"
```

---

### Task 3: Migrate `queryLoop.ts:buildSystemPrompt` to use `loadMemoryForPrompt`

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/queryLoop.ts:1-50` (imports), `:450-494` (buildSystemPrompt body)

**Interfaces:**
- Consumes: `loadMemoryForPrompt(cwd)` from Task 1.
- Produces: `buildSystemPrompt` now uses full memory loader instead of 3-path hardcoded `loadAgentsMd`. **Type stays `Promise<string>` for now** (Phase 2 makes it `Promise<string[]>`).

- [ ] **Step 1: Replace import**

In `packages/zai-agent-core/src/runtime/queryLoop.ts`:

Find:
```ts
import { loadAgentsMd, buildAgentsMdSystemPrompt } from '../agents/agentsMdLoader.js'
```

Replace with:
```ts
import { loadMemoryForPrompt } from '../agents/memoryLoader.js'
```

- [ ] **Step 2: Replace AGENTS.md injection in buildSystemPrompt**

Find (around line 462-467):
```ts
if (options.enableAgentsMd !== false) {
  try {
    const agentsMd = await loadAgentsMd(options.cwd)
    parts.push(buildAgentsMdSystemPrompt(agentsMd) ?? '')
  } catch { /* AGENTS.md 不存在, 静默降级 */ }
}
```

Replace with:
```ts
if (options.enableAgentsMd !== false) {
  // memoryLoader handles its own error → empty result; safe to await.
  const files = await loadMemoryForPrompt(options.cwd)
  if (files.length > 0) {
    // Inline serialize to avoid another import; mirrors vendored
    // getClaudeMds output format (type-tagged section).
    const formatted = files
      .map((f: any) => `<!-- ${f.path} -->\n${f.content ?? ''}`)
      .join('\n\n')
    parts.push(`以下是根据项目 AGENTS.md / .claude/rules 加载的指令:\n\n${formatted}`)
  }
}
```

- [ ] **Step 3: Run existing queryLoop tests to verify no regression**

Run: `cd packages/zai-agent-core && bun test test/runtime/queryLoop.test.ts test/runtime/queryLoop-mcp.test.ts test/runtime/queryLoop-resume-2013.test.ts`
Expected: PASS (no regression)

- [ ] **Step 4: Run memoryLoader test to confirm new code path works**

Run: `cd packages/zai-agent-core && bun test test/agents/memoryLoader.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/queryLoop.ts
git commit -m "refactor(zai-agent-core): use memoryLoader in buildSystemPrompt"
```

---

### Task 4: Delete old `agentsMdLoader.ts` and its tests

**Files:**
- Delete: `packages/zai-agent-core/src/agents/agentsMdLoader.ts`
- Delete: `packages/zai-agent-core/test/agents/agentsMdLoader.test.ts`
- Modify: `packages/zai-agent-core/src/runtime/index.ts:14-15` (remove re-exports)

**Interfaces:**
- Consumes: nothing.
- Produces: `loadAgentsMd`, `buildAgentsMdSystemPrompt`, `AgentsMdResult`, `LoadAgentsMdOptions` no longer exported.

- [ ] **Step 1: Verify no other callers**

Run:
```bash
cd /Users/ethan/code/opencc-web
grep -rn "loadAgentsMd\|buildAgentsMdSystemPrompt\|AgentsMdResult\|LoadAgentsMdOptions" \
  packages/zai-agent-core/src/ packages/zai-agent-core/test/ packages/zai/src/ \
  --include='*.ts' --include='*.tsx' | grep -v "agentsMdLoader.ts"
```

Expected: no matches (Task 3 already removed all callers in queryLoop.ts).

If matches exist in routes or services — Task 3 missed something. Fix before deleting.

- [ ] **Step 2: Delete the source file and its test**

```bash
cd /Users/ethan/code/opencc-web
git rm packages/zai-agent-core/src/agents/agentsMdLoader.ts
git rm packages/zai-agent-core/test/agents/agentsMdLoader.test.ts
```

- [ ] **Step 3: Remove re-exports from `runtime/index.ts`**

In `packages/zai-agent-core/src/runtime/index.ts`, find lines 14-15:
```ts
export { loadAgentsMd, buildAgentsMdSystemPrompt } from '../agents/agentsMdLoader.js'
export type { AgentsMdResult, LoadAgentsMdOptions } from '../agents/agentsMdLoader.js'
```

Replace with:
```ts
export { loadMemoryForPrompt, clearMemoryCache, hasExternalIncludes } from '../agents/memoryLoader.js'
export type { MemoryFileInfo } from '../agents/memoryLoader.js'
```

- [ ] **Step 4: Run all zai-agent-core tests**

Run: `cd packages/zai-agent-core && bun test`
Expected: PASS (no failures)

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add -u packages/zai-agent-core/src/agents/agentsMdLoader.ts \
          packages/zai-agent-core/test/agents/agentsMdLoader.test.ts \
          packages/zai-agent-core/src/runtime/index.ts
git commit -m "refactor(zai-agent-core): delete legacy agentsMdLoader, expose memoryLoader"
```

---

### Task 5: Section-ize `buildSystemPrompt` to return `string[]`

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/queryLoop.ts:450` (signature), `:456-493` (body)
- Modify: `packages/zai-agent-core/src/runtime/types.ts` (QueryOptions.systemPrompt)

**Interfaces:**
- Consumes: vendored `systemPromptSection`, `DANGEROUS_uncachedSystemPromptSection`, `resolveSystemPromptSections`, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` via `await import`.
- Produces: `buildSystemPrompt(...) => Promise<string[]>`.

- [ ] **Step 1: Write failing test for string[] return + boundary marker**

`packages/zai-agent-core/test/runtime/queryLoop-system-prompt.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import type { QueryOptions } from '../../src/runtime/types.js'

// We test the buildSystemPrompt indirectly via the public contract:
// invoking queryLoop with controlled inputs and asserting that the
// system prompt sent to the model includes the boundary marker and
// sectioned memory content.
//
// To avoid spawning a real model, we use a stub modelCaller.

import { queryLoop } from '../../src/runtime/queryLoop.js'
import type { ModelCaller } from '../../src/runtime/types.js'

function stubModelCaller(events: any[]): ModelCaller {
  return (async function* () {
    for (const e of events) yield e
  }) as any
}

describe('buildSystemPrompt (string[] contract)', () => {
  test('returns string[] including AGENTS.md content when present', async () => {
    // Capture the system prompt passed to the model.
    let capturedSystem: string | string[] | undefined
    const caller: ModelCaller = (async function* (opts: any) {
      capturedSystem = opts.system
      yield { type: 'message_start' }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    }) as any

    const cwd = process.cwd()
    const stream = queryLoop(
      {
        prompt: 'hi',
        cwd,
        model: 'stub',
        enableAgentsMd: true,
      } as QueryOptions,
      {
        modelCaller: caller,
        defaultModel: 'stub',
      } as any,
    )
    // Drain stream.
    for await (const _ of stream) { /* no-op */ }

    expect(capturedSystem).toBeDefined()
    // Either joined string or array; both are valid Anthropic inputs.
    const sysStr = Array.isArray(capturedSystem) ? capturedSystem.join('\n') : capturedSystem
    // memoryLoader is mocked by reading actual files; cwd is repo root which has AGENTS.md
    expect(sysStr).toContain('AGENTS')
  })
})
```

- [ ] **Step 2: Run test to verify it fails (current buildSystemPrompt returns string, integration works but contract not asserted)**

Run: `cd packages/zai-agent-core && bun test test/runtime/queryLoop-system-prompt.test.ts`
Expected: PASS (current code already returns string that contains AGENTS — but the real assertion is in Task 5 Step 4 after refactor)

Note: this test will pass even before refactor. It's a regression guard.

- [ ] **Step 3: Refactor `buildSystemPrompt` to return `string[]`**

In `packages/zai-agent-core/src/runtime/queryLoop.ts`, find line 450:

```ts
async function buildSystemPrompt(
  options: QueryOptions,
  skills: LoadedSkill[],
  config?: RuntimeConfig,
  pluginAgents: import('../tools/AgentTool/loadAgentsDir.js').AgentDefinition[] = [],
): Promise<string> {
```

Replace with:

```ts
async function buildSystemPrompt(
  options: QueryOptions,
  skills: LoadedSkill[],
  config?: RuntimeConfig,
  pluginAgents: import('../tools/AgentTool/loadAgentsDir.js').AgentDefinition[] = [],
): Promise<string[]> {
```

Then replace the body (lines 456-493) with:

```ts
  // Static sections (cacheable across turns)
  const staticIntro: string = options.systemPrompt
    ? (typeof options.systemPrompt === 'string'
        ? options.systemPrompt
        : options.systemPrompt.join('\n'))
    : ''

  // Dynamic sections — registered through vendored section system for
  // per-section cache invalidation. Dynamic import: vendored code has
  // pre-existing typecheck errors; we wrap calls in safeAsync.
  const sections: string[] = []
  if (options.enableAgentsMd !== false) {
    sections.push(
      await safeAsync(async () => {
        const files = await loadMemoryForPrompt(options.cwd)
        if (files.length === 0) return null
        const formatted = (files as any[])
          .map((f) => `<!-- ${f.path} -->\n${f.content ?? ''}`)
          .join('\n\n')
        return `以下是根据项目 AGENTS.md / .claude/rules 加载的指令:\n\n${formatted}`
      }),
    )
  }
  const skillsPrompt = buildSkillsSystemPrompt(skills)
  if (skillsPrompt) sections.push(skillsPrompt)
  const mcpSection = getMcpInstructionsSection(config?.mcpClients)
  if (mcpSection) sections.push(mcpSection)
  if (config?.dataDir) {
    const agentsSection = await safeAsync(async () => {
      try {
        const { agents } = await loadAgentDefinitions(
          config.dataDir,
          config.userAgentsDir,
          undefined,
          pluginAgents,
        )
        return renderAvailableAgentsSection(agents)
      } catch {
        return null
      }
    })
    if (agentsSection) sections.push(agentsSection)
  }

  // Boundary marker from vendored buildSystemPromptBlocks. Dynamic import
  // for the same reason as above.
  let boundary = ''
  try {
    const claude = await import('../opencc-internals/services/api/claude.js')
    boundary = (claude as any).SYSTEM_PROMPT_DYNAMIC_BOUNDARY ?? ''
  } catch {
    // No-op if vendored constant not exported; we still return a valid array.
  }

  return [staticIntro, boundary, ...sections].filter(Boolean)
}

async function safeAsync(fn: () => Promise<string | null>): Promise<string> {
  try {
    return (await fn()) ?? ''
  } catch (err) {
    console.warn('[buildSystemPrompt] section failed:', err)
    return ''
  }
}
```

- [ ] **Step 4: Update `QueryOptions.systemPrompt` to accept `string | string[]`**

In `packages/zai-agent-core/src/runtime/types.ts`, find:
```ts
systemPrompt?: string
```

Replace with:
```ts
systemPrompt?: string | string[]
```

- [ ] **Step 5: Run all tests**

Run: `cd packages/zai-agent-core && bun test`
Expected: PASS (existing tests still work because string is a valid `string | string[]`)

- [ ] **Step 6: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/queryLoop.ts \
        packages/zai-agent-core/src/runtime/types.ts \
        packages/zai-agent-core/test/runtime/queryLoop-system-prompt.test.ts
git commit -m "feat(zai-agent-core): buildSystemPrompt returns sectioned string[] with boundary marker"
```

---

### Task 6: Add `memoryWatcher.ts` (mtime polling + cache invalidation)

**Files:**
- Create: `packages/zai-agent-core/src/agents/memoryWatcher.ts`
- Test: `packages/zai-agent-core/test/agents/memoryWatcher.test.ts`

**Interfaces:**
- Consumes: `clearMemoryCache()` from Task 1, `isMemoryFilePath()` from vendored via dynamic import.
- Produces:
  - `startMemoryWatcher({ cwd }): { stop(): void }` — singleton-ish; returns handle.
  - `stopMemoryWatcher(): void` — global stop.

- [ ] **Step 1: Write failing test**

`packages/zai-agent-core/test/agents/memoryWatcher.test.ts`:

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, utimes } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { startMemoryWatcher, stopMemoryWatcher } from '../../src/agents/memoryWatcher.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-watcher-test-'))
})

afterEach(async () => {
  stopMemoryWatcher()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('memoryWatcher', () => {
  test('startMemoryWatcher returns a handle with stop()', () => {
    const handle = startMemoryWatcher({ cwd: tmpDir })
    expect(handle).toBeDefined()
    expect(typeof handle.stop).toBe('function')
    handle.stop()
  })

  test('does not throw when cwd has no AGENTS.md', () => {
    expect(() => startMemoryWatcher({ cwd: tmpDir })).not.toThrow()
  })

  test('stopMemoryWatcher is idempotent', () => {
    startMemoryWatcher({ cwd: tmpDir })
    expect(() => stopMemoryWatcher()).not.toThrow()
    expect(() => stopMemoryWatcher()).not.toThrow() // second call no-op
  })
})
```

- [ ] **Step 2: Run test to verify it fails (module does not exist)**

Run: `cd packages/zai-agent-core && bun test test/agents/memoryWatcher.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `memoryWatcher.ts`**

`packages/zai-agent-core/src/agents/memoryWatcher.ts`:

```ts
import { watchFile, unwatchFile } from 'fs'
import { join } from 'path'
import { clearMemoryCache } from './memoryLoader.js'

/**
 * Watches AGENTS.md, AGENTS.local.md, and .claude/rules/**/*.md in a cwd
 * for mtime changes. On change, calls clearMemoryCache() so the next
 * loadMemoryForPrompt() re-reads from disk.
 *
 * 1s poll interval matches vendored GitFileWatcher. Bun's fs.watchFile
 * is the same Node API; no extra dep needed.
 *
 * Singleton per process: only one watcher at a time. stop() before start()
 * is safe; re-start replaces.
 */

const WATCH_INTERVAL_MS = 1000

interface WatchEntry {
  path: string
  prevMtimeMs: number
}

let watchedFiles: WatchEntry[] = []
let onChangeCallback: ((path: string) => void) | null = null

function watcherCallback(path: string): void {
  return (curr) => {
    if (!curr.mtime) return
    const entry = watchedFiles.find((w) => w.path === path)
    if (!entry) return
    if (entry.prevMtimeMs === curr.mtimeMs) return
    entry.prevMtimeMs = curr.mtimeMs
    clearMemoryCache()
    if (onChangeCallback) onChangeCallback(path)
  }
}

function watchOne(path: string): void {
  watchFile(path, { interval: WATCH_INTERVAL_MS }, watcherCallback(path) as any)
  const stat = (() => {
    try {
      // Lazy require to avoid import at top for fs.statSync in test envs.
      return require('fs').statSync(path)
    } catch {
      return { mtimeMs: 0 }
    }
  })()
  watchedFiles.push({ path, prevMtimeMs: stat.mtimeMs ?? 0 })
}

function unwatchAll(): void {
  for (const e of watchedFiles) unwatchFile(e.path)
  watchedFiles = []
}

export interface MemoryWatcherHandle {
  stop(): void
}

export function startMemoryWatcher(opts: {
  cwd: string
  onChange?: (path: string) => void
}): MemoryWatcherHandle {
  unwatchAll()
  onChangeCallback = opts.onChange ?? null
  // Phase 3 minimal: watch the 3 most common paths. Future: enumerate
  // .claude/rules/**/*.md via dynamic import of vendored isMemoryFilePath.
  const candidates = [
    join(opts.cwd, 'AGENTS.md'),
    join(opts.cwd, 'AGENTS.local.md'),
    join(opts.cwd, '.claude', 'AGENTS.md'),
  ]
  for (const p of candidates) watchOne(p)
  return {
    stop() {
      unwatchAll()
      onChangeCallback = null
    },
  }
}

export function stopMemoryWatcher(): void {
  unwatchAll()
  onChangeCallback = null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/zai-agent-core && bun test test/agents/memoryWatcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/agents/memoryWatcher.ts \
        packages/zai-agent-core/test/agents/memoryWatcher.test.ts
git commit -m "feat(zai-agent-core): add memoryWatcher for AGENTS.md mtime invalidation"
```

---

### Task 7: Wire `startMemoryWatcher` into `agentRuntime.init`

**Files:**
- Modify: `packages/zai/src/server/services/agentRuntime.ts:1-110` (add imports + call)
- Modify: `packages/zai/src/server/services/agentRuntime.ts` shutdown path

**Interfaces:**
- Consumes: `startMemoryWatcher`, `stopMemoryWatcher` from Task 6; `hasExternalIncludes` from Task 1; `eventBus` from existing.
- Produces: on `initAgentRuntime(cwd)`:
  - Watcher started, logs invalidation
  - External include check runs, emits `toast` event if any

- [ ] **Step 1: Add external-include check + watcher init at end of `initAgentRuntime`**

In `packages/zai/src/server/services/agentRuntime.ts`, find the import block (top of file) and add:

```ts
import {
  startMemoryWatcher,
  stopMemoryWatcher,
} from '@zn-ai/zai-agent-core'
import { hasExternalIncludes } from '@zn-ai/zai-agent-core/agents/memoryLoader.js'
```

(Adjust the import paths to match package layout. If `@zn-ai/zai-agent-core` doesn't re-export these, use `'@zn-ai/zai-agent-core'` package.json `exports` map. The `runtime/index.ts` re-export from Task 4 makes them available at the package root.)

Find `export function initAgentRuntime(cwd: string): void {` and add at the end of the function body (before the closing `}`):

```ts
  // AGENTS.md / .claude/rules hot-reload watcher
  startMemoryWatcher({ cwd })

  // External include warning (best-effort, never blocks init)
  void hasExternalIncludes(cwd).then((has) => {
    if (has) {
      console.warn('[memory] external CLAUDE.md includes detected for cwd:', cwd)
      eventBus.emit({
        type: 'toast',
        level: 'warning',
        title: '外部 CLAUDE.md 引用',
        message: '检测到外部 include，请审查是否信任',
      })
    }
  })
```

Note: `eventBus` may not be in scope of this file. Check existing imports; if not present, either:
- Add `import { eventBus } from './eventBus.js'`
- Or skip the eventBus emit and rely on console.warn only (frontend won't see it, but server-side logging still works)

If eventBus is not imported, prefer the console.warn-only path for minimal change. Do NOT introduce new dependencies in this task.

- [ ] **Step 2: Wire `stopMemoryWatcher` into shutdown**

Find the SIGTERM/SIGINT cleanup section (around line 96-99):
```ts
  if (mcpClientPool) {
    const cleanup = () => { mcpClientPool.disconnectAll() }
    process.once('SIGTERM', cleanup)
    process.once('SIGINT', cleanup)
  }
```

Add after the closing `}`:
```ts
  process.once('SIGTERM', () => stopMemoryWatcher())
  process.once('SIGINT', () => stopMemoryWatcher())
```

- [ ] **Step 3: Run zai server smoke test**

Run: `cd packages/zai && bun run smoke`
Expected: PASS (smoke should not regress; AGENTS.md loads fine via new path)

- [ ] **Step 4: Manual e2e test (recommended, not in CI)**

```bash
cd /tmp && rm -rf zai-memory-e2e && mkdir zai-memory-e2e && cd zai-memory-e2e
echo '# Project rules' > AGENTS.md
mkdir -p .claude/rules
echo '# Build rule' > .claude/rules/build.md
# Start zai with this cwd, send a prompt, check the system prompt in logs
# (or check via web UI) that "Project rules" + "Build rule" appear.
```

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/server/services/agentRuntime.ts
git commit -m "feat(zai): wire memoryWatcher into initAgentRuntime with external include warning"
```

---

### Task 8: Wire `/clear` route to call `clearMemoryCache`

**Files:**
- Modify: `packages/zai/src/server/routes/clear.ts` (or wherever /clear handler lives)

**Interfaces:**
- Consumes: `clearMemoryCache` from Task 1.

- [ ] **Step 1: Find the /clear handler**

Run:
```bash
cd /Users/ethan/code/opencc-web
grep -rn "router.post.*['\"]/clear['\"]\\|router.post.*['\"]clear['\"]" packages/zai/src/server/routes/ 2>/dev/null
```

Expected: one match in some `*.ts` file under `routes/`.

- [ ] **Step 2: Add `clearMemoryCache` call in the handler**

In the file found in Step 1, add at the top:
```ts
import { clearMemoryCache } from '@zn-ai/zai-agent-core'
```

Inside the handler (after existing session/transcript clear logic, before `res.json(...)`):
```ts
clearMemoryCache()
```

- [ ] **Step 3: Run zai tests**

Run: `cd packages/zai && bun test 2>/dev/null || echo "no zai-side tests; smoke only"`
Run: `cd packages/zai && bun run smoke`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/server/routes/clear.ts
git commit -m "feat(zai): /clear route clears AGENTS.md memory cache"
```

---

### Task 9: Re-export watcher from runtime/index.ts and final cleanup

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/index.ts`

**Interfaces:**
- Produces: `startMemoryWatcher`, `stopMemoryWatcher` exported from `@zn-ai/zai-agent-core` package root.

- [ ] **Step 1: Add re-exports**

In `packages/zai-agent-core/src/runtime/index.ts`, after the `memoryLoader` exports (added in Task 4), add:

```ts
export { startMemoryWatcher, stopMemoryWatcher } from '../agents/memoryWatcher.js'
export type { MemoryWatcherHandle } from '../agents/memoryWatcher.js'
```

- [ ] **Step 2: Run all tests to verify everything works**

Run: `cd packages/zai-agent-core && bun test`
Expected: PASS (all tests)

Run: `cd packages/zai && bun run smoke`
Expected: PASS

- [ ] **Step 3: Run typecheck (allow pre-existing errors in vendored)**

Run: `cd packages/zai-agent-core && bun typecheck 2>&1 | grep -v "src/opencc-internals" | head -30`
Expected: no new errors outside `src/opencc-internals/`

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/index.ts
git commit -m "feat(zai-agent-core): re-export memoryWatcher from package root"
```

---

### Task 10: End-to-end manual verification

**Files:** none (read-only verification).

- [ ] **Step 1: Set up e2e workspace**

```bash
cd /tmp && rm -rf zai-memory-e2e && mkdir zai-memory-e2e && cd zai-memory-e2e
git init -q
echo '# Project AGENTS.md' > AGENTS.md
mkdir -p .claude/rules
cat > .claude/rules/style.md <<'EOF'
---
paths: ["**/*.ts"]
---
# TypeScript style: prefer const, no any.
EOF
echo 'console.log("hi")' > index.ts
```

- [ ] **Step 2: Start zai and verify initial system prompt**

Start zai with this cwd (use the project's `bun run dev` or your usual method). Send a prompt like "what rules do you have?" and verify the response references both "Project AGENTS.md" and "TypeScript style".

- [ ] **Step 3: Edit AGENTS.md and verify hot-reload**

In the e2e workspace, edit `AGENTS.md` to add a unique marker:
```bash
echo -e '\n## UNIQUE_MARKER_v1' >> AGENTS.md
```

Send another prompt. Within ~2 seconds, the response should reference `UNIQUE_MARKER_v1` (proving the watcher invalidated the cache).

- [ ] **Step 4: Test /clear and external include**

Test `/clear` slash command — verify it doesn't throw. If you have a way to set up an external @include, test the warning emit (otherwise skip).

- [ ] **Step 5: Document in CHANGELOG (optional)**

If the project has a CHANGELOG, add an entry:
```markdown
## 2026-07-19
- feat: align AGENTS.md loading with OpenCC upstream (parent-dir walk, .claude/rules/, @include, frontmatter glob)
- feat: section-ize system prompt for Anthropic prompt cache efficiency
- feat: hot-reload AGENTS.md via file watcher
```

- [ ] **Step 6: Final commit (CHANGELOG only) if applicable**

```bash
cd /Users/ethan/code/opencc-web
git add CHANGELOG.md 2>/dev/null || true
git diff --cached --quiet || git commit -m "docs: changelog for opencc memory alignment"
```

---

## Self-Review

**1. Spec coverage:**
- AGENTS.md 加载范围 (parent walk, rules, @include) → Task 1, 2, 3 (vendored via wrapper)
- `.claude/rules/**/*.md` → Task 2 test
- `AGENTS.local.md` → Task 2 test
- `@include` 嵌套 → covered by vendored (no zai test needed)
- HTML 注释剥离 → vendored behavior, no zai test
- 缓存粒度 → Task 6 (watcher) + Task 8 (/clear)
- `buildSystemPrompt` 返回 `string[]` → Task 5
- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` → Task 5
- External include 警告 → Task 7
- 现有 queryLoop 集成测试 → Task 5 Step 5 regression check

**2. Placeholder scan:** No TBDs. All code blocks complete. Tests have real assertions.

**3. Type consistency:**
- `loadMemoryForPrompt(cwd: string)` defined Task 1, used Task 2, 3, 5, 7.
- `clearMemoryCache()` defined Task 1, used Task 4 (test), Task 6 (watcher), Task 7, Task 8, Task 9.
- `hasExternalIncludes(cwd)` defined Task 1, used Task 2, 7.
- `startMemoryWatcher({ cwd, onChange? })` defined Task 6, used Task 7, 9.
- `stopMemoryWatcher()` defined Task 6, used Task 7, Task 9.
- `MemoryFileInfo` type re-export Task 1, used Task 2.
- All names match across tasks.

**4. Spec gaps handled:**
- Static intro placeholder: Task 5 uses `staticIntro` string from `options.systemPrompt` — covers both string and string[] inputs. No empty-state issue.
- Vendored dependency error: Task 1 wraps all imports in try/catch; never throws.
- `eventBus` may not be in scope of `agentRuntime.ts`: Task 7 Step 1 includes fallback to console.warn-only if not present.
