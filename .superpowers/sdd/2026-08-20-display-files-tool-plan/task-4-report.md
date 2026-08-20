# Task 4 Report: displayFiles 工具实现 (zn-agent-core TDD)

## Status: DONE_WITH_CONCERNS

## RED

Command:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zn-agent-core test test/unit/tools/displayFiles.test.ts
```

Output (relevant):
```
FAIL  test/unit/tools/displayFiles.test.ts [ test/unit/tools/displayFiles.test.ts ]
Error: Failed to load url ../../../src/compat/tools/displayFiles.js (resolved id:
../../../src/compat/tools/displayFiles.js) in .../displayFiles.test.ts.
Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
```

Why expected: The test imports `displayFilesTool` from `../../../src/compat/tools/displayFiles.js`, which does not exist yet. Vitest fails to resolve the module — confirmed RED.

## GREEN

Command:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zn-agent-core test test/unit/tools/displayFiles.test.ts
```

Output (relevant):
```
 ✓ test/unit/tools/displayFiles.test.ts (6 tests) 7ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

Regression sweep — `pnpm --filter @zn-ai/zn-agent-core test test/unit/tools/` — also clean:
```
Test Files  12 passed (12)
Tests       54 passed (54)
```

Note: the full `test/unit/` directory contains ~52 test files. One pre-existing failure exists in `test/unit/server/openccRuntime-query.test.ts` (sourcemap warning + assertion in `__zaiBridgeCtx` injection) that is unrelated to `displayFilesTool` and verified pre-existing in both base commit `84a65a45` and `main`.

`pnpm --filter @zn-ai/zn-agent-core exec tsc --noEmit -p tsconfig.json` — no errors.

## Files Changed

- Created `packages/zn-agent-core/src/compat/tools/displayFiles.ts` (146 lines)
- Created `packages/zn-agent-core/test/unit/tools/displayFiles.test.ts` (73 lines)

Commit: `ddcb3423 feat(zn-agent-core): add displayFilesTool with stat + kind classification`

## The exact `makeTool` wrap shape discovered

`packages/zn-agent-core/src/compat/tools/makeTool.ts` (verbatim, line-by-line):

1. Spec field is `executor: (args: T, ctx: ToolCallCtx) => Promise<{ output: string }>` — NOT `call`.
2. `makeTool` returns a `ToolWithCall` object whose `async call(args, ctx)`:
   - parses args via `spec.inputSchema.safeParse(args)`; on failure returns `{ output: '[error] invalid input for <name>: <issues>' }`;
   - on success, returns the executor's value **unchanged**.
3. Therefore `displayFilesTool.call(args, ctx)` returns `{ output: string }` — NOT the executor's `{ content: [...] }` shape directly.

The brief's stated intent — "the executor returns `{ content: [{ type: 'json', json: { files: FileMeta[] } }] }`" — is realized by having the **executor** JSON-stringify that Anthropic-style content block into `output`. The test then does `JSON.parse(result.output).content[0].json.files`. This preserves the brief's documented payload structure on the wire while matching `makeTool`'s real `{ output: string }` contract.

`makeTool` source (verbatim):
```ts
type ToolWithCall = Tool & {
  call: (args: unknown, ctx: unknown) => Promise<{ output: string }>
}

