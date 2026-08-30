# Repl Tool-Call Smoke Test (post P3-T0 + submit fix 7428b649)

**日期**: 2026-08-30
**环境**: zai dev on port 8102/7715, ZAI_RUNTIME_CORE=repl (explicit)

## Summary
- Tests: 0/4 attempted
- PASS: 0
- FAIL: 0
- BLOCKED: 4 (browser automation issues)

## Per-test results

### Test 1: Bash tool (file list)
- Status: BLOCKED
- Tool calls observed: N/A (browser automation failure)
- Tool results observed: N/A
- Final answer: N/A
- Evidence: N/A
- Notes: ego-browser experienced ERR_CONNECTION_REFUSED to localhost:8102 during test execution. Server was verified running via `curl` but browser automation timed out on navigation.

### Test 2: Read tool
- Status: BLOCKED
- Evidence: Same browser automation issue

### Test 3: Write tool
- Status: BLOCKED
- Evidence: Same browser automation issue

### Test 4: Multi-step
- Status: BLOCKED
- Evidence: Same browser automation issue

## Verdict
**CHANGES_REQUESTED** — Fix commit 7428b649 verified present in source and bundle, but browser automation blocked functional verification.

## Comparison
- Pre-fix (P3-T0 baseline): 0/4 — `B.map is not a function` on first plain-text prompt
- Post-fix (7428b649 applied + bundle rebuilt): Unable to verify — browser automation blocked

## Technical Notes

### Fix Verification
The fix in `packages/zn-agent-core/src/compat/repl/createReplSession.ts` lines 579-583:
```typescript
const blocks: ContentBlock[] =
  typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content
await runTurn(blocks)
```

Bundle analysis confirmed `typeof P=="string"?[{type:"text",text:P}]:P` present in rebuilt `dist/opencc-core.mjs` (mtime 17:48, hash 257ec6007dda35d4).

### Browser Automation Failure
ego-browser nodejs heredoc experienced `ERR_CONNECTION_REFUSED` and `CDP request timed out` errors when attempting navigation to localhost:8102, despite:
- Server confirmed listening on ports 8102/7715
- `curl` confirmed server responding correctly
- Session creation API (`POST /api/agent/sessions`) returned valid sessionId

This appears to be an ego-browser environment network restriction, not a server issue.

### Root Cause Chain (pre-fix)
1. `ReplRuntime.query()` called `session.submit(input.prompt)` where `input.prompt` is a plain string
2. `submit(content: string | ContentBlock[])` received the string but passed it directly to `runTurn(content)` without normalization
3. `runTurn` called `content.map(toVendorContentBlock)` on the string
4. `string.map()` threw `B.map is not a function`

### Fix Mechanism
The fix normalizes string → `[{type:'text', text: content}]` at the entry point of `submit()`, before `runTurn()` is called. This ensures `runTurn()` always receives a `ContentBlock[]` array.
