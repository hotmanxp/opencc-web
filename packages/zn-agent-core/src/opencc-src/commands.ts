// @ts-nocheck
/**
 * Stub for opencc's `src/commands.ts` — Phase 1 placeholder.
 *
 * opencc 0.20.0 has a single `src/commands.ts` (resolved via the
 * `"src/*": ["./src/opencc-src/*"]` path mapping in tsconfig). The original
 * file is large (~3K lines) and contains the full slash-command registry,
 * prompt rendering, argument parsing, and `getSkillToolCommands` /
 * `getMcpSkillCommands` lookups used by SkillTool and the entrypoint
 * (utils/handlePromptSubmit.ts).
 *
 * This stub exists so Phase 1 build can pass while we wire up the rest of
 * the adapter. Real implementation will be ported over from opencc once
 * the runtime is verified working under Bun.
 *
 * Until then, the most commonly called accessors return empty arrays /
 * `undefined` so callers that read commands at startup (e.g. for prompt
 * rendering) get a benign empty registry rather than a thrown error.
 */

export const builtInCommandNames: string[] = []

export type CommandBase = {
  name: string
  description?: string
  isEnabled?: boolean
}

export type Command = CommandBase & {
  type: 'prompt' | 'local' | 'local-jsx'
  source?: string
}

export type PromptCommand = Command & {
  type: 'prompt'
  argumentNames?: string[] | string
  progressMessage?: string
  getPromptForCommand(args: string): string
}

export function findCommand(_name: string): Command | undefined {
  return undefined
}

export function getCommand(_name: string): Command | undefined {
  return undefined
}

export function getCommandName(_cmd: Command): string {
  return ''
}

export function hasCommand(_name: string): boolean {
  return false
}

export function isCommandEnabled(_cmd: Command): boolean {
  return true
}

export function getSkillToolCommands(): Command[] {
  return []
}

export function getMcpSkillCommands(): Command[] {
  return []
}
