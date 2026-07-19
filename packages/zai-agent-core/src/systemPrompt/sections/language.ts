/**
 * Language preference section.
 *
 * Mirrors opencc's `getLanguageSection` (prompts.ts:157-164). Reads
 * the user's preferred reply language from `~/.zai/settings.json →
 * language` and emits a directive telling the model to always respond
 * in that language (with technical terms left in their original form).
 *
 * Returns null when no preference is set or the file is unreadable
 * — the section is then skipped.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { systemPromptSection } from '../section.js'

function readLanguagePreference(): string | null {
  try {
    const path = join(homedir(), '.zai', 'settings.json')
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { language?: unknown }
    return typeof raw.language === 'string' && raw.language.length > 0
      ? raw.language
      : null
  } catch {
    return null
  }
}

export const getLanguageSection = systemPromptSection(
  'language',
  () => {
    const lang = readLanguagePreference()
    if (!lang) return null
    return `# Language\nAlways respond in ${lang}. Use ${lang} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.`
  },
)