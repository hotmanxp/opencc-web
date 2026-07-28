// Top-level await user workflow fixture.
// Mirrors the pattern used by .claude/workflows/*.js which do
// `const x = await someAsyncFn()` at top level (no `userScript`
// wrapper). This test pins the contract that a script's top-level
// awaited value reaches `result.report`.
//
// NOTE: This test is GREEN (not RED) after Plan5 VM migration because
// vmContext.ts already wraps source in `(async () => {...})()` before
// runInContext. The top-level `await` is legal inside that async IIFE.
// This test serves as a regression guard: it must not break if the
// wrapping is ever removed or refactored. See Plan6 Task3.
//
// Plan6: commit 57887ab7 removed the legacy export-stripper.

const result = await new Promise((resolve) => resolve('tla-success'))
return result
