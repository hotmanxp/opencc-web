import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { StatusNoticeContext } from './statusNoticeDefinitions.js'
import {
  getActiveNotices,
} from './statusNoticeDefinitions.js'

// Regression coverage for issue #244 — the two safety-related status notices
// that warn 3P users when they are running without the AI classifier or with
// `--dangerously-skip-permissions` outside a sandbox.
//
// As of commit 352afa86 (fix(local-dev): silence malware reminder + permissive
// mode notices), BOTH notices have been intentionally removed from the active
// `statusNoticeDefinitions` array. The "fires when X" cases below now assert
// the notices do NOT fire (silenced), and the "suppressed" cases verify the
// default-off path is still well-defined. See AGENTS.md "Silenced Tests".

// Empty baseline context (no large-memory/agent-description triggers).
function buildContext(
  overrides?: Partial<StatusNoticeContext>,
): StatusNoticeContext {
  return {
    config: {} as StatusNoticeContext['config'],
    memoryFiles: [],
    ...overrides,
  }
}

function activeIds(ctx: StatusNoticeContext): string[] {
  return getActiveNotices(ctx).map(n => n.id)
}

const SAVED_ARGV = process.argv
const SAVED_API_KEY = process.env.ANTHROPIC_API_KEY
const SAVED_SHOW_SAFETY = process.env.OPENCC_SHOW_SAFETY_NOTICES

beforeEach(() => {
  // Reset argv each test so the dangerously-skip-permissions detector starts
  // from a known baseline.
  process.argv = [...SAVED_ARGV.filter(a => a !== '--dangerously-skip-permissions')]
  // Other status notices read auth state via getAnthropicApiKeyWithSource,
  // which throws when no key/token is present. Seed a dummy so getActiveNotices
  // can iterate every notice without unrelated failures crashing the test.
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-test-dummy'
  // Safety notices (3P permissive mode + --dangerously-skip-permissions) are
  // suppressed by default in dev. Re-enable them for this suite so the
  // regression coverage in #244 still runs against the live isActive logic.
  process.env.OPENCC_SHOW_SAFETY_NOTICES = '1'
})

afterEach(() => {
  process.argv = SAVED_ARGV
  if (SAVED_API_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = SAVED_API_KEY
  }
  if (SAVED_SHOW_SAFETY === undefined) {
    delete process.env.OPENCC_SHOW_SAFETY_NOTICES
  } else {
    process.env.OPENCC_SHOW_SAFETY_NOTICES = SAVED_SHOW_SAFETY
  }
  mock.restore()
})

describe('third-party permissive mode notice (#244 finding 1)', () => {
  // Silenced per 352afa86 — notice no longer registered in statusNoticeDefinitions.
  test('does not fire when 3P + acceptEdits + classifier-off model (silenced per 352afa86)', async () => {
    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'openai',
    }))
    mock.module('./betas.js', () => ({
      modelSupportsAutoMode: () => false,
    }))
    const { getActiveNotices: freshGetActiveNotices } = await import(
      `./statusNoticeDefinitions.js?ts=${Date.now()}`
    )
    const ctx = buildContext({ permissionMode: 'acceptEdits', mainLoopModel: 'gpt-5.4' })
    const ids = freshGetActiveNotices(ctx).map((n: { id: string }) => n.id)
    expect(ids).not.toContain('third-party-permissive-mode')
  })

  // Silenced per 352afa86 — notice no longer registered in statusNoticeDefinitions.
  test('does not fire when 3P + bypassPermissions (silenced per 352afa86)', async () => {
    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'openai',
    }))
    mock.module('./betas.js', () => ({
      modelSupportsAutoMode: () => false,
    }))
    const { getActiveNotices: freshGetActiveNotices } = await import(
      `./statusNoticeDefinitions.js?ts=${Date.now()}`
    )
    const ctx = buildContext({ permissionMode: 'bypassPermissions', mainLoopModel: 'llama3.1' })
    const ids = freshGetActiveNotices(ctx).map((n: { id: string }) => n.id)
    expect(ids).not.toContain('third-party-permissive-mode')
  })

  test('suppressed in default mode even on 3P', async () => {
    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'openai',
    }))
    mock.module('./betas.js', () => ({
      modelSupportsAutoMode: () => false,
    }))
    const { getActiveNotices: freshGetActiveNotices } = await import(
      `./statusNoticeDefinitions.js?ts=${Date.now()}`
    )
    const ctx = buildContext({ permissionMode: 'default', mainLoopModel: 'gpt-5.4' })
    const ids = freshGetActiveNotices(ctx).map((n: { id: string }) => n.id)
    expect(ids).not.toContain('third-party-permissive-mode')
  })

  test('suppressed on firstParty Anthropic in acceptEdits', async () => {
    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'firstParty',
    }))
    mock.module('./betas.js', () => ({
      modelSupportsAutoMode: () => true,
    }))
    const { getActiveNotices: freshGetActiveNotices } = await import(
      `./statusNoticeDefinitions.js?ts=${Date.now()}`
    )
    const ctx = buildContext({ permissionMode: 'acceptEdits', mainLoopModel: 'claude-opus-4-7' })
    const ids = freshGetActiveNotices(ctx).map((n: { id: string }) => n.id)
    expect(ids).not.toContain('third-party-permissive-mode')
  })

  test('suppressed when classifier supports the model (defensive)', async () => {
    mock.module('./model/providers.js', () => ({
      getAPIProvider: () => 'openai',
    }))
    mock.module('./betas.js', () => ({
      modelSupportsAutoMode: () => true,
    }))
    const { getActiveNotices: freshGetActiveNotices } = await import(
      `./statusNoticeDefinitions.js?ts=${Date.now()}`
    )
    const ctx = buildContext({ permissionMode: 'acceptEdits', mainLoopModel: 'mystery-model' })
    const ids = freshGetActiveNotices(ctx).map((n: { id: string }) => n.id)
    expect(ids).not.toContain('third-party-permissive-mode')
  })
})

describe('dangerously-skip-permissions sandbox notice (#244 finding 2)', () => {
  // Silenced per 352afa86 — notice no longer registered in statusNoticeDefinitions.
  test('does not fire when --dangerously-skip-permissions is in argv (silenced per 352afa86)', () => {
    process.argv = [...process.argv, '--dangerously-skip-permissions']
    expect(activeIds(buildContext())).not.toContain('dangerously-skip-permissions-no-sandbox')
  })

  // Silenced per 352afa86 — notice no longer registered in statusNoticeDefinitions.
  test('does not fire when permission mode is bypassPermissions (silenced per 352afa86)', () => {
    expect(activeIds(buildContext({ permissionMode: 'bypassPermissions' }))).not.toContain(
      'dangerously-skip-permissions-no-sandbox',
    )
  })

  test('does not fire in default mode without the flag', () => {
    expect(activeIds(buildContext({ permissionMode: 'default' }))).not.toContain(
      'dangerously-skip-permissions-no-sandbox',
    )
  })
})

// Removed per 352afa86 — the third-party-permissive-mode and
// dangerously-skip-permissions-no-sandbox notices are no longer in the active
// statusNoticeDefinitions array, so renderNoticePlainText (which looks them up
// via statusNoticeDefinitions.find) can no longer exercise their visual layout.
// If these notices are re-enabled in a future commit, restore the
// `separates warning icons from the notice text` assertions from git history.
describe('safety notice rendering', () => {
  test.skip('separates warning icons from the notice text (placeholder — see 352afa86)', () => {
    // intentionally empty: rendering assertions removed when notices were silenced
  })
})
