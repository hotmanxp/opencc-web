# test/opencc-src/tools — vendor tool unit tests

## Why pure helpers live in leaf modules

Importing a vendor **tool** module under vitest pulls in the whole tool graph
(BashTool → `tools.ts` → `tasks.ts` → …) and currently fails to load. Three
blockers, none caused by the tests in this directory:

1. **`tools/BashTool/prompt` is a stripped dir.** `vitest.config.ts` routes
   stripped dirs to `src/compat/dangling-shims/opencc-stripped.ts`, but
   `BashTool.tsx` calls `getMaxTimeoutMs()` *inside* a zod schema description,
   so it evaluates at import time. The shim now re-exports the three timeout
   helpers by delegating to `utils/timeouts.ts` (not stripped), so the schema
   text stays truthful.
2. **`AgentTool.tsx` imported `resolveOutOfProcessTeammateProvider` twice**
   (lines 17 and 34). esbuild dedupes silently, so it never surfaced; vite's
   oxc rejects the redeclaration. Fixed by dropping the second import.
3. **`tasks.ts` uses CJS `require()`** for `MonitorMcpTask`, which vite does
   not resolve to the sibling `.ts`. Still open — it needs either a dynamic
   `import()` in `tasks.ts` or a vitest alias.

Also note: with `OPENCC_ENABLE_COMPUTER_USE=1` in the environment,
`services/mcp/client.ts` requires `utils/computerUse/toolRendering.js`, which
only exists as `.tsx`. Run these tests with `OPENCC_ENABLE_COMPUTER_USE=0`.

## Convention: test the seam, not the tool

Because of the above, a helper that must be unit-tested should live in a
**leaf module** next to the tool (e.g. `FileReadTool/constants.ts`), not inside
`FileReadTool.ts`. Leaf modules import nothing heavy, so the test can import
the real implementation and pin real behavior.

`fileReadInternalCache.test.ts` is the worked example: `writeReadFileState`
encodes the Read-vs-Write cache-shape invariant, and it is importable only
because it lives in `constants.ts`.

## Verifying a test actually catches its bug

Do not just watch it go green. Revert the fix (e.g. `git stash` the source
change), re-run, confirm the suite fails, then restore. For a full-fidelity
check, also rebuild the bundle and drive the exported tool directly:
`FileReadTool` is re-exported from `dist/opencc-core.mjs`, so an end-to-end
repro can run against the same artifact production loads.
