/**
 * Function Result Clearing (FRC) section.
 *
 * Mirrors opencc's `getFunctionResultClearingSection` (prompts.ts:843-866).
 * Tells the model that old tool results will be cleared from context
 * to free space, with the most recent N results always preserved.
 *
 * Opencc pulls the config from `getCachedMCConfig()` (Bun-only,
 * build-time generated). For zai we read from `~/.zai/settings.json →
 * frc` so runtime config is honored without needing a build step.
 *
 * Section is null when:
 *   - frc.enabled is false
 *   - keepRecent is not a positive integer
 *   - the model is not in the supported list
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { systemPromptSection } from '../section.js'

type FRCConfig = {
  enabled: boolean
  keepRecent: number
  supportedModels: string[]
  systemPromptSuggestSummaries: boolean
}

function readFRCConfig(): FRCConfig | null {
  try {
    const path = join(homedir(), '.zai', 'settings.json')
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { frc?: unknown }
    if (!raw.frc || typeof raw.frc !== 'object') return null
    const cfg = raw.frc as Partial<FRCConfig>
    if (typeof cfg.enabled !== 'boolean') return null
    if (typeof cfg.keepRecent !== 'number' || cfg.keepRecent <= 0) return null
    return {
      enabled: cfg.enabled,
      keepRecent: cfg.keepRecent,
      supportedModels: Array.isArray(cfg.supportedModels)
        ? cfg.supportedModels.filter((s): s is string => typeof s === 'string')
        : [],
      systemPromptSuggestSummaries: cfg.systemPromptSuggestSummaries !== false,
    }
  } catch {
    return null
  }
}

function modelSupported(cfg: FRCConfig, model: string): boolean {
  if (cfg.supportedModels.length === 0) return true
  return cfg.supportedModels.some(p => model.includes(p))
}

export function getFRCSection(model: string) {
  return systemPromptSection(`frc:${model}`, () => {
    const cfg = readFRCConfig()
    if (!cfg) return null
    if (!cfg.enabled || !cfg.systemPromptSuggestSummaries) return null
    if (!modelSupported(cfg, model)) return null
    return `# Function Result Clearing\n\nOld tool results will be automatically cleared from context to free up space. The ${cfg.keepRecent} most recent results are always kept.`
  })
}