import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installMacroStub } from '../../../src/compat/openccInit.js'

// Vendor bundle load (loadAgentDefinitions → reads disk caches) can push
// a single first-run past vitest's default 5s timeout. Bump to 30s.
const TIMEOUT = 30_000

// IMPORTANT: this test asserts the runtime behavior zai depends on — that
// the AgentTool description rendered for the LLM lists the actual sub-agents
// (Explore, Plan, general-purpose, plus user-defined ones), NOT a deferred
// "see <system-reminder> messages" pointer that has no matching message in
// the conversation.
//
// In normal opencc flow, the agent list is rendered in two places: the
// tool description (when `shouldInjectAgentListInMessages()===false`) and
// an `agent_listing_delta` attachment message (when true, the default).
// zai's compat layer pre-loads `params.messages` and passes them to
// `openccQuery()` — but opencc's main loop only emits the
// `agent_listing_delta` attachment MID-TURN (query.ts:~2655), so the
// FIRST callModel never sees it. Result: the LLM sees "see
// <system-reminder>" but no system-reminder exists.
//
// zai patches this in `installMacroStub()` (compat/openccInit.ts) by
// setting `CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=false` before the bundle
// is imported, so `shouldInjectAgentListInMessages()` returns false and
// the description embeds the inline list. This test guards that contract
// by exercising the same env-var setup the production runtime uses.

describe('AgentTool description rendering — zai compat inline agent list', () => {
  let AgentTool: any
  let getAgentDefinitionsWithOverrides: any
  let originalEnv: string | undefined
  let originalConfigDir: string | undefined
  let fixtureConfigDir: string | undefined

  beforeAll(async () => {
    // Mirror the production startup: installMacroStub() runs before the
    // bundle is imported, so the env-var override is in place when
    // AgentTool.prompt() reads shouldInjectAgentListInMessages() at call
    // time. Pinning the env var explicitly here makes the test resilient
    // to shell environments where the var is already set differently.
    originalEnv = process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    // Force inline agent list. vendor's `shouldInjectAgentListInMessages()`
    // (opencc-src/tools/AgentTool/prompt.ts:59-64) treats an unset env var
    // as "fall through to the cached GrowthBook feature value", whose
    // default is `true` for `tengu_agent_list_attach` — that puts the
    // agent list in an `agent_listing_delta` attachment that zai's
    // pre-loaded `params.messages` never see. Pin the env var to "false"
    // so the description renders the inline list (the contract zai
    // relies on — see the comment block at the top of this file).
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'

    // Stand up a private config-dir tree with at least one userSettings
    // agent so the assertion below ("at least one custom agent") is
    // satisfied regardless of the host environment. zai patches
    // `getClaudeConfigHomeDir` to read from `OPENCC_CONFIG_DIR` (default
    // `~/.zai`); without an override the bundle would scan the dev
    // machine's home for `~/.zai/agents/` and return zero userSettings
    // agents — making the test order-/env-dependent. Pointing at a
    // fixture directory makes the test self-contained and reproducible
    // on CI.
    originalConfigDir = process.env.OPENCC_CONFIG_DIR
    fixtureConfigDir = mkdtempSync(join(tmpdir(), 'zn-agent-core-test-'))
    const fixtureAgentsDir = join(fixtureConfigDir, 'agents')
    mkdirSync(fixtureAgentsDir, { recursive: true })
    writeFileSync(
      join(fixtureAgentsDir, 'test-custom-agent.md'),
      [
        '---',
        'name: test-custom-agent',
        'description: A fixture agent used by agent-listing-inline.test.ts.',
        'tools: [Read, Edit]',
        '---',
        '',
        'You are a fixture sub-agent used by the unit test. You should respond',
        'concisely and not make any tool calls outside of what the test exercises.',
        '',
      ].join('\n'),
    )
    process.env.OPENCC_CONFIG_DIR = fixtureConfigDir

    installMacroStub()
    const bundle = await import('@zn-ai/zn-agent-core/opencc-core')
    AgentTool = bundle.AgentTool
    getAgentDefinitionsWithOverrides = bundle.getAgentDefinitionsWithOverrides
  }, TIMEOUT)

  afterAll(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    } else {
      process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = originalEnv
    }
    if (originalConfigDir === undefined) {
      delete process.env.OPENCC_CONFIG_DIR
    } else {
      process.env.OPENCC_CONFIG_DIR = originalConfigDir
    }
    if (fixtureConfigDir) {
      rmSync(fixtureConfigDir, { recursive: true, force: true })
    }
  })

  it(
    'AgentTool.prompt({agents}) renders the inline agent list, not a deferred system-reminder pointer',
    { timeout: TIMEOUT },
    async () => {
      const agents = (await getAgentDefinitionsWithOverrides(process.cwd()))
        .activeAgents
      // Sanity: there should be at least Explore + general-purpose + a few
      // user-defined agents in this dev environment.
      const types = agents.map((a: any) => a.agentType)
      expect(types).toContain('Explore')
      expect(types).toContain('general-purpose')
      // User-defined agents from ~/.zai/agents should also surface.
      // (Don't pin a specific name — just confirm at least one custom agent.)
      const hasCustom = agents.some((a: any) => a.source !== 'built-in')
      expect(hasCustom).toBe(true)

      const rendered: string = await AgentTool.prompt({
        agents,
        tools: [AgentTool],
        getToolPermissionContext: async () => ({
          mode: 'bypassPermissions',
          alwaysAllowRules: { session: [] },
          alwaysDenyRules: { session: [] },
          alwaysAskRules: { session: [] },
          isBypassPermissionsModeAvailable: true,
          shouldAvoidPermissionPrompts: true,
          additionalWorkingDirectories: new Map(),
        }),
        allowedAgentTypes: undefined,
      })

      // The contract zai relies on: the description must list Explore and
      // general-purpose inline, and must NOT defer to a non-existent
      // system-reminder.
      expect(rendered).toContain('Explore')
      expect(rendered).toContain('general-purpose')
      expect(rendered).not.toContain(
        'Available agent types are listed in <system-reminder>',
      )
    },
  )
})
