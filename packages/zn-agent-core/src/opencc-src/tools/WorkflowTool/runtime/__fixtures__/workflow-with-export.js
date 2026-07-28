// ESM-syntax user workflow fixture.
// Mirrors the pattern used by .claude/workflows/sync-verify.js,
// completion-smoke.js, opencc-bug-hunt.js, opencc-verfiy-fix.js
// (4 of 6 user workflows that broke after the Plan5 VM migration).
//
// The current vmRunner does not strip the `export` keyword, so
// this file fails with `SyntaxError: Unexpected token 'export'`
// at the moment. Once Task2 adds stripEsmExports, the test that
// loads this fixture should pass.

export const meta = {
  name: 'test-workflow',
  description: 'Fixture for ESM export const meta regression test',
  phases: [{ title: 'Test' }],
}

phase('Test')
const r = await agent('test prompt', {})
return { ok: true, summary: 'export meta test' }
