import type { Command } from '../types/command.js';
import type { PromptHook } from '../schemas/hooks.js';

/**
 * Fallback shape — use if PromptHook doesn't exist in src/hooks/config.js
 * @see src/schemas/hooks.ts:218 for the real PromptHook definition
 */

/**
 * Upstream v2.1.201 hook event name. OpenCC does not currently register this
 * event in its hook system; this constant is reserved for a future port that
 * adds UserPromptExpansion as a registered hook event type. See
 * docs/superpowers/specs/2026-07-04-stacked-skill-loading-design.md §4.3.
 */
export const USER_PROMPT_EXPANSION_HOOK_EVENT = 'UserPromptExpansion';

export interface UserPromptExpansionHookContext {
  command: Command;
  args: string;
}

export type UserPromptExpansionHookResult =
  | { blocked: true; reason: string }
  | { expanded: PromptHook[] }
  | undefined;

/**
 * RESERVED integration point for the upstream UserPromptExpansion hook event.
 *
 * Currently OpenCC has no UserPromptExpansion hook event registered, so this
 * stub always returns `undefined` (allow). When OpenCC adds
 * UserPromptExpansion as a hook event type (in settings.json),
 * this function will:
 *   1. Read hook chain from appSettings.
 *   2. Execute each configured hook over `ctx.command` / `ctx.args`.
 *   3. Return `{blocked: true}` if any hook vetoes expansion,
 *      `{expanded: [...]}` if any hook rewrites the prompt,
 *      or `undefined` to allow as-is.
 *
 * This stub NEVER throws. It is safe to await unconditionally.
 */
export async function invokeUserPromptExpansionHook(
  _ctx: UserPromptExpansionHookContext,
): Promise<UserPromptExpansionHookResult> {
  return undefined;
}
