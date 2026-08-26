import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getChildEnv, STRIPPED_ENV_VARS } from '../../../src/compat/subprocess/env.js'

/**
 * Tests for the env scrub seam. The strip list is shared with the zai
 * server's Bash tool (utils/subprocessEnv.ts) and adds the OpenAI family;
 * both should grow in lockstep when either side needs a new credential.
 */

describe('subprocess/env.getChildEnv', () => {
  const SAVED_OPENAI_KEY = process.env.OPENAI_API_KEY
  const SAVED_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
  const SAVED_PATH = process.env.PATH
  const SAVED_TMPDIR = process.env.TMPDIR

  beforeEach(() => {
    // Seed ambient secrets. `.env` files or shell exports may have set
    // these already, but we cannot assume that in CI; explicitly assign so
    // the assertions below don't depend on the runner's environment.
    process.env.OPENAI_API_KEY = 'sk-openai-from-parent'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-parent'
    process.env.TMPDIR = '/var/tmp/parent'
  })

  afterEach(() => {
    // Restore the ambient values to keep other tests in the suite independent
    // — vitest runs files in parallel / with shared module state.
    if (SAVED_OPENAI_KEY === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = SAVED_OPENAI_KEY
    if (SAVED_ANTHROPIC_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = SAVED_ANTHROPIC_KEY
    if (SAVED_PATH === undefined) delete process.env.PATH
    else process.env.PATH = SAVED_PATH
    if (SAVED_TMPDIR === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = SAVED_TMPDIR
  })

  it('strips every credential-shaped ambient var before overlay', () => {
    const env = getChildEnv()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    // Non-sensitive passthrough (PATH / TMPDIR) MUST survive unfiltered —
    // stripping these breaks the OS-level program lookup in the child.
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.TMPDIR).toBe('/var/tmp/parent')
  })

  it('lets a caller-supplied overlay re-introduce a credential (intended path)', () => {
    // This is the deployment's intended path: ambient may or may not carry
    // `OPENAI_API_KEY`, and the codex provider configuration overlays it
    // explicitly. The seam must not strip the *overlay* just because the
    // *ambient* form was on the strip list.
    const env = getChildEnv({ OPENAI_API_KEY: 'sk-from-config', CODEX_HOME: '/srv/codex' })
    expect(env.OPENAI_API_KEY).toBe('sk-from-config')
    expect(env.CODEX_HOME).toBe('/srv/codex')
  })

  it('returns a fresh object every call — caller mutations cannot leak back to the parent', () => {
    const env1 = getChildEnv({ X: 'a' })
    const env2 = getChildEnv({ X: 'a' })
    expect(env1).not.toBe(env2)
    env1.PATH = '/mutated'
    expect(env2.PATH).not.toBe('/mutated')
  })

  it('treats "remove from overlay" by leaving the ambient stripped value absent', () => {
    // Overlay is additive; you cannot un-strip via this API. The contract is
    // "ambient secret-shaped vars never reach the child", and that
    // guarantee survives no matter what the overlay passes.
    const env = getChildEnv({ SOME_OTHER: 'value' })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.SOME_OTHER).toBe('value')
  })
})

describe('subprocess/env.STRIPPED_ENV_VARS', () => {
  it('is a non-empty Set exported for observability / ops dashboards', () => {
    expect(STRIPPED_ENV_VARS.size).toBeGreaterThan(0)
  })

  it('contains the credentials this codebase already considers sensitive (sample)', () => {
    // Sample, not exhaustive — keeps the test from breaking the moment the
    // strip list grows. The codebase's `utils/subprocessEnv.ts` already
    // audits this surface; this is the minimum the OS family care about.
    expect(STRIPPED_ENV_VARS.has('OPENAI_API_KEY')).toBe(true)
    expect(STRIPPED_ENV_VARS.has('AZURE_OPENAI_API_KEY')).toBe(true)
    expect(STRIPPED_ENV_VARS.has('AWS_SECRET_ACCESS_KEY')).toBe(true)
    expect(STRIPPED_ENV_VARS.has('ANTHROPIC_API_KEY')).toBe(true)
    // Sanity: PATH must NOT be on the strip list.
    expect(STRIPPED_ENV_VARS.has('PATH')).toBe(false)
  })
})