export function makeTool<T>(spec: {
  name: string
  description: string
  inputSchema: z.ZodType<T>
  executor: (args: T, ctx: ToolCallCtx) => Promise<{ output: string }>
}): ToolWithCall {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    async call(args: unknown, ctx: unknown) {
      const parsed = spec.inputSchema.safeParse(args)
      if (!parsed.success) {
        return {
          output: `[error] invalid input for ${spec.name}: ${parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        }
      }
      const ctxObj = (ctx ?? { cwd: process.cwd() }) as ToolCallCtx
      if (!ctxObj.cwd) ctxObj.cwd = process.cwd()
      return spec.executor(parsed.data, ctxObj)
    },
  }
}
```

## Deviations from the brief

1. **Test assertions use `JSON.parse(result.output).content[0].json` instead of `JSON.parse(result.content[0].text)`.** Brief's test assumed `makeTool` wraps executor output into Anthropic-style `{ content: [{ type: 'text', text }] }`. The real `makeTool` returns `{ output: string }`. Adapted per the brief's own guidance: "If `makeTool` returns the executor's value unchanged ... adjust the test assertions and the executor's return value accordingly." Executor returns `{ output: JSON.stringify({ content: [{ type: 'json', json: { files } }] }) }` so the test parses the same Anthropic content block shape — just via `result.output` not `result.content[0].text`.

2. **Executor field name is `executor` not `call`.** `makeTool` accepts `executor` in its spec, not `call`. The brief's Step 3 snippet used `async call({ paths })` — corrected to `async executor({ paths })`. (Other tools in `compat/tools/index.ts:432-489` all use `executor` consistently.)

3. **`size` assertion corrected from 11 → 12 bytes.** Brief wrote `expect(json.files[0].size).toBe(11)` for content `'const x = 1\n'`. Actual byte count is 12 (`c,o,n,s,t, ,x, ,=, ,1,\n`). Confirmed via `node -e "console.log(Buffer.byteLength('const x = 1\n'))"`. Updated the test with an inline comment explaining the byte count.

4. **Test uses 2-space indentation instead of brief's 2-space (matches brief).** No change.

5. **SET literals (`TEXT_EXTS`, `HTML_EXTS`, `IMAGE_EXTS`) copied verbatim from `packages/zai/src/shared/fileKind.ts:9-33`** per the cross-package duplication guard. Diff verified byte-identical apart from the leading `export const` / `export type` qualifiers and the `ReadonlySet<string>` type annotation that doesn't exist in the new (internal) file.

## Self-review

- Test coverage: 6 cases — happy path (text + image mix), html classification, unknown ext → binary, ENOENT for missing path, EISDIR for directory, mixed valid/invalid paths. Covers all branches in `statOneFile` (success, isDirectory, catch) plus all 4 kind classifiers (text, image, html, binary).
- `normalizeErrno` default-branch (`return 'EPERM'`) is unreachable from the brief's test set — all errors raised by Node's `fs/promises` `stat()` for missing files / directories are `ENOENT` / `EISDIR`. Acceptable since the type is still a `FileErrorCode`; tested indirectly through normal paths.
- `displayFilesTool` registered as a module-level constant — no side effects, no `ctx.skills` / `ctx.askRegistry` interaction. Safe under vitest's default isolated environment.
- Test cleanup: `mkdtemp` creates directories under `os.tmpdir()` that aren't explicitly removed. Acceptable for a single-process vitest run on a developer machine (OS reaps on reboot); matches existing tests in `packages/zai/test/...` patterns.
- The executor `JSON.stringify(...)` payload round-trips cleanly — verified by passing tests.
- `IMAGE_EXTS` is unused at runtime for kind classification — only checked via `ext in IMAGE_EXTS` which still works (JS `in` operator on a Record). The MIME map is included for forward compatibility with the `/fs/preview` route (Task 2/3) but isn't required by this task's scope.
- No build:core run (per task instructions — Task 10 owns it).

## Concerns

1. **Brief test's `JSON.parse(result.content[0].text)` is structurally wrong.** It would only match a wrapper that emits Anthropic-style content blocks at the top level. Either the brief was written against a different (vendor) `makeTool` impl, or it assumed `makeTool` would JSON-stringify the executor's content into a top-level `text` field. The chosen fix preserves the documented intent (Anthropic content block shape on the wire) while matching the real `makeTool`. Worth flagging to whoever drafted the brief so future tasks don't repeat the assumption.

2. **`size` byte-count discrepancy** in the brief (11 vs actual 12) suggests the brief's test data was hand-counted without verification. Anyone re-running the brief verbatim would hit this. Filed here for awareness.

3. **`displayFilesTool` is created but not registered** in `buildDefaultTools()` (`compat/tools/index.ts:491-519`). This is intentional per the plan — registration happens in a later task (presumably the zai-side integration task). The tool is exported but not surfaced to the model yet. Anyone running `buildDefaultTools()` will not see `DisplayFiles` until that follow-up lands.

4. **`executor` vs `call` spec field name** in `makeTool` — brief used `call`, real API uses `executor`. If a future brief confuses this again, the symptom is a TypeScript error: `Property 'call' does not exist on type ...` — easy to catch at compile time but worth noting in plan docs.

## Fix Round 1 (2026-08-20)

### Changes
- Added 2 paths length validation tests to `test/unit/tools/displayFiles.test.ts` per spec §9.1 line 314:
  - `rejects empty paths array` — verifies `min(1)` guard emits `'paths 不能为空'`
  - `rejects more than 20 paths` — verifies `max(20)` guard emits `'单次最多 20 个文件'`
- Corrected the "Regression sweep" scope in this report: the 12/54 figure comes from `test/unit/tools/` only, not the full `test/unit/` directory (~52 files). The pre-existing `test/unit/server/openccRuntime-query.test.ts` failure is unrelated to `displayFilesTool` and is noted above.

### Verification
```
pnpm --filter @zn-ai/zn-agent-core test test/unit/tools/displayFiles.test.ts
→ 8 tests passing (was 6)
