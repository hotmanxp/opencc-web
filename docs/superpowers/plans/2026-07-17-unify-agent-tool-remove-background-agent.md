# Unify Agent Tool — Hard-Delete BackgroundAgentTool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the legacy `BackgroundAgentTool` so the LLM-facing tool list shows exactly one Agent tool (the unified `Agent` with `run_in_background` toggle), then simplify `disallowedTools: ['Agent', 'BackgroundAgent']` to `['Agent']` everywhere.

**Architecture:** Pure deletion + reference cleanup. Delete `BackgroundAgentTool/` directory, remove its registration from `tools/index.ts` and `opencc-internals/tools.ts`, replace any server-side or test usage with `AgentTool`, simplify the `disallowedTools` literal in three places (AgentTool sync path, DefaultBackgroundRuntime.runOne, queryEngine JSDoc, types JSDoc), update tests' fixture names. `BackgroundAgentResultTool` (query tool) stays unchanged.

**Tech Stack:** TypeScript, vitest, bun test runner.

## Global Constraints

- `BackgroundAgentTool/` directory: full deletion.
- `BackgroundAgentResultTool/`: untouched (different concern, queries task state).
- `AgentTool.name` stays `'Agent'`. `BackgroundAgentResultTool.name` stays `'BackgroundAgentResult'` (sub-string overlap is fine).
- After all tasks: `grep -rnE '\bBackgroundAgent\b' packages/zai-agent-core/src/ packages/zai-agent-core/test/ packages/zai/src/ | grep -v BackgroundAgentResult` returns **zero** matches.
- `disallowedTools: ['Agent', 'BackgroundAgent']` becomes `['Agent']` at every site.
- Style: keep edits minimal and scoped; do not restructure unrelated files.

## File Structure

| File | Action |
|------|--------|
| `packages/zai-agent-core/src/tools/BackgroundAgentTool/BackgroundAgentTool.ts` | Delete |
| `packages/zai-agent-core/src/tools/BackgroundAgentTool/prompt.ts` | Delete |
| `packages/zai-agent-core/src/tools/BackgroundAgentTool/schema.ts` | Delete |
| `packages/zai-agent-core/src/tools/BackgroundAgentTool/index.ts` | Delete |
| `packages/zai-agent-core/src/tools/index.ts` | Remove import + entry |
| `packages/zai-agent-core/src/opencc-internals/tools.ts` | Remove import + entry; keep `BackgroundAgentResultTool` |
| `packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts` | `disallowedTools` simplification |
| `packages/zai-agent-core/src/tools/AgentTool/prompt.ts` | Drop `BackgroundAgent` mention |
| `packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts` | `disallowedTools` simplification |
| `packages/zai-agent-core/src/runtime/types.ts` | JSDoc update on `QueryOptions.disallowedTools` |
| `packages/zai-agent-core/src/runtime/queryEngine.ts` | JSDoc update |
| `packages/zai-agent-core/src/runtime/background/registry.ts` | Audit (likely no change) |
| `packages/zai-agent-core/src/tools/TaskStopTool/prompt.ts` | Audit doc reference |
| `packages/zai-agent-core/src/tools/TaskOutputTool/{schema.ts,TaskOutputTool.ts}` | Audit |
| `packages/zai-agent-core/src/tools/TaskCreateTool/prompt.ts` | Audit |
| `packages/zai-agent-core/src/runtime/background/index.ts` | Audit (re-exports) |
| `packages/zai/src/server/services/backgroundRuntime.ts` | Audit (comment only) |
| `packages/zai-agent-core/test/runtime/resolveToolPool-disallowed.test.ts` | Drop `BackgroundAgent` from fixture + assertion |
| `packages/zai-agent-core/test/tools/AgentTool.test.ts` | Audit (rename mocks) |

---

### Task 1: Audit every reference site and write findings to a scratch file

**Files:**
- Create: `/tmp/background-agent-audit.md` (scratch; deleted at end)

**Interfaces:** none.

- [ ] **Step 1: Grep for every reference in code**

Run from repo root:
```bash
cd /Users/ethan/code/opencc-web
grep -rnE '\bBackgroundAgent\b' \
  packages/zai-agent-core/src/ \
  packages/zai-agent-core/test/ \
  packages/zai/src/ \
  --include='*.ts' --include='*.tsx'
```

- [ ] **Step 2: Classify each match**

For each match, decide one of three actions:

