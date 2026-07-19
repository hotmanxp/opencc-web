/**
 * Summarize tool results section.
 *
 * Mirrors opencc's `SUMMARIZE_TOOL_RESULTS_SECTION` (prompts.ts:868).
 * Reminds the model to write down important information from tool
 * results before they get cleared from context.
 *
 * Always emitted when FRC is on; the FRC section explains *when* a
 * result gets cleared, this section explains *what to do* about it.
 *
 * Cached unconditionally (cheap, stable, no per-model variants).
 */

import { systemPromptSection } from '../section.js'

const SUMMARIZE_TOOL_RESULTS_SECTION = `When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.`

export const getSummarizeToolResultsSection = systemPromptSection(
  'summarize_tool_results',
  () => SUMMARIZE_TOOL_RESULTS_SECTION,
)