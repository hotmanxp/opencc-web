# Task 6 Report

## Status
DONE_WITH_CONCERNS

## Commits
```
9aa9082 test(zai-web): cover TodoDropdown empty / progress / V2 / blocked-by / deleted
```
(`git log --oneline af827fb..HEAD`)

## Verification

`pnpm --filter @zn-ai/zai test --run TodoDropdown` output (last lines):

```
 ✓ src/web/src/components/TodoDropdown.test.tsx (5 tests) 16ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  299ms
```

All 5 brief test cases pass:
1. ✅ Empty todos + empty v2 → renders "暂无任务或 TODO" empty state
2. ✅ Non-empty (todos only) → renders "1/3 完成" + "1 进行中" + 3 data-testids (`todo-dropdown-item-completed/in_progress/pending`)
3. ✅ Both todos + v2 → renders both sections (老 todo + V2 任务 A/B + "V2 任务清单" header)
4. ✅ v2 task with blockedBy → shows "依赖 2"
5. ✅ v2 task with status='deleted' → renders "deleted one" via `v2-task-dropdown-item-deleted`

## Concerns

1. **Added `import "@testing-library/jest-dom"`** (between brief's vitest and TodoDropdown imports). The brief's `toHaveTextContent` / `toBeInTheDocument` assertions require `@testing-library/jest-dom` matchers. The vitest config (`packages/zai/vitest.config.ts`) does NOT auto-load jest-dom globally. Established precedent: `packages/zai/test/web/TodoZone.test.tsx:2` adds the same import for the same matchers. The Task 2 reviewer (`git log` shows `e2c8029`) explicitly approved this pattern.

2. **`pnpm --filter @zn-ai/zai test -- TodoDropdown`** in the brief's literal form silently passes `--` to the script (running the full suite, which has pre-existing failures in `ModelStatusButton.test.tsx` and `useAgentStore.test.ts` — unrelated to this task). Using `pnpm --filter @zn-ai/zai test --run TodoDropdown` correctly forwards the filter to `vitest run`. Verification command in the report uses this corrected form. Pre-existing failures in the broader suite were not introduced or affected by this task.

No other deviations from the brief.
