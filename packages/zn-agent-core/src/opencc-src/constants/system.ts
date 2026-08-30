// Critical system constants extracted to break circular dependencies

import { getAPIProvider } from '../utils/model/providers.js'

const DEFAULT_PREFIX =
  `You are OpenCC, an coding agent and CLI.`
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX =
  `You are OpenCC, an coding agent and CLI running within the OpenCC Agent SDK.`
const AGENT_SDK_PREFIX =
  `You are OpenCC, built on the OpenCC Agent SDK.`

const CLI_SYSPROMPT_PREFIX_VALUES = [
  DEFAULT_PREFIX,
  AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX,
  AGENT_SDK_PREFIX,
] as const

export type CLISyspromptPrefix = (typeof CLI_SYSPROMPT_PREFIX_VALUES)[number]

/**
 * All possible CLI sysprompt prefix values, used by splitSysPromptPrefix
 * to identify prefix blocks by content rather than position.
 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set(
  CLI_SYSPROMPT_PREFIX_VALUES,
)

export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): CLISyspromptPrefix {
  const apiProvider = getAPIProvider()
  // @ts-ignore
  if (apiProvider === 'vertex') {
    return DEFAULT_PREFIX
  }

  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) {
      return AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX
    }
    return AGENT_SDK_PREFIX
  }
  return DEFAULT_PREFIX
}

/**
 * Anthropic attribution header (`x-anthropic-billing-header`) for API requests.
 *
 * **OpenCC never sends this header.** It was a 1P Anthropic internal billing
 * identifier (`cc_version` + `cc_entrypoint` + optional `cc_workload` + native
 * attestation placeholder) used by first-party Anthropic APIs to attribute CLI
 * traffic. OpenCC only supports three providers (anthropic / ollama /
 * openai-compatible per AGENTS.md "Provider Policy"); the openai-shim path
 * strips the header on outbound conversion anyway, and the anthropic path is
 * routed via the shim with no first-party billing hook.
 *
 * We removed the entire feature (and its `src/utils/fingerprint.ts`
 * dependency) in this fork. The upstream PR #2147 routing-aware policy
 * (`AnthropicAttributionPolicy`) is intentionally NOT ported — the fork's
 * default route is `non_official` and the policy would always resolve to
 * `{ generate: false }`, which is what the removed function returned anyway.
 *
 * Defensive `x-anthropic-billing-header` filters in the openai-shim layer
 * (and `splitSysPromptPrefix` in `src/utils/api.ts`) are KEPT — they handle
 * external system prompts (e.g. checkpoint resume, external memory) which
 * may still contain this header from upstream-generated sessions.
 */
