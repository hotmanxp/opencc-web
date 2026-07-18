# Task 1 Review — 工具调用降级文案

## Spec compliance

**Spec ✅** — all four brief checkboxes satisfied.

Verified against the diff package (not verbatim brief):

- **Step 1 (Agent.tsx:515).** Diff replaces the single line `const name = (msg.name as string) || 'unknown'` with the exact three-line construct from the brief: `rawName` (trim + fallback to empty string), `shortId` (last 8 chars of `toolUseId`, eight `?` sentinel), then `name = rawName || \`未知工具 (id:${shortId})\``. The three-line 中文 comment about the race condition is preserved verbatim. ✅
- **Step 2 (useAgentStore.ts `if (idx === -1)` branch).** Diff inserts the guarded `console.warn` **after** the `created` literal (the `name:` field line is the last property before the closing `}` of `created`) and **before** `const updates: Partial<AgentState> = ...`. The payload `{toolUseId, sessionId: msg.sessionId, turnIndex: msg.turnIndex, ts: msg.ts, input: msg.input}` matches the brief exactly. Wrap is `if (typeof console !== 'undefined') { ... }` and trigger condition is `if (!incomingName && !(msg.name as string | undefined))`. ✅
- **Step 3 (typecheck).** Implementer report: `pnpm --filter @zn-ai/zai typecheck` → exit 0 (`tsc -b --noEmit` clean). Per review boundaries, not re-run. ✅
- **Step 4 (commit).** Single commit `c06b313` with message starting `fix(zai-web): degrade unknown tool name to readable label + diagnose warn` — exact prefix and full message from the brief. Diff stat shows only the two staged files (`Agent.tsx` +7/−1, `useAgentStore.ts` +13/0). ✅

## Code quality

**Approved.**

Findings against the code-quality rubric:

- **Comment style matches codebase.** 中文 dense narrative comments (e.g., `兜底: 模型 SSE 流里有个别时刻 toolName 没带过来(已知 race condition, ...)`) are consistent with the existing tone in `Agent.tsx` (e.g., the adjacent `// Agent 工具的 pill 不显示泛化的 "Agent"` block) and `useAgentStore.ts` (Bug A diagnostic comment style). ASCII identifiers (`rawName`, `shortId`, `created`, `updates`) — clean. ✅
- **Fallback label is genuinely useful.** `未知工具 (id:${shortId})` gives the user a concrete diagnostic handle (8-char id chunk) to grep backend logs — strictly better than bare `unknown`. The `????????` sentinel for missing `toolUseId` is also defensible (always renders something rather than crashing template literal). ✅
- **`console.warn` is guarded by `typeof console !== 'undefined'`.** Explicit defensive check present; consistent with brief and harmless in browser context. ✅
- **`tsc --noEmit` exit 0 reported.** Implementer report carries the evidence; trusted per review boundaries. ✅
- **No unrelated file edits; no new dependencies.** Diff stat shows only the two brief-listed files; no `package.json`, lockfile, or sibling-file drift. ✅

## Summary

Task 1 is a clean, minimal, well-scoped mechanical diff that precisely fulfills both the functional (降级文案) and diagnostic (`console.warn` 数据收集) halves of the spec. Single commit, exact message, no scope creep. The fallback label meaningfully upgrades the Bug A user-visible degradation, and the guarded warn gives Bug A a quantifier for race-condition occurrences. Ready for Task 2.
