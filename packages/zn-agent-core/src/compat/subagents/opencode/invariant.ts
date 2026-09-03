/**
 * opencode provider invariants & failure helpers. Mirrors the claude-code /
 * dsh `invariant.ts` layout.
 *
 * Unlike Codex, the opencode CLI is a self-contained binary on PATH (a fresh
 * `opencode run` process per delegation) — there is no separate app-server
 * handshake to pin, so this file only carries the stable-prefix throw helper
 * used across the provider.
 */

/** Throw-shaped startup failure with the provider's stable prefix. */
export function failOpencode(reason: string, hint?: string): Error {
  return new Error(
    `subagent-opencode: ${reason}${hint ? ` (hint: ${hint})` : ''}`,
  )
}

/**
 * Safe diagnostic line aligned with the claude-code / dsh template: fixed
 * facts only — never tool inputs, file contents, or credentials.
 */
export function opencodeFailureDiagnostic(
  stage: string,
  category: string,
): string {
  return `Subagent failure (provider: opencode; stage: ${stage}; category: ${category})`
}
