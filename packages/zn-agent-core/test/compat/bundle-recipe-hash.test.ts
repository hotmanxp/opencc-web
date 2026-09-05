import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * Test the bundle-recipe hash algorithm used by
 * scripts/bundle-opencc.ts → inputHash() (zai patch tf-jqy5q2bi).
 *
 * Before this patch, inputHash() baked in the literal
 * `h.update('recipe:v6\n')` and required manual version bumps
 * whenever a patch regex changed. The fix replaces that with
 * `h.update(JSON.stringify(getRecipe()))` over a structured
 * RecipeEntry[] whose values are the actual regex sources /
 * sentinel strings / plugin names declared in the build script.
 *
 * This test pins the algorithm contract:
 *   1. Two RecipeEntry[] with different patch entries must produce
 *      different digests (the whole point of the change — patch
 *      edits invalidate the stamp).
 *   2. The same RecipeEntry[] hashed twice produces the same
 *      digest (deterministic — no spurious rebuilds).
 *
 * The algorithm is reproduced locally rather than imported from
 * scripts/bundle-opencc.ts because that file is a top-level
 * Node script, not a module (it uses `await` at top level and
 * reads `process.exit(0)` on the cache-hit path). If a future
 * refactor moves the recipe logic into an importable module,
 * update this test to import the real `hashRecipe` / `getRecipe`
 * rather than re-deriving it here.
 */
type RecipeEntry =
  | { kind: 'regex'; name: string; source: string; flags: string }
  | { kind: 'string'; name: string; value: string }

function hashRecipe(recipe: ReadonlyArray<RecipeEntry>): string {
  const h = createHash('sha1')
  h.update(JSON.stringify(recipe))
  h.update('\n')
  return h.digest('hex').slice(0, 16)
}

const RECIPE_A: ReadonlyArray<RecipeEntry> = [
  { kind: 'regex', name: 'configCheckPatchRe', source: /^let configReadingAllowed = false$/m.source, flags: 'm' },
  { kind: 'regex', name: 'vendorReturnPatchRe', source: /^  return\n  delete processEnv\.CLAUDE_CODE_USE_OPENAI/m.source, flags: 'm' },
  { kind: 'string', name: 'plugin:vendor-patches', value: 'vendor-patches' },
  { kind: 'string', name: 'plugin:preact-alias', value: 'preact-alias' },
]

// RECIPE_B differs from A in two ways:
//   - adds a new patch regex (mirrors a real recipe edit adding
//     `queryEngineNonInteractivePatchRe`);
//   - changes the source of `vendorReturnPatchRe` (mirrors editing
//     an existing regex's pattern).
// Both edits should flip the hash.
const RECIPE_B: ReadonlyArray<RecipeEntry> = [
  { kind: 'regex', name: 'configCheckPatchRe', source: /^let configReadingAllowed = false$/m.source, flags: 'm' },
  { kind: 'regex', name: 'vendorReturnPatchRe', source: /^  return;\n  delete processEnv\.CLAUDE_CODE_USE_OPENAI/m.source, flags: 'm' },
  { kind: 'regex', name: 'queryEngineNonInteractivePatchRe', source: /isNonInteractiveSession: true,/g.source, flags: 'g' },
  { kind: 'string', name: 'plugin:vendor-patches', value: 'vendor-patches' },
  { kind: 'string', name: 'plugin:preact-alias', value: 'preact-alias' },
]

describe('bundle-recipe hash (bundle-opencc inputHash)', () => {
  it('case 1: different recipe entries produce different hashes', () => {
    const hashA = hashRecipe(RECIPE_A)
    const hashB = hashRecipe(RECIPE_B)
    expect(hashA).not.toBe(hashB)
    // Also sanity-check that the hashes look like 16-hex-char digests
    // (matches the slice length in inputHash()).
    expect(hashA).toMatch(/^[0-9a-f]{16}$/)
    expect(hashB).toMatch(/^[0-9a-f]{16}$/)
  })

  it('case 2: same recipe hashed twice produces the same hash', () => {
    const h1 = hashRecipe(RECIPE_A)
    const h2 = hashRecipe(RECIPE_A)
    expect(h1).toBe(h2)
  })

  it('order-preserving: entry order changes the hash (JSON.stringify is order-sensitive)', () => {
    // Reversing the entry order should flip the hash — this is the
    // property we rely on: appending a new regex at the end of the
    // RECIPE array is enough to invalidate the stamp, no manual
    // version bump required.
    const reversed = [...RECIPE_A].reverse()
    expect(hashRecipe(RECIPE_A)).not.toBe(hashRecipe(reversed))
  })

  it('only-flag change is detectable (proves flags are part of the digest)', () => {
    const base: RecipeEntry = { kind: 'regex', name: 'sameName', source: 'sameSource', flags: 'g' }
    const withDifferentFlag: RecipeEntry = { kind: 'regex', name: 'sameName', source: 'sameSource', flags: 'gm' }
    expect(hashRecipe([base])).not.toBe(hashRecipe([withDifferentFlag]))
  })
})
