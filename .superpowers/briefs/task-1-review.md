# Task 1 Review — 工具调用降级文案 / 消灭"裸 unknown"

**Reviewer:** code-reviewer agent
**Date:** 2026-07-18
**Commit under review:** `c06b313` on `main`
**Diff source:** `.superpowers/briefs/task-1-review-diff.txt` (70 lines, 2 files, +19/-1)

---

## Spec compliance checklist

### ✅ Agent.tsx:515 — fallback chain matches brief verbatim
The block at line 515 matches the brief's spec exactly, character for character:
```tsx
const rawName = (msg.name as string | undefined)?.trim() || ''
const shortId = (msg.toolUseId as string | undefined)?.slice(-8) ?? '????????'
// 兜底: 模型 SSE 流里有个别时刻 toolName 没带过来(已知 race condition,
// tool_use:start 与 content_block_start 都在抢),显示 "未知工具 (id:xxxxxxxx)"
// 比 "unknown" 强,user 至少能根据 id 复制去后端日志 grep
const name = rawName || `未知工具 (id:${shortId})`
```
Including the three-line Chinese comment — preserved verbatim, matches the codebase's dense-Chinese style (e.g., the `// 工具调用块:` comment immediately above uses the same conventions: parenthetical aside, plain-text reasoning, no Markdown decoration).

### ✅ useAgentStore.ts — `console.warn` inside `if (idx === -1)` branch
Inserted at lines 485–497, immediately after the `created` literal and before `const updates`. The guard is exactly as specified:
```ts
if (!incomingName && !(msg.name as string | undefined)) { … }
```
This fires **only** when both `incomingName` (store-level delta) and `msg.name` (raw SSE payload) are empty — i.e. server really did leak the toolName. Matches the Bug A diagnostic intent. The `typeof console !== 'undefined'` guard is preserved verbatim from the brief; harmless in browser, defensive for SSR/test envs.

### ✅ Commit message
`fix(zai-web): degrade unknown tool name to readable label + diagnose warn` — exact match (verified via `git show c06b313`).

### ✅ Scope
Only the two listed files touched. `git show --stat c06b313` confirms:
```
packages/zai/src/web/src/pages/Agent.tsx        |  7 ++++++-
packages/zai/src/web/src/store/useAgentStore.ts | 13 +++++++++++++
2 files changed, 19 insertions(+), 1 deletion(-)
```
No package.json, lockfile, test, or unrelated changes.

### ✅ No new dependencies, no test files
No test files added (per brief, this task has no tests). No `package.json` changes.

---

## Code quality assessment

### TypeScript safety

The two `as` casts on `msg.name` and `msg.toolUseId` are sound:
- `AgentMessage` types both fields as `unknown` (per brief), so the `as string | undefined` cast is the established convention — see the surrounding code at line 478 (`msg.name as string`), line 479 (`msg.input as Record<string, unknown>`), line 533 (`msg.toolUseId as string`). The new casts are **strictly safer** than the surrounding ones (explicit `| undefined` vs bare `as string`).
- The `?.trim()` and `?.slice(-8)` operators short-circuit on `undefined`, so non-string values (after the `as string | undefined` cast) cannot throw at runtime — they collapse to empty string / `'????????'` via the `?? ''` / `?? '????????'` fallbacks.
- No risk of TypeError from a malformed payload.

### `input: msg.input` in console.warn — sensitive-data leak?

This is the one finding worth flagging. The brief explicitly asked for `input: msg.input` in the warn payload, so it's spec-compliant — but as a code-quality concern, tool inputs in this codebase can include:
- File paths from `Read` / `Edit` / `Glob` tools
- Shell command bodies from `Bash`
- Search patterns / file contents from `Grep`

A console.warn at this level **does** leak into the user's browser DevTools console, which is a wider audience than the brief's stated diagnostic audience ("排查 Bug A 的现场统计"). That said:
- The brief explicitly scoped this as a diagnostic warn to gather stats on Bug A.
- The label `[tool_unknown]` and the `'runtime.tool_call 漏传 toolName'` message are loud enough that anyone seeing this in their console will know it's diagnostic noise.
- The data only fires in the rare race-condition case (both `incomingName` and `msg.name` empty), not on every tool call.

**Verdict:** consistent with the brief's stated intent; not a blocker. Worth a follow-up ADR or comment in the file noting that this is intentional diagnostic noise that may include tool input payloads, so a future reader doesn't strip it out as "PII leakage". Flagging as **Minor** because the brief's intent is preserved, but a one-line note in the brief (or in a follow-up ADR) about the data-collection audience would help the next maintainer.

### Comment quality

Matches codebase style. The codebase consistently uses:
- Lowercase Chinese with half-width punctuation in inline comments (e.g., `// 工具调用块:`, `// 兜底: 模型 SSE 流里...`)
- Inline ASCII in the comment where natural (e.g., `tool_use:start` referenced verbatim)
- Parenthetical asides for non-obvious context

The new three-line comment at Agent.tsx:517–519 follows this pattern exactly. No style drift.

### Code reuse / DRY

One observation, **Minor**: the `shortId ?? '????????'` fallback duplicates a defensive default. If `msg.toolUseId` is genuinely missing, the warn-and-display combo will show 8 literal question marks — which is at least visually distinguishable from a real 8-char hex suffix. This is a reasonable choice (you want *something* to display), but it's worth noting that the same toolUseId-derivation logic appears at line 532–533 with a different fallback:
```ts
const toolUseId = (msg.toolUseId as string) || (msg.eventId as string) || "tool";
```
The two fallbacks (8x `?` vs `"tool"`) are inconsistent but acceptable for this task — they serve different visual purposes (label vs React key). Not blocking.

### Downstream impact on the `displayName` chain

Verified at lines 526–528: the existing `displayName = name === "Agent" ? … : name` logic continues to work because `name` is now `未知工具 (id:xxxxxxxx)` when rawName is empty, which will never equal `"Agent"`, so it falls through to `: name` and renders the fallback verbatim. Intentional and correct.

---

## Findings

**Critical:** 0
**Important:** 0
**Minor:** 1
- The `input: msg.input` in `console.warn` payload will land in user-facing browser DevTools console and may include tool-input contents (paths, command bodies). Spec-compliant and intentional per brief, but worth a one-line note in an ADR so a future cleanup pass doesn't strip it as PII leakage.

---

## Verdict

**Spec compliance:** ✅ Pass — every brief checkbox satisfied, commit message verbatim, scope clean.
**Code quality:** Approved — the only finding is Minor (a follow-up note, not a fix); the implementation is sound, well-commented, type-safe, and consistent with surrounding code conventions.