1. **DELETE** — the line imports `BackgroundAgentTool` (the to-be-deleted dispatch tool) or uses `BACKGROUND_AGENT_TOOL_NAME` constant, or refers to `BackgroundAgent` as a tool name. Plan a follow-up edit (Tasks 2-6) to remove the import / line.
2. **KEEP** — the match is for `BackgroundAgentResultTool` / `BackgroundAgentResultInputSchema` / `BackgroundAgentResult` (the kept query tool). Leave alone.
3. **AUDIT_IN_PLACE** — the match is in a comment / JSDoc / prompt string mentioning the dispatch tool by name. Update the text to drop the `BackgroundAgent` reference (it's now obsolete).

Write the classification table to `/tmp/background-agent-audit.md`:

```markdown
# BackgroundAgent reference audit (snapshot before deletion)

## DELETE (imports / re-exports / constants)
- file:line — reason

## KEEP (BackgroundAgentResultTool — query tool, unaffected)
- file:line — reason

## AUDIT_IN_PLACE (comments / JSDoc / prompt text)
- file:line — current text → replacement text
```

- [ ] **Step 3: Hand the audit file to yourself for Tasks 2-6**

The audit table is the input for all subsequent tasks. Save and continue.

---

### Task 2: Delete the BackgroundAgentTool directory + drop registrations

**Files:**
- Delete: `packages/zai-agent-core/src/tools/BackgroundAgentTool/BackgroundAgentTool.ts`
- Delete: `packages/zai-agent-core/src/tools/BackgroundAgentTool/prompt.ts`
- Delete: `packages/zai-agent-core/src/tools/BackgroundAgentTool/schema.ts`
- Delete: `packages/zai-agent-core/src/tools/BackgroundAgentTool/index.ts`
- Modify: `packages/zai-agent-core/src/tools/index.ts`
- Modify: `packages/zai-agent-core/src/opencc-internals/tools.ts`

**Interfaces:**
- Consumes: `/tmp/background-agent-audit.md` DELETE list for this task.
- Produces: `BackgroundAgentTool` no longer importable; `getZaiRuntimeTools()` doesn't include it; `opencc-internals/tools.ts` buildTool path doesn't include it.

- [ ] **Step 1: Delete the 4 source files**

```bash
cd /Users/ethan/code/opencc-web
git rm packages/zai-agent-core/src/tools/BackgroundAgentTool/BackgroundAgentTool.ts \
       packages/zai-agent-core/src/tools/BackgroundAgentTool/prompt.ts \
       packages/zai-agent-core/src/tools/BackgroundAgentTool/schema.ts \
       packages/zai-agent-core/src/tools/BackgroundAgentTool/index.ts
```

Expected: 4 files deleted; `BackgroundAgentTool/` directory gone.

- [ ] **Step 2: Remove import + entry from `tools/index.ts`**

In `packages/zai-agent-core/src/tools/index.ts`:

- Remove the import line:
  ```ts
  import { BackgroundAgentTool } from './BackgroundAgentTool/BackgroundAgentTool.js'
  ```
- Remove the entry from `getZaiRuntimeTools()` return array:
  ```ts
  wrapAsOpenccTool(BackgroundAgentTool),
  ```
- Leave `BackgroundAgentResultTool` import + entry untouched.

- [ ] **Step 3: Remove import + entry from `opencc-internals/tools.ts`**

In `packages/zai-agent-core/src/opencc-internals/tools.ts`:

- Remove the import line:
  ```ts
  import { BackgroundAgentTool } from './tools/BackgroundAgentTool/index.js'
  ```
- In the `bgTools` const (around line 189-191), remove `BackgroundAgentTool` from the array:
  ```ts
  const bgTools = isBgAgentRuntimeEnabled()
    ? [BackgroundAgentResultTool]   // ← was: [BackgroundAgentTool, BackgroundAgentResultTool]
    : []
  ```
- Leave `BackgroundAgentResultTool` import + reference untouched.

- [ ] **Step 4: Type-check**

```bash
cd /Users/ethan/code/opencc-web/packages/zai-agent-core
bunx tsc -b --noEmit 2>&1 | grep -E '(BackgroundAgent|tools/index|opencc-internals/tools)' | head -20
```

Expected: zero matches for `BackgroundAgent` (no leftover imports). The `BackgroundAgentResultTool` references stay.

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add -u packages/zai-agent-core/src/tools/BackgroundAgentTool \
        packages/zai-agent-core/src/tools/index.ts \
        packages/zai-agent-core/src/opencc-internals/tools.ts
git commit -m "refactor(zai-agent-core): hard-delete BackgroundAgentTool directory

Unifies dispatch under AgentTool.run_in_background. Removes the
BackgroundAgentTool registration from tools/index.ts and
opencc-internals/tools.ts. BackgroundAgentResultTool (the query tool)
is unaffected and remains registered."
```

---

### Task 3: Simplify disallowedTools + update JSDoc comments

**Files:**
- Modify: `packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts:98`
- Modify: `packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts`
- Modify: `packages/zai-agent-core/src/runtime/types.ts`
- Modify: `packages/zai-agent-core/src/runtime/queryEngine.ts`
- Modify: `packages/zai-agent-core/src/tools/AgentTool/prompt.ts`

**Interfaces:** none.

- [ ] **Step 1: Simplify in `AgentTool.ts`**

In `packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts`, find line 98:
```ts
      disallowedTools: ['Agent', 'BackgroundAgent'],
```
Replace with:
```ts
      disallowedTools: ['Agent'],
```

- [ ] **Step 2: Simplify in `DefaultBackgroundRuntime.ts`**

In `packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts`, find the `disallowedTools` field in the `QueryOptions` construction inside `runOne`:
```ts
      // 防递归:后台 sub-agent 不能继续派 sub-agent
      disallowedTools: ['Agent', 'BackgroundAgent'],
```
Replace with:
```ts
      // 防递归:后台 sub-agent 不能继续派 sub-agent
      disallowedTools: ['Agent'],
```

- [ ] **Step 3: Update JSDoc on `QueryOptions.disallowedTools`**

In `packages/zai-agent-core/src/runtime/types.ts`, find the JSDoc block above `disallowedTools?: string[]` (around line 119-126, recently added by the recursion-prevention plan). Replace the body to drop `BackgroundAgent` mention. Final text:

```ts
  /**
   * 工具黑名单。resolveToolPool 在构造完工具池后,移除 name 出现在此列表里的工具。
   * 由 AgentTool / DefaultBackgroundRuntime 在派发 sub-agent 时填充
   * `['Agent']`,防止 sub-agent 递归派发 sub-agent
   * (复刻 OpenCC sub-agents 文档中的 disallowedTools 语义)。
   */
  disallowedTools?: string[]
```

- [ ] **Step 4: Update JSDoc on filter step in `queryEngine.ts`**

In `packages/zai-agent-core/src/runtime/queryEngine.ts`, find the comment block just above the `pool.filter` call in `resolveToolPool`:

```ts
  // 最后一步:按 disallowedTools 黑名单剔除工具 (复刻 OpenCC disallowedTools 语义)。
  // AgentTool / DefaultBackgroundRuntime 在派发 sub-agent 时传入
  // ['Agent', 'BackgroundAgent'],阻断递归派发。
```

Replace with:

```ts
  // 最后一步:按 disallowedTools 黑名单剔除工具 (复刻 OpenCC disallowedTools 语义)。
  // AgentTool / DefaultBackgroundRuntime 在派发 sub-agent 时传入 ['Agent'],阻断递归派发。
```

- [ ] **Step 5: Drop `BackgroundAgent` mention in `AgentTool/prompt.ts`**

In `packages/zai-agent-core/src/tools/AgentTool/prompt.ts`, find the appended recursion-prevention line:

```ts
    '派生的子 agent 不能再调用 Agent / BackgroundAgent(防递归)。需要更多 sub-agent 时由父 session 派发。',
```

Replace with:

```ts
    '派生的子 agent 不能递归调用 Agent(防递归)。需要更多 sub-agent 时由父 session 派发。',
```

- [ ] **Step 6: Type-check + tests**

```bash
cd /Users/ethan/code/opencc-web/packages/zai-agent-core
bunx tsc -b --noEmit 2>&1 | grep -E "BackgroundAgent" | grep -v BackgroundAgentResult | head -10
bun test test/runtime/resolveToolPool-disallowed.test.ts test/tools/AgentTool.test.ts 2>&1 | tail -5
```

Expected: first grep returns empty; second command shows tests still pass at their pre-change counts (resolveToolPool-disallowed currently fails — Task 4 will fix; AgentTool passes).

- [ ] **Step 7: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts \
        packages/zai-agent-core/src/tools/AgentTool/prompt.ts \
        packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts \
        packages/zai-agent-core/src/runtime/types.ts \
        packages/zai-agent-core/src/runtime/queryEngine.ts
git commit -m "refactor(zai-agent-core): simplify disallowedTools to ['Agent']

BackgroundAgent is gone, so the recursion-prevention deny list only
needs 'Agent'. Updated JSDoc on QueryOptions.disallowedTools, the
filter step in resolveToolPool, and the AgentTool prompt to drop the
BackgroundAgent mention."
```

---

### Task 4: Update tests (resolveToolPool-disallowed + AgentTool mocks)

**Files:**
- Modify: `packages/zai-agent-core/test/runtime/resolveToolPool-disallowed.test.ts`
- Modify: `packages/zai-agent-core/test/tools/AgentTool.test.ts` (audit — only if mocks use BackgroundAgentTool name)

**Interfaces:** none.

- [ ] **Step 1: Update `resolveToolPool-disallowed.test.ts`**

In `packages/zai-agent-core/test/runtime/resolveToolPool-disallowed.test.ts`:

- In the `baseTools` array (line ~13-18), remove the `BackgroundAgent` entry. Keep `Read`, `Write`, `Agent`, `Bash` (4 entries total):
  ```ts
  const baseTools: AnyTool[] = [
    fakeTool('Read'),
    fakeTool('Write'),
    fakeTool('Agent'),
    fakeTool('Bash'),
  ]
  ```
- In test "removes a single named tool, leaves others alone", change the assertion:
  ```ts
  expect(names).toContain('BackgroundAgent')
  ```
  to:
  ```ts
  expect(names).toContain('Bash')
  ```
- In test "removes multiple named tools", change:
  ```ts
  const opts: QueryOptions = { disallowedTools: ['Agent', 'BackgroundAgent'] }
  ```
  to:
  ```ts
  const opts: QueryOptions = { disallowedTools: ['Agent', 'Read'] }
  ```
  And add an assertion that `Read` is removed (matching the spirit of the original):
  ```ts
  expect(names).not.toContain('Agent')
  expect(names).not.toContain('Read')
  expect(names).toContain('Write')
  expect(names).toContain('Bash')
  ```
- In test "undefined disallowedTools is a no-op", change:
  ```ts
  expect(result.map(t => t.name)).toEqual(['Read', 'Write', 'Agent', 'BackgroundAgent', 'Bash'])
  ```
  to:
  ```ts
  expect(result.map(t => t.name)).toEqual(['Read', 'Write', 'Agent', 'Bash'])
  ```

- [ ] **Step 2: Audit `AgentTool.test.ts`**

Run:
```bash
grep -nE 'BackgroundAgent|BACKGROUND_AGENT' /Users/ethan/code/opencc-web/packages/zai-agent-core/test/tools/AgentTool.test.ts
```

If grep returns matches, replace any `BackgroundAgentTool` reference with `AgentTool` (or remove the import if unused). If grep is empty, no change needed.

- [ ] **Step 3: Run tests**

```bash
cd /Users/ethan/code/opencc-web/packages/zai-agent-core
bun test test/runtime/resolveToolPool-disallowed.test.ts test/tools/AgentTool.test.ts 2>&1 | tail -10
```

Expected: all tests pass (resolveToolPool-disallowed 6/6; AgentTool whatever count).

- [ ] **Step 4: Full zai-agent-core suite**

```bash
cd /Users/ethan/code/opencc-web/packages/zai-agent-core
bun test 2>&1 | tail -3
```

Expected: pre-existing 18 failures remain unchanged; no NEW failures.

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/test/runtime/resolveToolPool-disallowed.test.ts \
        packages/zai-agent-core/test/tools/AgentTool.test.ts
git commit -m "test(zai-agent-core): drop BackgroundAgent from fixture after tool merge

resolveToolPool-disallowed.test.ts: replace BackgroundAgent with Read
in fixtures + assertions so the test still exercises multi-tool filter.
AgentTool.test.ts: rename any leftover BackgroundAgentTool mock refs."
```

---

### Task 5: Audit remaining reference sites (TaskStop / TaskOutput / TaskCreate / registry / server)

**Files:**
- Modify: per audit findings in `/tmp/background-agent-audit.md` for AUDIT_IN_PLACE rows.

**Interfaces:** none.

- [ ] **Step 1: Open the audit file and process every AUDIT_IN_PLACE row**

For each row, open the file, find the line, edit the comment / JSDoc / prompt text to drop the `BackgroundAgent` reference. Common patterns:
- "派发到 BackgroundAgent / 后台 agent" → "派发到 background agent"
- "BackgroundAgentTool 派发后" → "Agent 工具以 run_in_background:true 派发后"
- Any other literal mention of `BackgroundAgent` (the dispatch tool, NOT `BackgroundAgentResult`)

- [ ] **Step 2: Audit `packages/zai/src/server/services/backgroundRuntime.ts`**

Read the file around line 91 (the comment). If the comment names `BackgroundAgentTool`, rewrite to say "the unified Agent tool" or similar — but **don't change behavior**. If the comment only references `BackgroundAgentRuntime` (the runtime class, kept), leave it.

- [ ] **Step 3: Audit `packages/zai-agent-core/src/runtime/background/registry.ts`**

Read the file. If it only registers `BackgroundAgentRuntime` (runtime class, kept), no change. If it re-exports anything from `BackgroundAgentTool/`, remove the re-export.

- [ ] **Step 4: Audit `packages/zai-agent-core/src/runtime/background/index.ts`**

Same pattern — drop any re-export of `BackgroundAgentTool` / `BackgroundAgentInput` / `BACKGROUND_AGENT_TOOL_NAME`. Keep `BackgroundAgentResultTool` re-exports untouched.

- [ ] **Step 5: Run final smoke checks**

```bash
cd /Users/ethan/code/opencc-web
grep -rnE '\bBackgroundAgent\b' \
  packages/zai-agent-core/src/ packages/zai-agent-core/test/ packages/zai/src/ \
  --include='*.ts' --include='*.tsx' \
  | grep -v BackgroundAgentResult
```

Expected: zero output. If any line remains, edit it (Task 5 is responsible for completeness).

```bash
cd /Users/ethan/code/opencc-web/packages/zai-agent-core
bunx tsc -b --noEmit 2>&1 | head -10
bun test 2>&1 | tail -3
```

Expected: empty tsc output; pre-existing failure count unchanged.

- [ ] **Step 6: Commit (one or more commits depending on how many sites needed touching)**

If multiple files changed, group by file category:
- prompt/doc fixes (TaskStopTool, TaskCreateTool, TaskOutputTool, registry, index, server):
  ```bash
  cd /Users/ethan/code/opencc-web
  git add packages/zai-agent-core/src/tools/TaskStopTool/prompt.ts \
          packages/zai-agent-core/src/tools/TaskOutputTool \
          packages/zai-agent-core/src/tools/TaskCreateTool/prompt.ts \
          packages/zai-agent-core/src/runtime/background \
          packages/zai/src/server/services/backgroundRuntime.ts
  git commit -m "docs(zai-agent-core): drop BackgroundAgent references from comments + prompts

After the BackgroundAgentTool merge into AgentTool.run_in_background,
comments and prompt strings that named the old tool are now stale.
Audit-and-rewrite pass; behavior unchanged."
  ```

---

### Task 6: Push the commits

- [ ] **Step 1: Push**

```bash
cd /Users/ethan/code/opencc-web
git push origin main
```

Expected: 4-5 commits land on `origin/main`.

---

## Self-Review

**Spec coverage:**
- ✅ Behavior contract table → Task 2 (delete dir + deregister), Task 3 (disallowedTools simplification), Task 4 (tests), Task 5 (audit cleanup)
- ✅ File-by-file mapping from spec §"File-by-file mapping" → all rows covered by Tasks 2-5
- ✅ Smoke checks (grep zero + tsc clean + test counts) → Task 5 step 5
- ✅ Out of scope items (`BackgroundAgentResultTool`, `runtime/background/*` internal class names) — explicitly excluded from each Task's scope
- ✅ Migration / compatibility → covered by the breaking-change callout in commit messages

**Placeholder scan:** No `TBD`/`TODO`/`similar to`/`fill in details`. Audit-then-fix pattern is explicit, not a placeholder.

**Type consistency:**
- `disallowedTools: ['Agent']` used identically in Tasks 3 and 5 audit cleanup.
- Test fixture: `baseTools` (4 entries) — same list shape, just one fewer entry.
- Tool names: `'Agent'` matches `AgentTool.ts:15`; `'BackgroundAgentResult'` matches `BackgroundAgentResultTool.ts:10`; no `BackgroundAgent` tool name anywhere after Task 2.