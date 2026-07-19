/**
 * Numeric length anchors section.
 *
 * Mirrors opencc's `systemPromptSection('numeric_length_anchors', ...)`
 * from prompts.ts:547-552. Research showed ~1.2% output-token reduction
 * with quantitative "≤25 words / ≤100 words" anchors vs qualitative
 * "be concise".
 *
 * Gated by `ZAI_NUMERIC_ANCHORS_ENABLED` env var (default: on). The
 * section is small (~30 tokens) and stable, so it's cached.
 */

import { systemPromptSection } from '../section.js'

const NUMERIC_ANCHORS = `Length limits: keep text between tool calls to ≤25 words. Keep final responses to ≤100 words unless the task requires more detail.`

export const getNumericAnchorsSection = systemPromptSection(
  'numeric_length_anchors',
  () => (isNumericAnchorsEnabled() ? NUMERIC_ANCHORS : null),
)

function isNumericAnchorsEnabled(): boolean {
  const v = process.env.ZAI_NUMERIC_ANCHORS_ENABLED
  return v === undefined || v === '' || v === '1' || v.toLowerCase() === 'true'
}