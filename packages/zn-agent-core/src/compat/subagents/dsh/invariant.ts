/**
 * dsh provider invariants & failure helpers. Mirrors the claude-code /
 * codex `invariant.ts` layout.
 */

/** Throw-shaped startup failure with the provider's stable prefix. */
export function failDsh(reason: string, hint?: string): Error {
  return new Error(
    `subagent-dsh: ${reason}${hint ? ` (hint: ${hint})` : ''}`,
  )
}

/**
 * Safe diagnostic line aligned with dsh's
 * `failureDiagnostic` template (`subagent-dsh-sdk/src/run.ts:101-108`):
 * fixed facts only — never tool inputs, file contents, or credentials.
 */
export function dshFailureDiagnostic(
  stage: string,
  category: string,
): string {
  return `Subagent failure (provider: DSH SDK; stage: ${stage}; category: ${category})`
}
